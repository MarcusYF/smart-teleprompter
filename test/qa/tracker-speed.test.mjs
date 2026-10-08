// Speed extremes, long mid-sentence pauses, stutters and fillers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

const { EN, ZH } = H;
const SEEDS = [1, 2, 3, 4, 5];
const all = (d) => [{ read: [0, d.phrases.length - 1] }];
const base = { en: 2.5, zh: 4.2 };

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  for (const mult of [0.5, 1.8]) {
    test(`${lang}: speaking at ${mult}x normal rate`, () => {
      const rows = SEEDS.map((seed) => {
        const r = H.runSim(doc, all(doc), { seed, rate: base[lang] * mult, errRate: 0.04 });
        const a = H.phraseAccuracy(doc, r.sim, r.trace);
        return { acc: a.acc, lag: a.lag, end: doc.tokens.length - r.f.pos, skipped: r.f.skipped.size };
      });
      const w = { acc: Math.min(...rows.map((x) => x.acc)), lag: Math.max(...rows.map((x) => x.lag)), endErr: Math.max(...rows.map((x) => x.end)), skipped: Math.max(...rows.map((x) => x.skipped)) };
      H.note(`${lang} rate x${mult}`, w);
      assert.ok(w.acc >= 0.93, `acc ${w.acc}`);
      assert.equal(w.skipped, 0);
      assert.ok(w.endErr <= 1);
    });
  }

  test(`${lang}: slow speech with 3.5 s pauses in the middle of every other phrase`, () => {
    const perf = [];
    for (let p = 0; p < doc.phrases.length; p++) {
      const ph = doc.phrases[p];
      const n = ph.tokEnd - ph.tokStart;
      if (p % 2 === 0 && n >= 4) {
        const cut = ph.tokStart + Math.floor(n / 2);
        perf.push({ readTok: [ph.tokStart, cut] }, { pause: 3500 }, { readTok: [cut, ph.tokEnd] });
      } else perf.push({ read: [p, p] });
    }
    const rows = SEEDS.map((seed) => {
      const r = H.runRec(doc, perf, { seed, rate: base[lang] * 0.6, errRate: 0.03 });
      const moved = r.trace.filter((s, i) => i && s.status === 'paused' && r.trace[i - 1].status === 'paused' && s.pos !== r.trace[i - 1].pos).length;
      return { acc: H.phraseAccuracy(doc, r.sim, r.trace).acc, movedWhilePaused: moved, end: doc.tokens.length - r.f.pos, skipped: r.f.skipped.size };
    });
    const w = { acc: Math.min(...rows.map((x) => x.acc)), movedWhilePaused: Math.max(...rows.map((x) => x.movedWhilePaused)), endErr: Math.max(...rows.map((x) => x.end)), skipped: Math.max(...rows.map((x) => x.skipped)) };
    H.note(`${lang} mid-phrase pauses`, w);
    assert.ok(w.acc >= 0.97, `acc ${w.acc}`);
    assert.equal(w.movedWhilePaused, 0);
    assert.equal(w.skipped + w.endErr, 0);
  });
}

// Disfluencies inserted before random words.
const FILLERS = {
  en: ['um', 'uh', 'you know', 'I mean', 'like', 'so', 'kind of', 'right'],
  zh: ['嗯', '那个', '就是', '然后', '这个', '对吧', '就是说', '那个那个'],
};
function disfluent(doc, seed, pStutter, pFiller) {
  const rand = H.rng(seed * 7919);
  const F = FILLERS[doc.lang];
  const subs = [];
  for (const ph of doc.phrases) {
    for (const pc of ph.pieces) {
      if (pc.tok === undefined) continue;
      const r = rand();
      if (r < pStutter) subs.push({ from: pc.tok, to: pc.tokEnd, say: `${pc.t} ${pc.t}` });
      else if (r < pStutter + pFiller) subs.push({ from: pc.tok, to: pc.tokEnd, say: `${F[Math.floor(rand() * F.length)]} ${pc.t}` });
    }
  }
  return subs;
}

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  for (const [name, ps, pf] of [['stutters (8% of words doubled)', 0.08, 0], ['fillers before 15% of words', 0, 0.15], ['stutters 5% + fillers 10%', 0.05, 0.1]]) {
    test(`${lang}: ${name}`, () => {
      const rows = SEEDS.map((seed) => {
        const r = H.runRec(doc, [{ read: [0, doc.phrases.length - 1], subs: disfluent(doc, seed, ps, pf) }], { seed, errRate: 0.03 });
        const a = H.phraseAccuracy(doc, r.sim, r.trace);
        return { acc: a.acc, maxAhead: a.maxAhead, off: r.trace.filter((s) => s.status === 'offscript').length / r.trace.length, skipped: r.f.skipped.size, end: doc.tokens.length - r.f.pos };
      });
      const w = { acc: Math.min(...rows.map((x) => x.acc)), maxAhead: Math.max(...rows.map((x) => x.maxAhead)), offShare: +Math.max(...rows.map((x) => x.off)).toFixed(2), skipped: Math.max(...rows.map((x) => x.skipped)), endErr: Math.max(...rows.map((x) => x.end)) };
      H.note(`${lang} ${name}`, w);
      assert.ok(w.acc >= 0.97, `acc ${w.acc}`);
      assert.equal(w.skipped + w.endErr, 0);
    });
  }
}

test.after(() => H.printNotes('tracker-speed'));
