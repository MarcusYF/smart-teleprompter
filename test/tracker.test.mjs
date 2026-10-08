// Scenario tests for the script follower, driven by the recognizer simulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript } from '../public/lib/script.js';
import { Follower } from '../public/lib/follower.js';
import { simulate, replay, truthAt } from '../public/lib/simulate.js';

const load = (f) => parseScript(readFileSync(new URL('../public/samples/' + f, import.meta.url), 'utf8'));
const ZH = load('zh-demo.md');
const EN = load('en-demo.md');

function run(doc, perf, opts = {}) {
  const f = new Follower(doc);
  const sim = simulate(doc, perf, opts);
  const trace = replay(f, sim);
  return { f, sim, trace };
}

// Fraction of reading time where the displayed phrase is the true phrase
// (or the next one, which the lead may show slightly early).
function phraseAccuracy(doc, sim, trace, mode = 'read') {
  let ok = 0;
  let n = 0;
  let lagSum = 0;
  for (const s of trace) {
    const tr = truthAt(sim, s.t - 700); // allow recognizer latency
    if (!tr || tr.mode !== mode) continue;
    const truePh = doc.tokens[Math.min(tr.pos, doc.tokens.length - 1)].phrase;
    n++;
    if (s.phrase === truePh || s.phrase === truePh + 1) ok++;
    lagSum += Math.abs(tr.pos - s.pos);
  }
  return { acc: n ? ok / n : 1, lag: n ? lagSum / n : 0, n };
}

const all = (doc) => [0, doc.phrases.length - 1];
const report = [];
function note(name, obj) {
  report.push({ name, ...obj });
}

test('en: clean read follows phrase by phrase', () => {
  const { sim, trace, f } = run(EN, [{ read: all(EN) }], { errRate: 0.03, seed: 3 });
  const r = phraseAccuracy(EN, sim, trace);
  note('en clean', r);
  assert.ok(r.acc >= 0.93, `accuracy ${r.acc}`);
  assert.ok(f.pos >= EN.tokens.length - 2, `ended at ${f.pos}/${EN.tokens.length}`);
});

test('zh: clean read with homophone errors', () => {
  const { sim, trace, f } = run(ZH, [{ read: all(ZH) }], { errRate: 0.06, seed: 5 });
  const r = phraseAccuracy(ZH, sim, trace);
  note('zh clean', r);
  assert.ok(r.acc >= 0.93, `accuracy ${r.acc}`);
  assert.ok(f.pos >= ZH.tokens.length - 2, `ended at ${f.pos}/${ZH.tokens.length}`);
});

test('en: heavy recognition errors (12%) still track', () => {
  const { sim, trace } = run(EN, [{ read: all(EN) }], { errRate: 0.12, seed: 11 });
  const r = phraseAccuracy(EN, sim, trace);
  note('en noisy', r);
  assert.ok(r.acc >= 0.85, `accuracy ${r.acc}`);
});

test('zh: heavy recognition errors (15%) still track', () => {
  const { sim, trace } = run(ZH, [{ read: all(ZH) }], { errRate: 0.15, seed: 13 });
  const r = phraseAccuracy(ZH, sim, trace);
  note('zh noisy', r);
  assert.ok(r.acc >= 0.85, `accuracy ${r.acc}`);
});

test('en: pause freezes the highlight and reports paused', () => {
  const { sim, trace } = run(EN, [{ read: [0, 5] }, { pause: 4000 }, { read: [6, 12] }], { seed: 2 });
  const endRead1 = sim.truth.filter((x) => x.pos <= EN.phrases[5].tokEnd).pop().t;
  const during = trace.filter((s) => s.t > endRead1 + 1800 && s.t < endRead1 + 3800);
  const posSet = new Set(during.map((s) => s.pos));
  note('en pause', { positionsDuringPause: [...posSet], statuses: [...new Set(during.map((s) => s.status))] });
  assert.equal(posSet.size, 1, 'position must not move during a pause');
  assert.ok(during.every((s) => s.status === 'paused'), 'status paused');
  const r = phraseAccuracy(EN, sim, trace);
  assert.ok(r.acc >= 0.9);
});

function adlibCheck(doc, perf, name, seed = 4) {
  const { sim, trace, f } = run(doc, perf, { seed });
  const ad = sim.truth.filter((x) => x.mode === 'adlib');
  const t0 = ad[0].t;
  const t1 = ad[ad.length - 1].t;
  const hold = ad[0].pos;
  const during = trace.filter((s) => s.t >= t0 + 800 && s.t <= t1 + 300);
  const drift = Math.max(...during.map((s) => Math.abs(s.pos - hold)));
  const off = during.filter((s) => s.status === 'offscript').length / during.length;
  const r = phraseAccuracy(doc, sim, trace);
  note(name, { drift, offscriptShare: +off.toFixed(2), acc: r.acc, lag: r.lag });
  return { drift, off, r, f };
}

test('en: related ad-lib holds position, then resumes', () => {
  const { drift, off, r } = adlibCheck(EN, [
    { read: [0, 6] },
    { say: 'and I think this is really important because in my own experience with students the annotations were all over the place' },
    { read: [7, 15] },
  ], 'en adlib');
  assert.ok(drift <= 3, `drift ${drift}`);
  assert.ok(off >= 0.5, `offscript share ${off}`);
  assert.ok(r.acc >= 0.9, `acc ${r.acc}`);
});

test('zh: related ad-lib holds position, then resumes', () => {
  const { drift, off, r } = adlibCheck(ZH, [
    { read: [0, 7] },
    { say: '我记得第一次在课上做这个实验的时候学生们完全没有共识特别有意思大家可以想一想为什么会这样' },
    { read: [8, 16] },
  ], 'zh adlib');
  assert.ok(drift <= 3, `drift ${drift}`);
  assert.ok(off >= 0.5, `offscript share ${off}`);
  assert.ok(r.acc >= 0.9, `acc ${r.acc}`);
});

function skipCheck(doc, a, b, c, d, name) {
  const { sim, trace, f } = run(doc, [{ read: [a, b] }, { read: [c, d] }], { seed: 9 });
  const firstAfter = sim.truth.find((x) => x.pos > doc.phrases[c].tokStart);
  const recovered = trace.find((s) => s.t >= firstAfter.t && Math.abs(s.pos - truthAt(sim, s.t).pos) <= 2);
  const delayTokens = recovered ? sim.truth.filter((x) => x.t >= firstAfter.t && x.t <= recovered.t).length : Infinity;
  const skipped = [...f.skipped].sort((x, y) => x - y);
  note(name, { recoveryTokens: delayTokens, skipped });
  return { delayTokens, skipped };
}

test('en: skipping ahead two sentences re-locates and marks skipped phrases', () => {
  const { delayTokens, skipped } = skipCheck(EN, 0, 6, 11, 18, 'en skip');
  assert.ok(delayTokens <= 8, `recovery ${delayTokens}`);
  for (let p = 7; p <= 10; p++) assert.ok(skipped.includes(p), `phrase ${p} marked skipped`);
});

test('zh: skipping ahead re-locates and marks skipped phrases', () => {
  const { delayTokens, skipped } = skipCheck(ZH, 0, 7, 12, 20, 'zh skip');
  assert.ok(delayTokens <= 10, `recovery ${delayTokens}`);
  for (let p = 8; p <= 11; p++) assert.ok(skipped.includes(p), `phrase ${p} marked skipped`);
});

test('en: false start then restart does not run ahead', () => {
  const ph = EN.phrases[8];
  const partial = ph.text.split(' ').slice(0, 2).join(' ');
  const { f, sim, trace } = run(EN, [
    { read: [0, 7] }, { text: partial, truth: ph.tokStart + 2 }, { say: 'sorry let me say that again' }, { read: [8, 12] },
  ], { seed: 21 });
  const r = phraseAccuracy(EN, sim, trace);
  note('en restart', { acc: r.acc, end: f.pos, expected: EN.phrases[12].tokEnd });
  assert.ok(Math.abs(f.pos - EN.phrases[12].tokEnd) <= 2);
  assert.ok(r.acc >= 0.88, `acc ${r.acc}`);
});

test('zh: going back to re-read an earlier sentence moves the highlight back', () => {
  const { f, sim, trace } = run(ZH, [{ read: [0, 13] }, { read: [11, 16] }], { seed: 17 });
  const backStart = sim.truth.findIndex((x, i) => i > 0 && x.pos < sim.truth[i - 1].pos);
  const tBack = sim.truth[backStart].t;
  const moved = trace.find((s) => s.t > tBack && s.pos < ZH.phrases[12].tokStart);
  note('zh back', { movedBackAfterMs: moved ? moved.t - tBack : null, end: f.pos, expected: ZH.phrases[16].tokEnd });
  assert.ok(moved, 'display moved back');
  assert.ok(Math.abs(f.pos - ZH.phrases[16].tokEnd) <= 2);
});

test('zh: paraphrased sentence then verbatim continuation', () => {
  const { f, sim, trace } = run(ZH, [
    { read: [0, 5] },
    { say: '说白了就是人喜欢的答案给它加分不喜欢的就扣分' },
    { read: [8, 13] },
  ], { seed: 23 });
  note('zh paraphrase', { end: f.pos, expected: ZH.phrases[13].tokEnd, skipped: [...f.skipped] });
  assert.ok(Math.abs(f.pos - ZH.phrases[13].tokEnd) <= 2);
});

test('performance: interim updates are fast', () => {
  const big = parseScript(Array.from({ length: 25 }, () => readFileSync(new URL('../public/samples/zh-demo.md', import.meta.url), 'utf8')).join('\n\n'));
  const f = new Follower(big);
  const sim = simulate(big, [{ read: [0, 120] }], { seed: 1 });
  const t0 = performance.now();
  for (const ev of sim.events) f.onSpeech(ev.kind, ev.text, ev.t);
  const ms = (performance.now() - t0) / sim.events.length;
  note('perf', { tokens: big.tokens.length, events: sim.events.length, msPerEvent: +ms.toFixed(2) });
  assert.ok(ms < 8, `ms per event ${ms}`);
});

test.after(() => {
  console.log('\n--- follower scenario report ---');
  for (const r of report) console.log(JSON.stringify(r));
});
