// Omissions, skips and going back: the display should follow, and the
// skipped-phrase marks (dotted underline + Jev "did that matter?" check)
// should name exactly the phrases the speaker left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

const { EN, ZH } = H;
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);
const firstPh = (doc, para) => doc.sents[doc.paras[para].sentStart].phStart;
const lastPh = (doc, para) => doc.sents[doc.paras[para].sentEnd - 1].phEnd - 1;

// Omit `span` tokens (whole display words) inside 50% of the phrases with
// at least 4 tokens; never the first token of a phrase.
function omissions(doc, seed, span) {
  const rand = H.rng(seed * 104729);
  const subs = [];
  for (const ph of doc.phrases) {
    const n = ph.tokEnd - ph.tokStart;
    if (n < 4 || rand() >= 0.5) continue;
    const k = ph.tokStart + 1 + Math.floor(rand() * (n - span - 1));
    subs.push({ from: k, to: k + span, say: '' });
  }
  return subs;
}
// Phrases marked skipped although at least half of their words were said.
function wrongMarks(doc, f, subs) {
  const omitted = new Uint8Array(doc.tokens.length);
  for (const s of subs) for (let k = s.from; k < s.to; k++) omitted[k] = 1;
  return [...f.skipped].filter((p) => {
    const ph = doc.phrases[p];
    let said = 0;
    for (let k = ph.tokStart; k < ph.tokEnd; k++) said += 1 - omitted[k];
    return said / (ph.tokEnd - ph.tokStart) >= 0.5;
  });
}

for (const [lang, doc, spans] of [['en', EN, [1, 2]], ['zh', ZH, [1, 2, 3]]]) {
  for (const span of spans) {
    test(`${lang}: omitting ${span} ${lang === 'zh' ? 'character(s)' : 'word(s)'} mid-phrase never marks a mostly-read phrase`, () => {
      let wrong = 0;
      const examples = new Set();
      let minAcc = 1;
      for (const seed of SEEDS) {
        const subs = omissions(doc, seed, span);
        // errRate 0: isolate omissions (with recognition errors on top, a
        // phrase can legitimately look skipped, e.g. "that [we can] optimize"
        // with "optimize" misheard)
        const r = H.runRec(doc, [{ read: [0, doc.phrases.length - 1], subs }], { seed, errRate: 0 });
        const w = wrongMarks(doc, r.f, subs);
        wrong += w.length;
        for (const p of w) examples.add(doc.phrases[p].text);
        minAcc = Math.min(minAcc, H.phraseAccuracy(doc, r.sim, r.trace).acc);
      }
      H.note(`${lang} omit ${span}`, { wrongMarksOver12Seeds: wrong, examples: [...examples].slice(0, 3), minAcc });
      assert.equal(wrong, 0, `${wrong} wrong skipped marks, e.g. ${[...examples].slice(0, 2).join(' / ')}`);
      assert.ok(minAcc >= 0.95, `accuracy ${minAcc}`);
    });
  }
}

// Mechanism: an interim rewrite after a display move makes the follower
// ignore a word that was really spoken ("with"), so "To deal with this,"
// (only "deal" omitted) is marked skipped.
test('en: interim rewrite after a move does not hide spoken words from skip marking', () => {
  const f = new H.Follower(EN);
  let t = 0;
  const upTo = EN.phrases.slice(0, 16).map((p) => p.text).join(' ').replace(/[,.:]/g, '');
  const w = upTo.split(' ');
  for (let i = 1; i <= w.length; i++) f.onSpeech('interim', w.slice(0, i).join(' '), (t += 380));
  f.onSpeech('final', upTo, (t += 100));
  // phrase 16 "To deal with this," read without "deal"; the recognizer
  // first mishears "with" as "in", then corrects it
  // (the display moves 86->87 on "To in": run 1, so the unmatched "in"
  // is counted as consumed by that move)
  f.onSpeech('interim', 'To in', (t += 380));
  f.onSpeech('interim', 'To with this', (t += 380));
  f.onSpeech('interim', 'To with this researchers', (t += 380));
  f.onSpeech('interim', 'To with this researchers usually', (t += 380));
  f.onSpeech('final', 'To with this researchers usually', (t += 100));
  H.note('interim rewrite hides spoken words', { skipped: [...f.skipped], flags86to89: [...f.spokenTok.slice(86, 90)] });
  assert.ok(!f.skipped.has(16), 'phrase 16 "To deal with this," marked skipped although 3 of 4 words were said');
});

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  test(`${lang}: skipping two paragraphs re-locates and marks exactly them`, () => {
    const rows = SEEDS.slice(0, 5).map((seed) => {
      const a = lastPh(doc, 1);
      const c = firstPh(doc, 4);
      const r = H.runRec(doc, [{ read: [0, a] }, { read: [c, doc.phrases.length - 1] }], { seed });
      const tS = r.sim.truth.find((x) => x.pos > doc.phrases[c].tokStart).t;
      const expected = H.range(a + 1, c - 1);
      return {
        rec: H.recoveryUnits(r.sim, r.trace, tS),
        missing: [...expected].filter((p) => !r.f.skipped.has(p)).length,
        extra: [...r.f.skipped].filter((p) => !expected.has(p)).length,
        end: doc.tokens.length - r.f.pos,
      };
    });
    const w = { rec: Math.max(...rows.map((x) => x.rec)), missing: Math.max(...rows.map((x) => x.missing)), extra: Math.max(...rows.map((x) => x.extra)), endErr: Math.max(...rows.map((x) => x.end)) };
    H.note(`${lang} skip 2 paragraphs`, w);
    assert.ok(w.rec <= (lang === 'zh' ? 12 : 10), `recovery ${w.rec}`);
    assert.equal(w.missing + w.extra, 0, 'skipped marks');
  });

  test(`${lang}: going back two sentences / two paragraphs to re-read`, () => {
    const rows = SEEDS.slice(0, 5).map((seed) => {
      const out = {};
      for (const [name, perf] of [
        ['2 sentences', [{ read: [0, doc.sents[8].phEnd - 1] }, { read: [doc.sents[6].phStart, doc.phrases.length - 1] }]],
        ['2 paragraphs', [{ read: [0, lastPh(doc, 3)] }, { read: [firstPh(doc, 2), doc.phrases.length - 1] }]],
      ]) {
        const r = H.runRec(doc, perf, { seed });
        const tB = r.sim.truth.find((x, i) => i > 0 && x.pos < r.sim.truth[i - 1].pos).t;
        out[name] = { rec: H.recoveryUnits(r.sim, r.trace, tB), skipped: r.f.skipped.size, end: doc.tokens.length - r.f.pos };
      }
      return out;
    });
    const w = {};
    for (const k of ['2 sentences', '2 paragraphs']) {
      w[k] = { rec: Math.max(...rows.map((x) => x[k].rec)), skipped: Math.max(...rows.map((x) => x[k].skipped)), endErr: Math.max(...rows.map((x) => x[k].end)) };
    }
    H.note(`${lang} go back`, w);
    for (const k of Object.keys(w)) {
      assert.ok(w[k].rec <= (lang === 'zh' ? 16 : 12), `${k}: recovery ${w[k].rec}`);
      assert.equal(w[k].skipped + w[k].endErr, 0, k);
    }
  });

  test(`${lang}: going back to read a skipped passage clears its skipped marks`, () => {
    const [a, b, c] = lang === 'zh' ? [15, 18, 22] : [16, 19, 23];
    const rows = SEEDS.slice(0, 5).map((seed) => {
      // read ..a, skip a+1..b, read b+1..c, notice, go back and read a+1..end
      const r = H.runRec(doc, [{ read: [0, a] }, { read: [b + 1, c] }, { pause: 1200 }, { read: [a + 1, doc.phrases.length - 1] }], { seed });
      return { stillMarked: [...r.f.skipped].filter((p) => p > a && p <= b), all: [...r.f.skipped] };
    });
    const still = [...new Set(rows.flatMap((x) => x.stillMarked))];
    H.note(`${lang} re-read skipped passage`, { stillMarked: still, texts: still.map((p) => doc.phrases[p].text), seedsAffected: rows.filter((x) => x.stillMarked.length).length });
    assert.deepEqual(still, [], `phrases still marked skipped after being read: ${still.map((p) => doc.phrases[p].text).join(' / ')}`);
  });
}

// Parallel list items: skipping item 2 must mark item 2, not item 3's
// opening words (which share "The ... lesson is about").
const LESSONS = `# Three lessons

The first lesson is about data. Clean data beats clever models, and every team learns this the hard way. This is why we measure before we optimize.

The second lesson is about evaluation. A benchmark that leaks into training tells you nothing about the real world. This is why we measure before we optimize.

The third lesson is about people. Annotators get tired, and tired annotators make noisy labels. This is why we measure before we optimize.

So remember the three lessons: data, evaluation, and people. Thank you.`;
const LESSONS_ZH = `# 三条经验

第一，数据质量比模型结构更重要。很多团队都是在吃过亏之后才明白这一点。所以我们要先测量，再优化。

第二，评估集一定要和训练集分开。如果评估数据泄露到训练里，分数再高也没有意义。所以我们要先测量，再优化。

第三，标注的人会累，累了就会出错。我们需要控制每个人每天的标注数量。所以我们要先测量，再优化。

最后，请大家记住这三条经验：数据、评估和人。谢谢大家。`;

for (const [lang, text] of [['en', LESSONS], ['zh', LESSONS_ZH]]) {
  // Regression: repeated words in the first item must not cover the omitted
  // second item while the tracker re-anchors at the third.
  test(`${lang}: repeated refrain + parallel list: straight read, refrain ad-lib, skip item 2`, () => {
    const doc = H.parseScript(text);
    const P = doc.phrases.length - 1;
    const res = { straight: [], refrain: [], skip: [] };
    for (const seed of SEEDS.slice(0, 5)) {
      let r = H.runRec(doc, [{ read: [0, P] }], { seed, errRate: 0.05 });
      res.straight.push({ acc: H.phraseAccuracy(doc, r.sim, r.trace).acc, sk: r.f.skipped.size, end: doc.tokens.length - r.f.pos });
      const p2 = firstPh(doc, 1);
      r = H.runRec(doc, [{ read: [0, p2 - 1] }, { say: lang === 'zh' ? '我再说一遍，所以我们要先测量，再优化，这一点非常重要' : 'and again, this is why we measure before we optimize, I cannot stress this enough' }, { read: [p2, p2 + 3] }], { seed });
      res.refrain.push({ drift: H.offScriptDrift(r.sim, r.trace).drift, sk: r.f.skipped.size, end: doc.phrases[p2 + 3].tokEnd - r.f.pos });
      const p3 = firstPh(doc, 2);
      r = H.runRec(doc, [{ read: [0, p2 - 1] }, { read: [p3, P] }], { seed });
      const tS = r.sim.truth.find((x) => x.pos > doc.phrases[p3].tokStart).t;
      const expected = H.range(p2, p3 - 1);
      res.skip.push({
        rec: H.recoveryUnits(r.sim, r.trace, tS),
        missing: [...expected].filter((p) => !r.f.skipped.has(p)).map((p) => doc.phrases[p].text),
        wrong: [...r.f.skipped].filter((p) => !expected.has(p)).map((p) => doc.phrases[p].text),
      });
    }
    const w = {
      straightAcc: Math.min(...res.straight.map((x) => x.acc)),
      straightSkipped: Math.max(...res.straight.map((x) => x.sk)),
      refrainDrift: Math.max(...res.refrain.map((x) => x.drift)),
      skipRecovery: Math.max(...res.skip.map((x) => x.rec)),
      skipMissing: [...new Set(res.skip.flatMap((x) => x.missing))],
      skipWrong: [...new Set(res.skip.flatMap((x) => x.wrong))],
    };
    H.note(`${lang} lessons`, w);
    assert.ok(w.straightAcc >= 0.95 && w.straightSkipped === 0, 'straight read');
    assert.ok(w.refrainDrift <= 3, `refrain ad-lib drift ${w.refrainDrift}`);
    assert.deepEqual(w.skipWrong, [], 'read phrases marked skipped');
    assert.deepEqual(w.skipMissing, [], 'skipped phrases not marked');
  });
}

for (const [lang, doc] of [['en', EN], ['zh', ZH]]) {
  test(`${lang}: starting at paragraph 3 re-locates quickly (skip marks reported)`, () => {
    const rows = [1, 2, 3, 4].map((para) => SEEDS.slice(0, 4).map((seed) => {
      const p0 = firstPh(doc, para);
      const r = H.runRec(doc, [{ read: [p0, doc.phrases.length - 1] }], { seed });
      const early = r.f.events.filter((e) => e.to > 0 && e.to < doc.phrases[p0].tokStart).length;
      return { para, rec: H.recoveryUnits(r.sim, r.trace, 0), early, marked: r.f.skipped.size, end: doc.tokens.length - r.f.pos };
    })).flat();
    const w = { rec: Math.max(...rows.map((x) => x.rec)), wrongEarlyMoves: Math.max(...rows.map((x) => x.early)), markedBeforeStart: Math.max(...rows.map((x) => x.marked)), endErr: Math.max(...rows.map((x) => x.end)) };
    H.note(`${lang} start mid-script`, w);
    assert.ok(w.rec <= (lang === 'zh' ? 12 : 10), `recovery ${w.rec}`);
    assert.equal(w.wrongEarlyMoves, 0);
    assert.equal(w.endErr, 0);
  });
}

test.after(() => H.printNotes('tracker-skips'));
