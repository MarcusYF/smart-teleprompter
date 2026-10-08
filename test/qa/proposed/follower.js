// Follower: turns tracker output into what the prompter shows.
// Owns the displayed position (with hysteresis), speaking pace, pause and
// off-script detection, skipped-phrase marks, and applies semantic
// judgments (from Jev) and slide changes.

import { Tracker } from '../../../public/lib/tracker.js';
import { speechTokens, tokenSim } from '../../../public/lib/lang.js';

export const FOLLOW_DEFAULTS = {
  localForward: 30,      // tokens the display may advance without extra evidence
  farMargin: 1.6,        // score margin needed for a far jump
  backMargin: 1.2,       // score margin needed to move back
  offMin: { zh: 6, en: 4 },
  pauseMs: 1400,
  resumeHits: 1.5,       // decayed match count needed to leave off-script
  latencySec: 0.35,      // recognizer lag compensated by the highlight lead
  lookaheadSec: 2.6,     // look-ahead band length at the current pace
  defaultRate: { zh: 4.2, en: 2.4 }, // tokens per second before we have data
};

export class Follower {
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.lang = doc.lang;
    this.O = { ...FOLLOW_DEFAULTS, ...opts };
    this.tracker = new Tracker(doc, opts.tracker);
    this.listeners = new Set();
    this.reset(0);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(reason) {
    const v = this.view();
    v.reason = reason;
    for (const fn of this.listeners) fn(v);
  }

  reset(pos = 0) {
    this.tracker.reset(pos);
    this.pos = pos;
    this.maxPos = pos;
    this.status = 'idle';
    this.semantic = null;
    this.skipped = new Set();
    this.coveredSents = new Set(); // sentences Jev judged as paraphrased
    this.spokenTok = new Uint8Array(this.doc.tokens.length);
    for (let k = 0; k < pos; k++) this.spokenTok[k] = 1;
    this.recent = [];        // recent committed spoken tokens {n, kind, ..., t, seq}
    this.seq = 0;            // sequence number of the next committed token
    this.moveSeq = -1;       // stream position when the display last moved
    this.progress = [];      // [{t, pos}] for pace
    this.speechTimes = [];   // timestamps of speech activity
    this.lastSpeechAt = 0;
    this.lastMoveAt = 0;
    this.voiceActive = false;
    this.run = 0;
    this.offSince = 0;
    this.lastResult = null;
    this.events = [];
    this.interimText = '';
    this.lastInterimCount = 0;
  }

  // ------------------------------------------------------------- inputs

  // kind: 'interim' | 'final'
  onSpeech(kind, text, now = Date.now()) {
    const res = kind === 'final' ? this.tracker.commit(text) : this.tracker.interim(text);
    // A final that only confirms the words of the last interim is not new
    // speech; it must not wake the display out of a pause.
    const n = res.nTokens ?? 0;
    const confirming = kind === 'final' && n > 0 && n <= (this.lastInterimCount || 0);
    this.lastInterimCount = kind === 'final' ? 0 : n;
    if (!confirming) {
      this.lastSpeechAt = now;
      this.speechTimes.push(now);
      if (this.speechTimes.length > 400) this.speechTimes.splice(0, 200);
    }
    if (kind === 'final') {
      this._pushRecent(text, now);
      this.interimText = '';
    } else {
      this.interimText = text;
    }
    this._applyResult(res, now, confirming);
    this._emit('speech');
    return res;
  }

  // Audio level based voice activity (optional; improves pause detection).
  onVoice(active, now = Date.now()) {
    if (active) this.lastVoiceAt = now;
    if (active !== this.voiceActive) {
      this.voiceActive = active;
    }
  }

  // Periodic update (pause detection). Returns true if the view changed.
  tick(now = Date.now()) {
    const quiet = now - this.lastSpeechAt > this.O.pauseMs && !(this.voiceActive && now - (this.lastVoiceAt || 0) < 400);
    if (this.status !== 'idle' && quiet && this.status !== 'paused') {
      this.status = 'paused';
      this._emit('pause');
      return true;
    }
    return false;
  }

  _pushRecent(text, now) {
    for (const t of speechTokens(text, this.lang)) this.recent.push({ ...t, t: now, seq: this.seq++ });
    if (this.recent.length > 160) this.recent.splice(0, this.recent.length - 160);
  }

  // Committed + interim spoken tokens, each with a stream sequence number.
  _stream() {
    const out = this.recent.slice();
    speechTokens(this.interimText, this.lang).forEach((t, i) => out.push({ ...t, seq: this.seq + i }));
    return out;
  }

  // Spoken tokens for context: committed recent + current interim.
  recentSpeech(maxTokens = 40) {
    const toks = [...this.recent.map((t) => t.n), ...speechTokens(this.interimText, this.lang).map((t) => t.n)];
    const sep = this.lang === 'zh' ? '' : ' ';
    return toks.slice(-maxTokens).join(sep);
  }

  // What was said since the speaker left the script, with a minimum window
  // so a judgment never sees only a fragment (paraphrases re-match a few
  // words and reset the run).
  offScriptSpeech() {
    return this.offScriptParts().text;
  }

  // The same window split into `lead` (the padding: script words read just
  // before leaving the script) and `speech` (the words said since).
  offScriptParts() {
    const toks = [...this.recent.map((t) => t.n), ...speechTokens(this.interimText, this.lang).map((t) => t.n)];
    const sep = this.lang === 'zh' ? '' : ' ';
    const minWin = this.lang === 'zh' ? 14 : 9;
    const n = Math.min(toks.length, 48, Math.max(this.run, minWin));
    const win = toks.slice(toks.length - n);
    const k = Math.min(Math.max(this.run, 0), n);
    return { text: win.join(sep), lead: win.slice(0, n - k).join(sep), speech: win.slice(n - k).join(sep) };
  }

  _applyResult(res, now, confirming = false) {
    this.lastResult = res;
    const O = this.O;
    const d = this.pos;
    let moved = false;
    // Coming back from off-script speech needs two recent matches, so a
    // single coincidental word does not move the highlight.
    const settled = this.status !== 'offscript' || res.hits >= O.resumeHits;
    if (res.pos > d && res.run <= 2 && settled) {
      const dist = res.pos - d;
      if (dist <= O.localForward || res.margin >= O.farMargin) {
        this._moveTo(res.pos, now, dist > O.localForward ? 'jump' : 'advance');
        moved = true;
      }
    } else if (res.pos < d && settled) {
      const dist = d - res.pos;
      if (dist >= 2 && res.margin >= O.backMargin && res.run === 0) {
        this._moveTo(res.pos, now, 'back');
        moved = true;
      }
    }
    this.run = res.run;
    const offMin = O.offMin[this.lang] || 5;
    if (res.run >= offMin && !moved) {
      if (this.status !== 'offscript') {
        this.status = 'offscript';
        this.offSince = now;
      }
    } else {
      // Back on the script (a word matched): the off-script episode is over.
      if (res.run === 0 && this.semantic) {
        this.lastSemantic = this.semantic;
        this.semantic = null;
      }
      if (!(confirming && this.status === 'paused' && !moved)) this.status = 'tracking';
    }
  }

  _moveTo(pos, now, how) {
    const from = this.pos;
    if (how === 'advance' || how === 'jump') this._markSkips(from, pos);
    if (pos < from) {
      // going back: phrases re-entered are no longer "skipped"
      for (const ph of [...this.skipped]) {
        const p = this.doc.phrases[ph];
        if (p && p.tokEnd > pos) this.skipped.delete(ph);
      }
    }
    this.pos = pos;
    if (pos > this.maxPos) this.maxPos = pos;
    this.lastMoveAt = now;
    this.moveSeq = this.seq + speechTokens(this.interimText, this.lang).length - 1;
    this.progress.push({ t: now, pos });
    if (this.progress.length > 300) this.progress.splice(0, 150);
    this.events.push({ t: now, how, from, to: pos });
    if (this.events.length > 100) this.events.shift();
  }

  // Phrases passed over without being spoken are marked as skipped. Script
  // tokens covered by recent speech are remembered in spokenTok, so a
  // phrase skipped across two display moves is still recognized.
  _markSkips(from, to) {
    const span = to - from;
    if (span <= 0) return;
    const doc = this.doc;
    const flags = this.spokenTok;
    if (span <= 3) {
      for (let k = from; k < to; k++) flags[k] = 1;
    } else {
      const script = doc.tokens.slice(from, to);
      // Only words spoken since the display reached `from` can cover [from, to).
      const since = this.moveSeq;
      let spoken = this._stream().filter((t) => t.seq > since);
      if (!spoken.length) spoken = this._stream().slice(-Math.min(span, 8));
      spoken = spoken.slice(-(span + 20));
      const n = script.length;
      const m = spoken.length;
      if (m) {
        // a script token counts as spoken on a clear match, or a looser
        // match of a content word; stray function words do not count
        const sim = (i, j) => {
          const v = tokenSim(spoken[j], doc.vocab[script[i].vid]);
          return v >= 0.8 || (v >= 0.5 && !script[i].stop);
        };
        const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = 1; i <= n; i++) {
          for (let j = 1; j <= m; j++) {
            dp[i][j] = sim(i - 1, j - 1) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
          }
        }
        let i = n;
        let j = m;
        while (i > 0 && j > 0) {
          if (sim(i - 1, j - 1) && dp[i][j] === dp[i - 1][j - 1] + 1) {
            flags[from + i - 1] = 1;
            i--;
            j--;
          } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
          else j--;
        }
      }
    }
    const firstPh = doc.tokens[from] ? doc.tokens[from].phrase : 0;
    const lastPh = doc.tokens[to - 1] ? doc.tokens[to - 1].phrase : firstPh;
    for (let ph = firstPh; ph <= lastPh; ph++) {
      const p = doc.phrases[ph];
      if (p.tokEnd > to || p.tokEnd - p.tokStart < 2) continue; // not finished yet
      if (this.coveredSents.has(p.sent)) continue; // said in other words
      // informativeness-weighted coverage of the phrase
      let hit = 0;
      let all = 0;
      for (let k = p.tokStart; k < p.tokEnd; k++) {
        const w = doc.tokens[k].w;
        all += w;
        if (flags[k]) hit += w;
      }
      if (hit / all < 0.34) this.skipped.add(ph);
    }
  }

  // ------------------------------------------------------------- control

  // Manual jump (click on a phrase, keyboard nudges).
  jumpTo(tok, now = Date.now()) {
    const pos = Math.max(0, Math.min(this.doc.tokens.length, tok));
    this.tracker.setPosition(pos);
    for (const ph of [...this.skipped]) {
      const p = this.doc.phrases[ph];
      if (p && p.tokStart >= pos) this.skipped.delete(ph);
    }
    this.pos = pos;
    this.lastMoveAt = now;
    this.semantic = null;
    this.status = this.status === 'idle' ? 'idle' : 'tracking';
    this._emit('manual');
  }

  // A slide change: bring the slide's section into play.
  slideChanged(tokStart, tokEnd, now = Date.now()) {
    if (this.pos >= tokStart && this.pos < tokEnd) return false;
    this.tracker.setPosition(tokStart);
    if (tokStart > this.pos) this._markSkips(this.pos, tokStart);
    this.pos = tokStart;
    this.lastMoveAt = now;
    this.semantic = null;
    this.events.push({ t: now, how: 'slide', to: tokStart });
    this._emit('slide');
    return true;
  }

  // Semantic judgment from the server (Jev). j = {relation, where, onScript,
  // covered, requestPos, requestRun}. Returns the action taken.
  applySemantic(j, now = Date.now()) {
    const doc = this.doc;
    // Freshness: if we are back on script, or moved since, the judgment is stale.
    if (this.run === 0 || Math.abs(this.pos - j.requestPos) > 3) return 'stale';
    const rel = j.relation || {};
    const label = rel.choice;
    this.semantic = { label, conf: rel.confidence ?? 0, at: now, where: j.where?.choice };
    if (label === 'paraphrase') this.coveredSents.add(doc.phrases[this.currentPhrase(now)].sent);
    let action = 'hold';
    const whereIdx = j.where && /^P\d+$/.test(j.where.choice || '') ? parseInt(j.where.choice.slice(1), 10) : -1;
    const whereP = j.where && j.where.probabilities ? j.where.probabilities[j.where.choice] || 0 : 0;
    const curPh = this.currentPhrase();
    // Paraphrasing or noisy reading of the sentence we are in: stay put
    // rather than stepping back to the sentence start.
    const backInSentence = whereIdx >= 0 && whereIdx < curPh && doc.phrases[whereIdx] &&
      doc.phrases[whereIdx].sent === doc.phrases[curPh].sent && (label === 'paraphrase' || label === 'reading_current');
    // Guards against the wrong moves seen in QA: the label and the line must
    // agree on the direction; the phrase just before the current one is what
    // the speaker had just read (its words open the off-script window), so
    // returning there is left to the lexical tracker; and a jump needs a
    // reasonably certain relation (a slip that contains words from elsewhere
    // in the script starts out at p ~0.3-0.6).
    const relP = rel.probabilities ? rel.probabilities[label] ?? 0 : 0;
    const wrongWay = whereIdx >= 0 && ((label === 'went_back' && whereIdx > curPh) || (label === 'jumped_ahead' && whereIdx < curPh));
    const justRead = whereIdx >= 0 && whereIdx === curPh - 1;
    if ((label === 'jumped_ahead' || label === 'went_back' || label === 'paraphrase' || label === 'reading_current') &&
        whereIdx >= 0 && whereP >= 0.4 && (j.onScript ?? 1) >= 0.5 && whereIdx !== curPh && !backInSentence &&
        !wrongWay && !justRead && relP >= 0.6) {
      const ph = doc.phrases[whereIdx];
      if (ph) {
        // Re-anchor at the phrase; let the lexical tracker refine inside it.
        this.tracker.setPosition(ph.tokStart);
        this.tracker.boost(ph.tokStart, ph.tokEnd, 2.5);
        if (ph.tokStart > this.pos) this._markSkips(this.pos, ph.tokStart);
        const from = this.pos;
        this.pos = ph.tokStart;
        this.lastMoveAt = now;
        this.events.push({ t: now, how: 'semantic', from, to: ph.tokStart, label });
        action = whereIdx > curPh ? 'jump-forward' : 'jump-back';
      }
    } else if (label === 'paraphrase' && (j.covered ?? 0) >= 0.6) {
      const sent = doc.sents[doc.phrases[curPh].sent];
      this.coveredSents.add(sent.idx);
      const next = doc.sents[sent.idx + 1];
      if (next) {
        this.tracker.setPosition(next.tokStart);
        const from = this.pos;
        this.pos = next.tokStart;
        this.lastMoveAt = now;
        this.events.push({ t: now, how: 'semantic', from, to: next.tokStart, label });
        action = 'advance-sentence';
      }
    }
    this.semantic.action = action;
    this._emit('semantic');
    return action;
  }

  // ------------------------------------------------------------- outputs

  rate(now = Date.now()) {
    // tokens per second over the last ~10s of active speech
    const win = 10000;
    const pts = this.progress.filter((p) => now - p.t <= win);
    const def = this.O.defaultRate[this.lang] || 3;
    if (pts.length < 2) return def;
    const times = this.speechTimes.filter((t) => now - t <= win);
    let active = 0;
    for (let i = 1; i < times.length; i++) active += Math.min(times[i] - times[i - 1], 1200);
    const dpos = pts[pts.length - 1].pos - pts[0].pos;
    if (active < 1500 || dpos <= 0) return def;
    const r = dpos / (active / 1000);
    return Math.max(def * 0.35, Math.min(def * 2.5, r));
  }

  currentPhrase(now = Date.now()) {
    const doc = this.doc;
    if (!doc.tokens.length) return 0;
    let hp = this.pos;
    if (this.status === 'tracking' && now - this.lastSpeechAt < 800) {
      hp += Math.round(this.rate(now) * this.O.latencySec);
    }
    hp = Math.min(hp, doc.tokens.length - 1);
    if (hp < 0) hp = 0;
    // If the current phrase is fully read, the next phrase is current.
    return doc.tokens[hp].phrase;
  }

  view(now = Date.now()) {
    const doc = this.doc;
    const cur = this.currentPhrase(now);
    const rate = this.rate(now);
    const aheadTok = Math.min(doc.tokens.length, (doc.phrases[cur]?.tokEnd ?? 0) + Math.round(rate * this.O.lookaheadSec));
    let aheadPh = aheadTok >= doc.tokens.length ? doc.phrases.length - 1 : doc.tokens[Math.max(0, aheadTok - 1)]?.phrase ?? cur;
    if (aheadPh < cur) aheadPh = cur;
    return {
      pos: this.pos,
      phrase: cur,
      aheadPhrase: aheadPh,
      status: this.status,
      semantic: this.semantic,
      run: this.run,
      rate,
      skipped: this.skipped,
      maxPos: this.maxPos,
      progress: doc.tokens.length ? this.pos / doc.tokens.length : 0,
      margin: this.lastResult ? this.lastResult.margin : 0,
    };
  }
}
