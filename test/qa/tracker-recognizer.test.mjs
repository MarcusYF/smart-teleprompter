// Recognizer behaviour closer to Chrome's Web Speech / Apple's volatile
// results: multi-word interim rewrites, finals that differ from the last
// interim, punctuation and capitals in finals, very long utterances,
// interims that are withdrawn (empty or shorter) and finals that never
// arrive (session restart).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

const { EN, ZH } = H;
const SEEDS = [1, 2, 3, 4];
const all = (d) => [{ read: [0, d.phrases.length - 1] }];

const configs = {
  'interim rewrites 2-5 earlier words (60% of interims)': { rewriteRate: 0.6, rewriteSpan: 5 },
  'final differs from last interim + punctuation/caps': { finalDiffers: 0.5, punctuate: true, leadingSpace: true },
  '40-60 unit utterances without a final': { finalEvery: [40, 60], rewriteRate: 0.2 },
  'everything at once, 5% errors': { rewriteRate: 0.4, rewriteSpan: 5, finalDiffers: 0.4, punctuate: true, leadingSpace: true, finalEvery: [25, 50], errRate: 0.05 },
};

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  for (const [name, cfg] of Object.entries(configs)) {
    test(`${lang}: ${name}`, () => {
      const rows = SEEDS.map((seed) => {
        const r = H.runRec(doc, all(doc), { seed, ...cfg });
        const a = H.phraseAccuracy(doc, r.sim, r.trace);
        return { acc: a.acc, maxAhead: a.maxAhead, backs: r.f.events.filter((e) => e.how === 'back').length, skipped: r.f.skipped.size, end: doc.tokens.length - r.f.pos };
      });
      const w = { acc: Math.min(...rows.map((x) => x.acc)), maxAhead: Math.max(...rows.map((x) => x.maxAhead)), backs: Math.max(...rows.map((x) => x.backs)), skipped: Math.max(...rows.map((x) => x.skipped)), endErr: Math.max(...rows.map((x) => x.end)) };
      H.note(`${lang} ${name}`, w);
      assert.ok(w.acc >= 0.95, `accuracy ${w.acc}`);
      assert.equal(w.skipped, 0, 'no skipped marks on a full read');
      assert.ok(w.endErr <= 1, `ended ${w.endErr} tokens short`);
    });
  }
}

// An interim hypothesis that is withdrawn (the engine sends '' or a shorter
// text without a final) is not evidence that the speaker went back.
function withdrawnEvery(sim, k) {
  let n = 0;
  return { ...sim, events: sim.events.filter((e) => !(e.kind === 'final' && ++n % k === 0)) };
}

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  test(`${lang}: withdrawn interim ('' with no final) does not move the display back`, () => {
    const rows = SEEDS.map((seed) => {
      // every 3rd utterance: interim hypothesis, then '' and no final
      const sim = withdrawnEvery(H.recognize(doc, all(doc), { seed, finalEvery: lang === 'zh' ? [15, 30] : [8, 18] }), 3);
      const r = H.drive(doc, sim);
      const backs = r.f.events.filter((e) => e.how === 'back');
      const a = H.phraseAccuracy(doc, sim, r.trace);
      return { backs: backs.length, maxBack: Math.max(0, ...backs.map((e) => e.from - e.to)), acc: a.acc, end: doc.tokens.length - r.f.pos };
    });
    const w = { backs: Math.max(...rows.map((x) => x.backs)), maxBack: Math.max(...rows.map((x) => x.maxBack)), acc: Math.min(...rows.map((x) => x.acc)), endErr: Math.max(...rows.map((x) => x.end)) };
    H.note(`${lang} withdrawn interims`, w);
    assert.equal(w.backs, 0, `${w.backs} back moves (largest ${w.maxBack} tokens) caused by withdrawn interims`);
    assert.ok(w.endErr <= 1, `display ended ${w.endErr} tokens before the end`);
    assert.ok(w.acc >= 0.9, `accuracy ${w.acc}`);
  });
}

// Minimal reproduction: the last utterance of the talk is withdrawn.
test("en: talk ends, recognizer withdraws the last interim -> display stays at the end", () => {
  const f = new H.Follower(EN);
  const text = EN.phrases.map((p) => p.text).join(' ').replace(/[,.:]/g, '');
  const words = text.split(' ');
  const cut = words.length - 12;
  let t = 0;
  for (let i = 1; i <= cut; i++) f.onSpeech('interim', words.slice(0, i).join(' '), (t += 380));
  f.onSpeech('final', words.slice(0, cut).join(' '), (t += 100));
  for (let i = cut + 1; i <= words.length; i++) f.onSpeech('interim', words.slice(cut, i).join(' '), (t += 380));
  const atEnd = f.pos;
  f.onSpeech('interim', '', (t += 300)); // hypothesis withdrawn, no final
  H.note('withdrawn last interim', { atEnd, afterEmpty: f.pos, N: EN.tokens.length });
  assert.equal(atEnd, EN.tokens.length);
  assert.equal(f.pos, atEnd, `display jumped back ${atEnd - f.pos} tokens on an empty interim`);
});

// A final shorter than the last interim (the engine moves its two unstable
// last words into the next utterance): the display should not bounce back
// two tokens and forward again at every utterance boundary.
function shortFinals(sim) {
  const out = [];
  let carry = [];
  for (const e of sim.events) {
    if (e.kind === 'interim') {
      out.push({ ...e, text: [...carry, e.text].filter(Boolean).join(' ') });
      continue;
    }
    const w = [...carry, ...e.text.split(' ').filter(Boolean)];
    if (w.length > 4) {
      out.push({ ...e, text: w.slice(0, -2).join(' ') });
      carry = w.slice(-2);
    } else {
      out.push({ ...e, text: w.join(' ') });
      carry = [];
    }
  }
  return { ...sim, events: out };
}

test('en: final that drops the last two interim words does not bounce the display', () => {
  const rows = SEEDS.map((seed) => {
    const sim = shortFinals(H.recognize(EN, all(EN), { seed }));
    const r = H.drive(EN, sim);
    return { backs: r.f.events.filter((e) => e.how === 'back').length, end: EN.tokens.length - r.f.pos, acc: H.phraseAccuracy(EN, sim, r.trace).acc };
  });
  const w = { backs: Math.max(...rows.map((x) => x.backs)), endErr: Math.max(...rows.map((x) => x.end)), acc: Math.min(...rows.map((x) => x.acc)) };
  H.note('en short finals', w);
  assert.equal(w.backs, 0, `${w.backs} back-and-forth bounces`);
  assert.ok(w.endErr <= 1);
});

// Session restart: an utterance's final never arrives, the next interim
// starts from scratch. Reading accuracy should not collapse.
for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  test(`${lang}: lost finals (every 2nd utterance) keep accuracy`, () => {
    const rows = SEEDS.map((seed) => {
      const base = H.recognize(doc, all(doc), { seed, finalEvery: lang === 'zh' ? [15, 30] : [8, 18], emptyInterimAfterFinal: false });
      let n = 0;
      const sim = { ...base, events: base.events.filter((e) => !(e.kind === 'final' && ++n % 2 === 0)) };
      const r = H.drive(doc, sim);
      return { acc: H.phraseAccuracy(doc, sim, r.trace).acc, end: doc.tokens.length - r.f.pos };
    });
    const w = { acc: Math.min(...rows.map((x) => x.acc)), endErr: Math.max(...rows.map((x) => x.end)) };
    H.note(`${lang} lost finals`, w);
    assert.ok(w.acc >= 0.9, `accuracy ${w.acc}`);
    assert.ok(w.endErr <= 1, `ended ${w.endErr} short`);
  });
}

// Informational: engines without interims, and bursty interims.
for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  test(`${lang}: finals-only and bursty engines (informational)`, () => {
    const out = {};
    for (const [name, tf] of [
      ['finalsOnly', (s) => ({ ...s, events: s.events.filter((e) => e.kind === 'final') })],
      ['bursty4', (s) => { let k = 0; return { ...s, events: s.events.filter((e) => e.kind === 'final' || ++k % 4 === 0) }; }],
    ]) {
      const accs = SEEDS.map((seed) => {
        const sim = tf(H.recognize(doc, all(doc), { seed }));
        const r = H.drive(doc, sim);
        return H.phraseAccuracy(doc, sim, r.trace, ['read'], name === 'finalsOnly' ? 4000 : 1200).acc;
      });
      out[name] = Math.min(...accs);
    }
    H.note(`${lang} engine styles`, out);
    assert.ok(out.bursty4 >= 0.85);
  });
}

test.after(() => H.printNotes('tracker-recognizer'));
