// QA harness for the speech follower.
//
// Two ways to drive a Follower:
//   * the app's own simulator (public/lib/simulate.js), and
//   * `recognize()` below: a recognizer model closer to Chrome's Web Speech
//     output (multi-word interim rewrites, finals that differ from the last
//     interim, punctuation/capitals in finals, long utterances, empty
//     interims after each final, mixed zh/en spacing), with explicit
//     per-token "renderings" (what the recognizer writes for a script span)
//     so number formats, spelled-out acronyms, omissions, stutters and
//     fillers can be scripted exactly.
//
// Run (Node 25's test runner takes files/globs, not a bare directory):
//   node --test test/qa/*.test.mjs                  current code
//   QA_IMPL=proto node --test test/qa/*.test.mjs    with the prototype fixes
//   node test/qa/tracker-proto-npmtest.mjs          main suite vs prototype
//
// Module source (all of lang/script/tracker/follower come from one folder):
//   default            public/lib (the app's live code)
//   QA_IMPL=proto      test/qa/proto-tracker (scratch copies with the
//                      prototype fixes proposed in REPORT-tracker.md)
//   QA_LIB=/abs/dir    any other folder with the same module layout
// runSim() always uses public/lib/simulate.js; `simulateLib` (used only by
// the simulator tests) comes from the selected folder.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { simulate, replay, truthAt, rng } from '../../public/lib/simulate.js';
import { PINYIN_FIRST, PINYIN_TABLE } from '../../public/lib/pinyin-table.js';

const LIB = process.env.QA_LIB
  ? pathToFileURL(process.env.QA_LIB.replace(/\/?$/, '/'))
  : new URL(process.env.QA_IMPL === 'proto' ? './proto-tracker/' : '../../public/lib/', import.meta.url);
export const { Follower } = await import(new URL('follower.js', LIB));
export const { Tracker } = await import(new URL('tracker.js', LIB));
export const { parseScript } = await import(new URL('script.js', LIB));
export const { speechTokens, tokenSim } = await import(new URL('lang.js', LIB));
// The simulator under test in tracker-mixed (falls back to public/lib).
export const { simulate: simulateLib } = await import(new URL('simulate.js', LIB)).catch(() => import('../../public/lib/simulate.js'));
export const IMPL = process.env.QA_LIB ? 'lib:' + process.env.QA_LIB.split('/').slice(-3).join('/') : process.env.QA_IMPL === 'proto' ? 'proto' : 'orig';
export { simulate, replay, truthAt, rng };

export const sample = (f) => parseScript(readFileSync(new URL('../../public/samples/' + f, import.meta.url), 'utf8'));
export const EN = sample('en-demo.md');
export const ZH = sample('zh-demo.md');

const isHanCh = (s) => /^[㐀-䶿一-鿿豈-﫿]$/u.test(s);

// ----------------------------------------------------------- error model

let HOMO = null;
function homophone(ch, rand) {
  if (!HOMO) {
    HOMO = { map: new Map(), py: PINYIN_TABLE.split(' ') };
    HOMO.py.forEach((py, i) => {
      if (!py) return;
      if (!HOMO.map.has(py)) HOMO.map.set(py, []);
      const l = HOMO.map.get(py);
      if (l.length < 12) l.push(String.fromCodePoint(PINYIN_FIRST + i));
    });
  }
  const py = HOMO.py[ch.codePointAt(0) - PINYIN_FIRST];
  const list = py && HOMO.map.get(py);
  if (!list || list.length < 2) return ch;
  let c = ch;
  for (let k = 0; k < 4 && c === ch; k++) c = list[Math.floor(rand() * list.length)];
  return c;
}
const EN_JUNK = ['the', 'and', 'so', 'that', 'thing', 'well', 'in', 'a'];
function corrupt(u, rand) {
  if (isHanCh(u)) return homophone(u, rand);
  if (/^\d/.test(u)) return u;
  if (rand() < 0.5) return EN_JUNK[Math.floor(rand() * EN_JUNK.length)];
  return u.length > 4 ? u.slice(0, -1) : u + 's';
}

// Recognizer units of a text (zh: one per Han character; Latin words and
// numbers stay whole in both languages).
export function unitsOf(text) {
  const out = [];
  const re = /([㐀-䶿一-鿿豈-﫿])|(\d+(?:[.,:]\d+)*%?)|([A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*)/gu;
  let m;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

// Join units the way recognizers print them: nothing between Han
// characters, a space between Latin words / numbers.
export function joinUnits(us, lang) {
  if (lang !== 'zh') return us.join(' ');
  let s = '';
  for (let i = 0; i < us.length; i++) {
    if (i && !isHanCh(us[i]) && !isHanCh(us[i - 1])) s += ' ';
    s += us[i];
  }
  return s;
}

// ----------------------------------------------------- performance units

// performance segments:
//   {read:[a,b], subs?:[{from, to, say}]}  read phrases a..b (inclusive);
//        subs replace script tokens [from,to) by what the recognizer hears
//        (say:'' = omission; say:'the the' = stutter; say:'20%' = format)
//   {readTok:[from,to], subs?}  read script tokens [from,to) (any boundary)
//   {say:'text'}            ad-lib (truth holds at the last position)
//   {text:'...', truth:k}   arbitrary speech with fixed truth position
//   {pause: ms}
//   {final:true}            force an utterance end (recognizer endpoint)
export function unitsForPerformance(doc, perf) {
  const out = [];
  let last = 0;
  for (const seg of perf) {
    if (seg.pause) {
      out.push({ pause: seg.pause });
      continue;
    }
    if (seg.final) {
      out.push({ end: true });
      continue;
    }
    if (seg.read || seg.readTok) {
      let t0;
      let t1;
      if (seg.read) {
        t0 = doc.phrases[seg.read[0]].tokStart;
        t1 = doc.phrases[Math.min(seg.read[1], doc.phrases.length - 1)].tokEnd;
      } else [t0, t1] = seg.readTok;
      const subs = (seg.subs || []).slice().sort((x, y) => x.from - y.from);
      // display words with their truth positions
      const words = [];
      for (const ph of doc.phrases) {
        if (ph.tokEnd <= t0 || ph.tokStart >= t1) continue;
        for (const pc of ph.pieces) {
          if (pc.tok === undefined || pc.tok < t0 || pc.tokEnd > t1) continue;
          words.push({ w: pc.t, from: pc.tok, to: pc.tokEnd });
        }
      }
      let k = 0;
      for (const s of subs) {
        while (k < words.length && words[k].from < s.from) {
          out.push({ w: words[k].w, pos: words[k].to, mode: 'read' });
          k++;
        }
        const us = unitsOf(s.say || '');
        us.forEach((u, i) => {
          const pos = Math.round(s.from + ((i + 1) / us.length) * (s.to - s.from));
          out.push({ w: u, pos, mode: 'read', sub: true });
        });
        while (k < words.length && words[k].from < s.to) k++;
      }
      while (k < words.length) {
        out.push({ w: words[k].w, pos: words[k].to, mode: 'read' });
        k++;
      }
      last = t1;
      continue;
    }
    if (seg.say !== undefined || seg.text !== undefined) {
      const us = unitsOf(seg.say ?? seg.text);
      const pos = seg.truth ?? last;
      for (const u of us) out.push({ w: u, pos, mode: seg.say !== undefined ? 'adlib' : 'text' });
      if (seg.truth !== undefined) last = seg.truth;
      if (seg.endUtterance !== false) out.push({ end: true });
    }
  }
  return out;
}

// ------------------------------------------------------ recognizer model

// opts:
//   rate            units per second (default zh 4.2, en 2.5)
//   seed
//   errRate         final-text substitution rate
//   revRate         interim shows a wrong last unit (fixed next interim)
//   rewriteRate     Chrome-style: interim rewrites the last 2..rewriteSpan
//                   units with a wrong hypothesis, corrected later
//   finalEvery      [min,max] units per utterance
//   latency         ms from speech to interim
//   finalDiffers    probability that the final's last unit differs from the
//                   last interim (recognizer re-decodes at endpoint)
//   punctuate       add punctuation/capitals to finals (Chrome/Apple do)
//   emptyInterimAfterFinal  (WebSpeechEngine does this) default true
//   leadingSpace    en finals start with a space like Chrome's results[i>0]
export function recognize(doc, perf, opts = {}) {
  const lang = doc.lang;
  const rand = rng(opts.seed || 7);
  const rate = opts.rate || (lang === 'zh' ? 4.2 : 2.5);
  const errRate = opts.errRate ?? 0.03;
  const revRate = opts.revRate ?? 0.15;
  const rewriteRate = opts.rewriteRate ?? 0;
  const rewriteSpan = opts.rewriteSpan ?? 4;
  const [fmin, fmax] = opts.finalEvery || (lang === 'zh' ? [10, 24] : [7, 16]);
  const latency = opts.latency ?? 180;
  const finalDiffers = opts.finalDiffers ?? 0;
  const punctuate = opts.punctuate ?? false;
  const emptyAfterFinal = opts.emptyInterimAfterFinal ?? true;
  const events = [];
  const truth = [];
  let t = opts.start || 0;
  let utter = [];
  let limit = fmin + Math.floor(rand() * (fmax - fmin + 1));

  const render = (us, final) => {
    let s = joinUnits(us, lang);
    if (final && punctuate && s) {
      if (lang === 'zh') s += '。';
      else s = s[0].toUpperCase() + s.slice(1) + '.';
    }
    if (final && opts.leadingSpace && lang !== 'zh') s = ' ' + s;
    return s;
  };
  const flush = () => {
    if (!utter.length) return;
    let us = utter;
    if (rand() < finalDiffers) {
      us = utter.slice();
      us[us.length - 1] = corrupt(us[us.length - 1], rand);
    }
    events.push({ t: t + latency + 120, kind: 'final', text: render(us, true) });
    if (emptyAfterFinal) events.push({ t: t + latency + 121, kind: 'interim', text: '' });
    utter = [];
    limit = fmin + Math.floor(rand() * (fmax - fmin + 1));
  };
  for (const u of unitsForPerformance(doc, perf)) {
    if (u.pause) {
      flush();
      t += u.pause;
      continue;
    }
    if (u.end) {
      flush();
      continue;
    }
    t += (1000 / rate) * (0.75 + rand() * 0.5);
    utter.push(rand() < errRate ? corrupt(u.w, rand) : u.w);
    const shown = utter.slice();
    if (rand() < revRate) shown[shown.length - 1] = corrupt(shown[shown.length - 1], rand);
    if (rewriteRate && shown.length >= 3 && rand() < rewriteRate) {
      const k = Math.min(shown.length, 2 + Math.floor(rand() * (rewriteSpan - 1)));
      for (let i = shown.length - k; i < shown.length; i++) shown[i] = corrupt(shown[i], rand);
    }
    events.push({ t: t + latency, kind: 'interim', text: render(shown, false) });
    truth.push({ t, pos: u.pos, mode: u.mode });
    if (utter.length >= limit) flush();
  }
  flush();
  events.sort((x, y) => x.t - y.t);
  return { events, truth, duration: t + 800 };
}

// ------------------------------------------------------------- running

export function drive(doc, sim, fopts = {}, ropts = {}) {
  const f = new Follower(doc, fopts);
  const log = [];
  const t0 = process.hrtime.bigint();
  const trace = replay(f, sim, {
    tickMs: ropts.tickMs,
    onEvent: ropts.log ? (ev, fo) => log.push({
      t: Math.round(ev.t), k: ev.kind[0], text: ev.text.slice(-40), pos: fo.pos,
      tpos: fo.tracker.last.pos, run: fo.tracker.last.run, hits: +fo.tracker.last.hits.toFixed(2),
      m: +fo.tracker.last.margin.toFixed(2), st: fo.status,
    }) : undefined,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { f, sim, trace, log, ms };
}

export function runSim(doc, perf, simOpts = {}, fopts = {}, ropts = {}) {
  return drive(doc, simulate(doc, perf, simOpts), fopts, ropts);
}

export function runRec(doc, perf, recOpts = {}, fopts = {}, ropts = {}) {
  return drive(doc, recognize(doc, perf, recOpts), fopts, ropts);
}

// ------------------------------------------------------------- metrics

// Share of trace samples (while the truth mode is `modes`) where the shown
// phrase is the true phrase or the next one (the lead may run one early).
export function phraseAccuracy(doc, sim, trace, modes = ['read'], latencyMs = 700) {
  let ok = 0;
  let n = 0;
  let lag = 0;
  let maxAhead = 0;
  for (const s of trace) {
    const tr = truthAt(sim, s.t - latencyMs);
    if (!tr || !modes.includes(tr.mode)) continue;
    const truePh = doc.tokens[Math.min(tr.pos, doc.tokens.length - 1)].phrase;
    n++;
    if (s.phrase === truePh || s.phrase === truePh + 1) ok++;
    lag += Math.abs(tr.pos - s.pos);
    maxAhead = Math.max(maxAhead, s.pos - tr.pos);
  }
  return { acc: n ? +(ok / n).toFixed(3) : 1, lag: n ? +(lag / n).toFixed(2) : 0, maxAhead, n };
}

// Largest displacement of the display from the hold point while the
// speaker is off script (mode 'adlib'), starting `graceMs` after the ad-lib
// begins.
export function offScriptDrift(sim, trace, mode = 'adlib', graceMs = 800) {
  const ad = sim.truth.filter((x) => x.mode === mode);
  if (!ad.length) return null;
  const t0 = ad[0].t;
  const t1 = ad[ad.length - 1].t;
  const hold = ad[0].pos;
  const during = trace.filter((s) => s.t >= t0 + graceMs && s.t <= t1 + 300);
  let fwd = 0;
  let back = 0;
  for (const s of during) {
    fwd = Math.max(fwd, s.pos - hold);
    back = Math.max(back, hold - s.pos);
  }
  const off = during.length ? during.filter((s) => s.status === 'offscript' || s.status === 'paused').length / during.length : 0;
  return { hold, fwd, back, drift: Math.max(fwd, back), offShare: +off.toFixed(2) };
}

// Spoken units (truth points) needed after time t0 until the display is
// within `tol` tokens of the truth (Infinity if it never gets there).
export function recoveryUnits(sim, trace, t0, tol = 2) {
  const rec = trace.find((s) => s.t >= t0 && truthAt(sim, s.t) && Math.abs(s.pos - truthAt(sim, s.t).pos) <= tol);
  if (!rec) return Infinity;
  return sim.truth.filter((x) => x.t >= t0 && x.t <= rec.t).length;
}

// Phrases marked skipped although most of their tokens were spoken.
export function wrongSkips(doc, f, spokenPhrases) {
  return [...f.skipped].filter((p) => spokenPhrases.has(p)).sort((a, b) => a - b);
}

// Token range [from, to) of the first occurrence of `text` at or after
// token `after` (zh: concatenated token strings; en: space-joined words).
export function findSpan(doc, text, after = 0) {
  const sep = doc.lang === 'zh' ? '' : ' ';
  // normalize the query with the live tokenizer (number readings etc.)
  const want = speechTokens(text, doc.lang).map((t) => t.n).join(sep);
  const T = doc.tokens;
  for (let i = after; i < T.length; i++) {
    let s = '';
    for (let j = i; j < T.length && s.length < want.length + 2; j++) {
      s += (j > i ? sep : '') + T[j].n;
      if (s === want) return { from: i, to: j + 1 };
      if (!want.startsWith(s)) break;
    }
  }
  throw new Error(`span not found: ${text}`);
}

export function sub(doc, text, say, after = 0) {
  return { ...findSpan(doc, text, after), say };
}

export function range(a, b) {
  const s = new Set();
  for (let i = a; i <= b; i++) s.add(i);
  return s;
}

// Collect metrics for the report; printed after the run.
export const rows = [];
export function note(name, obj) {
  rows.push({ name, impl: IMPL, ...obj });
}
export function printNotes(title) {
  console.log(`\n--- ${title} (${IMPL}) ---`);
  for (const r of rows) console.log(JSON.stringify(r));
}

export function showDoc(doc, log = console.log) {
  for (const ph of doc.phrases) {
    log(String(ph.idx).padStart(3), `[${ph.tokStart}-${ph.tokEnd}]`, ph.text, '|',
      doc.tokens.slice(ph.tokStart, ph.tokEnd).map((t) => t.n).join(' '));
  }
}
