// Places [click] markers in a slide's notes from the deck's builds.
//
// Imported Keynote notes rarely mark where each build belongs, so the show's
// animations could not follow the speech: every build waited for the end of
// the slide's text and then flashed by. Given what each click reveals (read
// from the .key file), each click goes before the sentence that first talks
// about what it shows: a monotone alignment by shared content words (en) or
// character pairs (zh), weighted by how distinctive they are on this slide.
// Clicks whose content is not in the notes (pictures, formulas) fall between
// their neighbours, evenly spaced. A click never goes after the last
// sentence: the end of a slide's text is its turn.
//
// Pure logic, shared by the server (import) and the tests.

import { detectLang, speechTokens, isStopToken } from './lang.js';

const SKIP_LINE = /^\s*(\/\/|>>|#{1,6}\s)/;
const MATH = /\$\$[\s\S]+?\$\$|\$(?=\S)(?:\\.|[^$\\\n])+?(?<=\S)\$(?!\d)/g;

// Spans [start, end) of the spoken sentences (or clauses) in text.
function units(text, lang, clauses = false) {
  // keep formulas whole: their dots and commas do not end anything
  const masked = text.replace(MATH, (m) => 'x'.repeat(m.length));
  const out = [];
  let lineStart = 0;
  for (const line of masked.split('\n')) {
    const base = lineStart;
    lineStart += line.length + 1;
    if (!line.trim() || SKIP_LINE.test(line)) continue;
    const ends = clauses
      ? /[。！？!?；;…，,、：:—]+["”’）)」』】\]]*\s*|[.]["”’)\]]*\s+/g
      : /[。！？!?；;…]+["”’）)」』】\]]*\s*|[.]["”’)\]]*\s+(?=["“'‘(\[$A-Z0-9\u3400-\u9fff])/g;
    let s = 0;
    const push = (a, b) => {
      while (a < b && /\s/.test(line[a])) a++;
      if (b > a && /[\p{L}\p{N}]/u.test(line.slice(a, b))) out.push({ start: base + a, end: base + b, lineStart: !line.slice(0, a).trim() });
    };
    for (const m of line.matchAll(ends)) {
      const e = m.index + m[0].length;
      if (e >= line.length) break;
      push(s, e);
      s = e;
    }
    push(s, line.length);
  }
  return out;
}

// Content features of a text: word stems (en) or character pairs (zh).
function features(text, lang) {
  const toks = speechTokens(String(text || '').replace(/\uFFFC/g, ' '), lang);
  const f = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'han') {
      const u = toks[i + 1];
      if (u && u.kind === 'han' && !(isStopToken(t) && isStopToken(u))) f.add(t.n + u.n);
    } else if (t.kind === 'num') {
      f.add(t.n);
    } else if (t.kind === 'word' && !isStopToken(t) && t.n.length > 1) {
      f.add(t.stem || t.n);
    }
  }
  return f;
}

// Monotone placement of k clicks over n units: j[0] <= j[1] <= ... (unit
// index each click goes before). score[i][u]: content match of click i with
// unit u; prior: even spacing after a short opening, at a paragraph start
// when one is near (notes often give each build its own paragraph).
function align(score, n, k, lineStart) {
  const intro = n >= k + 1 ? 1 : 0;
  const expect = (i) => intro + (i * (n - intro)) / k;
  const W = 4;      // content match weight
  const L = 1;      // distance from the even spacing (as a fraction of the slide)
  const TIE = 1;    // two clicks at one place (only when the notes are too short)
  const PARA = 0.5; // a paragraph start
  const OPEN = 0.7; // the slide's first sentence (usually says what the slide is about)
  const val = (i, u) => W * score[i][u] - (L * Math.abs(u - expect(i))) / Math.max(1, n) +
    (lineStart[u] ? PARA : 0) - (u === 0 ? OPEN : 0);
  let best = Array.from({ length: n }, (_, u) => val(0, u));
  const back = [best.map(() => -1)];
  for (let i = 1; i < k; i++) {
    const cur = new Array(n).fill(-Infinity);
    const from = new Array(n).fill(-1);
    let runBest = -Infinity;
    let runArg = -1;
    for (let u = 0; u < n; u++) {
      // previous click strictly earlier (best so far), or at this same unit
      const tie = best[u] - TIE;
      const cand = Math.max(runBest, tie);
      const arg = runBest >= tie ? runArg : u;
      if (cand > -Infinity) {
        cur[u] = cand + val(i, u);
        from[u] = arg;
      }
      if (best[u] > runBest) { runBest = best[u]; runArg = u; }
    }
    best = cur;
    back.push(from);
  }
  let u = best.indexOf(Math.max(...best));
  const pos = new Array(k);
  for (let i = k - 1; i >= 0; i--) {
    pos[i] = u;
    u = back[i][u];
  }
  return pos;
}

// notes: the slide's spoken notes; steps: text each click reveals (empty for
// a picture). Returns {text, placed, at: [unit index per click]}.
export function placeClicks(notes, steps, opts = {}) {
  const text = String(notes || '');
  const k = Array.isArray(steps) ? steps.length : 0;
  if (!k || !text.trim()) return { text, placed: 0, at: [] };
  const lang = opts.lang === 'zh' || opts.lang === 'en' ? opts.lang : detectLang(text);
  let us = units(text, lang);
  if (us.length < k + 1) {
    const fine = units(text, lang, true);
    if (fine.length > us.length) us = fine;
  }
  const n = us.length;
  if (!n) return { text, placed: 0, at: [] };
  const uf = us.map((u) => features(text.slice(u.start, u.end), lang));
  const df = new Map();
  for (const f of uf) for (const x of f) df.set(x, (df.get(x) || 0) + 1);
  const idf = (x) => Math.log(1 + (n + 1) / ((df.get(x) || 0) + 0.5));
  // a slide abbreviates what the notes say in full ("Oct" / "October")
  const has = (f, x) => f.has(x) || (lang === 'en' && x.length >= 3 && [...f].some((y) => y.length > x.length && y.startsWith(x)));
  // what a click shows is usually talked about over a few sentences: the
  // click goes before the first of them
  const WINDOW = [1, 0.5, 0.25];
  const score = steps.map((st) => {
    const sf = [...features(st, lang)];
    const total = sf.reduce((a, x) => a + idf(x), 0);
    return uf.map((_, u) => {
      if (!total) return 0;
      let got = 0;
      for (const x of sf) {
        let w = 0;
        for (let d = 0; d < WINDOW.length && u + d < n; d++) if (WINDOW[d] > w && has(uf[u + d], x)) w = WINDOW[d];
        got += w * idf(x);
      }
      return got / total;
    });
  });
  const at = align(score, n, k, us.map((u) => u.lineStart));
  // group clicks that share a unit into one "[click xN]"
  const groups = new Map();
  for (const u of at) groups.set(u, (groups.get(u) || 0) + 1);
  let out = text;
  for (const u of [...groups.keys()].sort((a, b) => b - a)) {
    const c = groups.get(u);
    const s = us[u].start;
    out = `${out.slice(0, s)}[click${c > 1 ? ` x${c}` : ''}] ${out.slice(s)}`;
  }
  return { text: out, placed: k, at };
}
