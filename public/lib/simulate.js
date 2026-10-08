// Speech-recognizer simulator. Turns a "performance" (what the speaker
// does: read phrases, ad-lib, pause, skip...) into a timeline of interim /
// final recognizer events like a streaming engine produces, with optional
// recognition errors. Used by the demo mode and the automated tests.

import { PINYIN_FIRST, PINYIN_TABLE } from './pinyin-table.js';
import { speechTokens } from './lang.js';

// Small deterministic PRNG so tests are reproducible.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

let homophones = null;
let PY = null;
function homophoneOf(ch, rand) {
  if (!homophones) {
    homophones = new Map();
    const arr = (PY = PINYIN_TABLE.split(' '));
    // only common-ish range to keep substitutions realistic
    for (let i = 0; i < arr.length; i++) {
      const py = arr[i];
      if (!py) continue;
      if (!homophones.has(py)) homophones.set(py, []);
      const list = homophones.get(py);
      if (list.length < 12) list.push(String.fromCodePoint(PINYIN_FIRST + i));
    }
  }
  const cp = ch.codePointAt(0) - PINYIN_FIRST;
  const py = PY[cp];
  const list = py && homophones.get(py);
  if (!list || list.length < 2) return ch;
  let c = ch;
  for (let k = 0; k < 4 && c === ch; k++) c = list[Math.floor(rand() * list.length)];
  return c;
}

const EN_CONFUSE = {
  their: 'there', there: 'their', to: 'two', too: 'to', for: 'four', right: 'write', new: 'knew',
  model: 'modal', models: 'modals', reward: 'rewards', prefer: 'prefers', score: 'store', human: 'humans',
  loop: 'loupe', data: 'date', signal: 'single', feedback: 'feed back', noise: 'noisy', learning: 'learn',
};
const EN_RANDOM = ['the', 'and', 'uh', 'so', 'like', 'that', 'thing', 'well'];

function corruptWord(w, lang, rand) {
  if (lang === 'zh') return homophoneOf(w, rand);
  const lw = w.toLowerCase();
  if (EN_CONFUSE[lw]) return EN_CONFUSE[lw];
  if (rand() < 0.5) return EN_RANDOM[Math.floor(rand() * EN_RANDOM.length)];
  return w.length > 4 ? w.slice(0, -1) : w + 's';
}

// Units the recognizer emits: words (en) or characters (zh).
// QA proto (F8): in Chinese, Latin words and numbers stay whole units
// ("PPO", "3.5", "20%"), instead of one unit per letter/digit.
function units(text, lang) {
  if (lang === 'zh') {
    return text.match(/[㐀-鿿豈-﫿]|\d+(?:[.,]\d+)*%?|[A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*/gu) || [];
  }
  return text.split(/\s+/).map((w) => w.replace(/[^\w'’%-]/g, '')).filter(Boolean);
}

// QA proto (F8): recognizers print a space between consecutive Latin words
// / numbers in Chinese ("reward model"), never between Han characters.
const isHan = (u) => /^[㐀-鿿豈-﫿]$/u.test(u);
function joinUnits(us, lang) {
  if (lang !== 'zh') return us.join(' ');
  let out = '';
  us.forEach((u, i) => {
    if (i && !isHan(u) && !isHan(us[i - 1])) out += ' ';
    out += u;
  });
  return out;
}

// performance: [{read:[a,b]} | {say:'text'} | {pause:ms} | {text:'...'}]
// opts: {rate (units/sec), errRate, revRate, seed, finalEvery:[min,max]}
export function simulate(doc, performance, opts = {}) {
  const lang = doc.lang;
  const rand = rng(opts.seed || 7);
  const rate = opts.rate || (lang === 'zh' ? 4.2 : 2.5);
  const errRate = opts.errRate ?? 0.03;
  const revRate = opts.revRate ?? 0.15;
  const [fmin, fmax] = opts.finalEvery || (lang === 'zh' ? [10, 24] : [7, 16]);
  const events = [];
  const truth = []; // {t, pos, mode}
  let t = opts.start || 0;
  let utter = []; // recognized units in current utterance
  let limit = fmin + Math.floor(rand() * (fmax - fmin + 1));
  const sep = lang === 'zh' ? '' : ' ';

  const flush = () => {
    if (!utter.length) return;
    events.push({ t: t + 240, kind: 'final', text: joinUnits(utter, lang) }); // after the last interim (t + 180)
    utter = [];
    limit = fmin + Math.floor(rand() * (fmax - fmin + 1));
  };

  const speak = (unitsList, posFn, mode) => {
    unitsList.forEach((u, k) => {
      const dt = (1000 / rate) * (0.75 + rand() * 0.5);
      t += dt;
      const recognized = rand() < errRate ? corruptWord(u, lang, rand) : u;
      utter.push(recognized);
      // interim, sometimes with a wrong guess on the last unit
      const shown = utter.slice();
      if (rand() < revRate) shown[shown.length - 1] = corruptWord(u, lang, rand);
      events.push({ t: t + 180, kind: 'interim', text: joinUnits(shown, lang) });
      truth.push({ t, pos: posFn(k), mode });
      if (utter.length >= limit) flush();
    });
  };

  for (const seg of performance) {
    if (seg.pause) {
      flush();
      t += seg.pause;
      continue;
    }
    if (seg.read) {
      const [a, b] = seg.read;
      const ph0 = doc.phrases[a];
      const ph1 = doc.phrases[Math.min(b, doc.phrases.length - 1)];
      // Speak script tokens a..b; truth position = index after each token.
      const toks = doc.tokens.slice(ph0.tokStart, ph1.tokEnd);
      const words = [];
      const pos = [];
      if (lang === 'zh') {
        // QA proto (F8): one unit per display piece (a Han character, a
        // Latin word or a number as written), truth at the piece's end
        for (let p = a; p <= b; p++) {
          for (const pc of doc.phrases[p].pieces) {
            if (pc.tok === undefined) continue;
            words.push(pc.t);
            pos.push(pc.tokEnd);
          }
        }
      } else {
        // speak display words (numbers stay digits like a recognizer would)
        for (let p = a; p <= b; p++) {
          const ph = doc.phrases[p];
          for (const pc of ph.pieces) {
            if (pc.tok === undefined) continue;
            words.push(pc.t);
            pos.push(pc.tokEnd);
          }
        }
      }
      speak(words, (k) => pos[k], 'read');
      continue;
    }
    if (seg.say || seg.text) {
      const words = units(seg.say || seg.text, lang);
      const hold = truth.length ? truth[truth.length - 1].pos : 0;
      const truthPos = seg.truth ?? hold;
      speak(words, () => truthPos, seg.say ? 'adlib' : 'text');
      if (seg.endUtterance !== false) flush();
      continue;
    }
  }
  flush();
  events.sort((x, y) => x.t - y.t);
  return { events, truth, duration: t + 500 };
}

// Replays events through a follower with virtual time; returns a trace.
export function replay(follower, sim, opts = {}) {
  const trace = [];
  const tickMs = opts.tickMs || 100;
  let e = 0;
  for (let t = 0; t <= sim.duration; t += tickMs) {
    while (e < sim.events.length && sim.events[e].t <= t) {
      const ev = sim.events[e++];
      follower.onSpeech(ev.kind, ev.text, ev.t);
      if (opts.onEvent) opts.onEvent(ev, follower);
    }
    follower.tick(t);
    const v = follower.view(t);
    trace.push({ t, pos: v.pos, phrase: v.phrase, status: v.status });
  }
  return trace;
}

// Truth position at time t (last spoken truth point at or before t).
export function truthAt(sim, t) {
  let lo = 0;
  let hi = sim.truth.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sim.truth[mid].t <= t) {
      ans = sim.truth[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function tokensOf(text, lang) {
  return speechTokens(text, lang);
}
