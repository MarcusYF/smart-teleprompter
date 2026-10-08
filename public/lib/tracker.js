// Online script follower.
//
// Keeps a score for every script position j (= number of script tokens
// already spoken) and updates all of them for each recognized word, like a
// streaming local alignment / score-following HMM:
//   stay      the word is not in the script (ad-lib, filler, recognizer noise)
//   advance   the word consumes the next script token, possibly after
//             skipping a few (omissions cost a little per skipped token)
//   back      re-reading from a little earlier (restart after a slip)
//   jump      re-locating anywhere (skipping ahead / going back far)
// Interim recognizer hypotheses are scored on top of the committed state
// with a prefix cache, so frequent partial updates stay cheap.

import { speechTokens, tokenSim } from './lang.js';

export const TRACKER_DEFAULTS = {
  SIM_MIN: 0.5,
  INS: 0.55,
  INS_FILLER: 0.08,
  SUB: 0.8,
  DEL_BASE: 0.12,
  DEL_W: 0.33,
  BACK0: 2.2,
  BACKK: 0.06,
  JUMP: 7.0,
  STRONG_SIM: 0.8,
  WEAK_OFF: 0.25,
  FLOOR: 12,
  HIT_DECAY: 0.7,
  MARGIN_WINDOW: 8,
};

const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'mm', 'ah', 'eh', 'uhm', '嗯', '呃', '额', '啊', '哦', '噢', '唔']);

export class Tracker {
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.lang = doc.lang;
    this.P = { ...TRACKER_DEFAULTS, ...opts };
    const N = (this.N = doc.tokens.length);
    this.vid = new Int32Array(N);
    this.w = new Float32Array(N);
    this.del = new Float32Array(N);
    this.stop = new Uint8Array(N);
    doc.tokens.forEach((t, i) => {
      this.vid[i] = t.vid;
      this.w[i] = t.w;
      this.del[i] = this.P.DEL_BASE + this.P.DEL_W * t.w;
      this.stop[i] = t.stop ? 1 : 0;
    });
    this.simCache = new Map();
    this.pool = [];
    this.bufB = new Float32Array(N + 1);
    this.bufBR = new Uint16Array(N + 1);
    this.bufBH = new Float32Array(N + 1);
    this.reset(0);
  }

  // ------------------------------------------------------------- state mgmt

  _alloc() {
    const N1 = this.N + 1;
    // QA proto (T2): K = length of the current streak of consecutive in-order matches
    return this.pool.pop() || { S: new Float32Array(N1), R: new Uint16Array(N1), H: new Float32Array(N1), K: new Uint8Array(N1), arg: 0 };
  }

  _release(st) {
    if (st && st !== this.committed && this.pool.length < 256) this.pool.push(st);
  }

  _clearInterim() {
    for (const st of this.stack) this._release(st);
    this.stack = [];
    this.stackToks = [];
  }

  reset(pos = 0) {
    this.stack = this.stack || [];
    this._clearInterim();
    const st = this._alloc();
    st.S.fill(-this.P.JUMP);
    st.R.fill(0);
    st.H.fill(0);
    st.K.fill(0);
    const p = Math.max(0, Math.min(this.N, pos));
    st.S[p] = 0;
    st.arg = p;
    this.committed = st;
    this.last = this._result(st, null);
    return this.last;
  }

  // Make positions in [a, b] strong candidates, e.g. after a slide change or
  // a semantic re-localization. amount is in score units (a matched word ~ 1).
  boost(a, b, amount) {
    this._clearInterim();
    const st = this.committed;
    const lo = Math.max(0, a);
    const hi = Math.min(this.N, b);
    let best = -Infinity;
    for (let j = 0; j <= this.N; j++) {
      if (j >= lo && j <= hi) st.S[j] += amount - 0.02 * (j - lo);
      if (st.S[j] > best) {
        best = st.S[j];
        st.arg = j;
      }
    }
    this._normalize(st, best);
    this.last = this._result(st, null);
    return this.last;
  }

  // Hard re-anchor: the speaker is (or will be) at pos. Earlier state is kept
  // faintly so a quick return is still possible.
  setPosition(pos) {
    this._clearInterim();
    const st = this.committed;
    const p = Math.max(0, Math.min(this.N, pos));
    for (let j = 0; j <= this.N; j++) st.S[j] = Math.max(-this.P.FLOOR, st.S[j] - this.P.JUMP * 0.6);
    st.S[p] = 0;
    st.R[p] = 0;
    st.K[p] = 0;
    st.arg = p;
    this.last = this._result(st, null);
    return this.last;
  }

  // ------------------------------------------------------------- matching

  _sims(x) {
    let arr = this.simCache.get(x.n);
    if (arr) return arr;
    const V = this.doc.vocab;
    arr = new Float32Array(V.length);
    for (let v = 0; v < V.length; v++) arr[v] = tokenSim(x, V[v]);
    if (this.simCache.size > 4000) this.simCache.clear();
    this.simCache.set(x.n, arr);
    return arr;
  }

  _step(prev, x) {
    const P = this.P;
    const N = this.N;
    const { S, R, H, K } = prev;
    const out = this._alloc();
    const nS = out.S;
    const nR = out.R;
    const nH = out.H;
    const nK = out.K;
    const sims = this._sims(x);
    const filler = FILLERS.has(x.n);
    const ins = filler ? P.INS_FILLER : P.INS;
    const decay = P.HIT_DECAY;
    const vid = this.vid;
    const w = this.w;
    const del = this.del;
    const stop = this.stop;

    // Backward sources: B[i] = max_{k>i} S[k] - BACK0 - (k-i)*BACKK
    const B = this.bufB;
    const BR = this.bufBR;
    const BH = this.bufBH;
    B[N] = -1e9;
    for (let i = N - 1; i >= 0; i--) {
      const cand = S[i + 1] - P.BACK0 - P.BACKK;
      const carry = B[i + 1] - P.BACKK;
      if (cand >= carry) {
        B[i] = cand;
        BR[i] = R[i + 1];
        BH[i] = H[i + 1];
      } else {
        B[i] = carry;
        BR[i] = BR[i + 1];
        BH[i] = BH[i + 1];
      }
    }

    const g = prev.arg;
    const jump = S[g] - P.JUMP;
    const jH = H[g];

    nS[0] = S[0] - ins;
    nR[0] = filler ? R[0] : Math.min(65535, R[0] + 1);
    nH[0] = H[0] * decay;
    nK[0] = filler ? K[0] : 0;
    let best = nS[0];
    let bestArg = 0;

    // Skip source Q = max_{i<=j-2} S[i] - sum(del[i..j-2]) for consuming j-1.
    let Q = -1e9;
    let QH = 0;
    for (let j = 1; j <= N; j++) {
      const t = j - 1;
      const sim = sims[vid[t]];
      const stay = S[j] - ins;
      let cons = -1e9;
      let cR = 0;
      let cH = 0;
      let cK = 0;
      if (sim >= P.SIM_MIN) {
        const r = w[t] * (0.35 + 0.65 * sim);
        // A strong match is an informative token that clearly matches; only
        // strong matches may re-anchor (after a skip, a jump, or off-script
        // speech). Weak matches (function words, loose spellings) only extend
        // a run of matches that is already in progress.
        const strong = sim >= P.STRONG_SIM && !stop[t];
        const runPrev = R[t];
        if (runPrev === 0 || strong) {
          cons = S[t] + r;
          cR = 0;
          cH = H[t] * decay + 1;
          cK = K[t] < 255 ? K[t] + 1 : 255;
        } else {
          cons = S[t] + r * P.WEAK_OFF;
          cR = runPrev;
          cH = H[t] * decay + 0.3;
          cK = 0;
        }
        if (strong) {
          if (Q + r > cons) {
            cons = Q + r;
            cR = 0;
            cH = QH * decay + 1;
            cK = 1;
          }
          if (B[t] + r > cons) {
            cons = B[t] + r;
            cR = 0;
            cH = BH[t] * decay + 1;
            cK = 1;
          }
          if (jump + r > cons) {
            cons = jump + r;
            cR = 0;
            cH = jH * decay + 1;
            cK = 1;
          }
        }
      } else {
        cons = S[t] - P.SUB;
        cR = R[t] + 1;
        cH = H[t] * decay;
      }
      if (stay >= cons) {
        nS[j] = stay;
        nR[j] = filler ? R[j] : Math.min(65535, R[j] + 1);
        nH[j] = H[j] * decay;
        nK[j] = filler ? K[j] : 0;
      } else {
        nS[j] = cons;
        nR[j] = Math.min(65535, cR);
        nH[j] = cH;
        nK[j] = cK;
      }
      if (nS[j] > best) {
        best = nS[j];
        bestArg = j;
      }
      // Q for the next token: skipping token t is allowed from S[t] or Q.
      if (S[t] >= Q) {
        Q = S[t] - del[t];
        QH = H[t];
      } else {
        Q -= del[t];
      }
    }
    out.arg = bestArg;
    this._normalize(out, best);
    return out;
  }

  _normalize(st, best) {
    const floor = -this.P.FLOOR;
    const S = st.S;
    for (let j = 0; j <= this.N; j++) {
      const v = S[j] - best;
      S[j] = v < floor ? floor : v;
    }
  }

  _result(st, lastTok) {
    const S = st.S;
    const a = st.arg;
    const W = this.P.MARGIN_WINDOW;
    let second = -this.P.FLOOR;
    for (let j = 0; j <= this.N; j++) {
      if ((j < a - W || j > a + W) && S[j] > second) second = S[j];
    }
    return {
      pos: a,
      margin: S[a] - second,
      run: st.R[a],
      hits: st.H[a],
      streak: st.K[a],
      lastTok,
    };
  }

  _tokens(text) {
    return speechTokens(text || '', this.lang);
  }

  _advance(base, fromIdx, toks, stack) {
    let st = base;
    for (let i = fromIdx; i < toks.length; i++) {
      st = this._step(st, toks[i]);
      stack.push(st);
    }
    return st;
  }

  _commonPrefix(toks) {
    const old = this.stackToks;
    let L = 0;
    while (L < toks.length && L < old.length && toks[L].n === old[L].n) L++;
    return L;
  }

  // Provisional hypothesis for the utterance in progress.
  interim(text) {
    const toks = this._tokens(text);
    const L = this._commonPrefix(toks);
    while (this.stack.length > L) this._release(this.stack.pop());
    this.stackToks = this.stackToks.slice(0, L);
    const base = L ? this.stack[L - 1] : this.committed;
    const st = this._advance(base, L, toks, this.stack);
    this.stackToks = toks;
    this.last = this._result(st, toks[toks.length - 1] || null);
    this.last.interim = true;
    this.last.nTokens = toks.length;
    return this.last;
  }

  // Final text for the utterance: fold into the committed state.
  commit(text) {
    const toks = this._tokens(text);
    const L = this._commonPrefix(toks);
    while (this.stack.length > L) this._release(this.stack.pop());
    const base = L ? this.stack[L - 1] : this.committed;
    const scratch = [];
    const st = this._advance(base, L, toks, scratch);
    // keep only the final state; everything else returns to the pool
    const keep = st;
    const old = this.committed;
    for (const s of this.stack) if (s !== keep) this._release(s);
    for (const s of scratch) if (s !== keep) this._release(s);
    this.stack = [];
    this.stackToks = [];
    this.committed = keep;
    if (old !== keep) this._release(old);
    this.last = this._result(keep, toks[toks.length - 1] || null);
    this.last.nTokens = toks.length;
    return this.last;
  }

  get position() {
    return this.last ? this.last.pos : 0;
  }
}
