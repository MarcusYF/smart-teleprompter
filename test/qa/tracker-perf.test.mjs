// Long scripts (5,000+ tokens, large English vocabulary) and very short
// scripts. Budget: every speech event well under 5 ms on a laptop.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

// Deterministic long scripts: pseudo-English words from syllables (a big
// vocabulary exercises the Levenshtein path of tokenSim) and random common
// Han characters.
const rand = H.rng(12345);
const pick = (a) => a[Math.floor(rand() * a.length)];
const SYL = ['ka', 'lo', 'mer', 'vin', 'tes', 'sa', 'ra', 'bel', 'dor', 'fi', 'gan', 'ho', 'jun', 'kel', 'lin', 'mo', 'nar', 'pel', 'qui', 'ros', 'sen', 'tar', 'ul', 'vex', 'wen', 'yor', 'zan', 'tion', 'ment', 'ing'];
const STOP = ['the', 'of', 'and', 'to', 'a', 'in', 'is', 'that', 'we', 'it', 'for', 'with', 'as', 'on', 'this'];
const VOCAB = Array.from({ length: 2500 }, () => {
  let w = '';
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) w += pick(SYL);
  return w;
});
function enScript(nTok) {
  const paras = [];
  let toks = 0;
  while (toks < nTok) {
    const sents = [];
    for (let s = 0; s < 4; s++) {
      const len = 8 + Math.floor(rand() * 12);
      const ws = [];
      for (let i = 0; i < len; i++) ws.push(rand() < 0.4 ? pick(STOP) : pick(VOCAB));
      ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
      sents.push(ws.join(' ') + '.');
      toks += len;
    }
    paras.push(sents.join(' '));
  }
  return paras.join('\n\n');
}
const HAN = [...'的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府除王族往织团更群难院青准非领'];
function zhScript(nTok) {
  const paras = [];
  let toks = 0;
  while (toks < nTok) {
    const sents = [];
    for (let s = 0; s < 4; s++) {
      const len = 10 + Math.floor(rand() * 20);
      let t = '';
      for (let i = 0; i < len; i++) {
        t += pick(HAN);
        if (i === Math.floor(len / 2)) t += '，';
      }
      sents.push(t + '。');
      toks += len;
    }
    paras.push(sents.join(''));
  }
  return paras.join('\n\n');
}

const EN_LONG = H.parseScript(enScript(6000), { lang: 'en' });
const ZH_LONG = H.parseScript(zhScript(6000), { lang: 'zh' });

// Timing is noisy when node --test runs files in parallel: report the best
// of three repetitions (each one a fresh Follower).
function timeEvents(doc, sim, reps = 3) {
  let best = null;
  for (let r = 0; r < reps; r++) {
    const m = timeOnce(doc, sim);
    if (!best || m.p95 < best.p95) best = { ...m, max: best ? Math.min(best.max, m.max) : m.max };
    else best.max = Math.min(best.max, m.max);
  }
  return best;
}
function timeOnce(doc, sim) {
  const f = new H.Follower(doc);
  const ts = [];
  for (const ev of sim.events) {
    const t0 = process.hrtime.bigint();
    f.onSpeech(ev.kind, ev.text, ev.t);
    f.view(ev.t);
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sorted = ts.slice().sort((a, b) => a - b);
  return {
    N: doc.tokens.length, vocab: doc.vocab.length, events: ts.length,
    mean: +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(3),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(2),
    end: f.pos,
  };
}
// Chrome re-decoding: every other interim changes the first word of a long
// utterance, forcing a full recomputation of the utterance.
function firstWordRewrite(sim, lang) {
  let k = 0;
  return { ...sim, events: sim.events.map((e) => (e.kind === 'interim' && e.text && ++k % 2 ? { ...e, text: (lang === 'zh' ? '嗯' : 'uh ') + e.text } : e)) };
}

for (const [lang, doc] of [['en', EN_LONG], ['zh', ZH_LONG]]) {
  test(`${lang}: ${doc.tokens.length}-token script, normal reading, per-event cost`, () => {
    timeEvents(doc, H.recognize(doc, [{ read: [0, 10] }], { seed: 9 })); // warm-up
    const m = timeEvents(doc, H.recognize(doc, [{ read: [0, 40] }], { seed: 1 }));
    H.note(`${lang} long read`, m);
    assert.ok(m.mean < 1 && m.p95 < 2.5, JSON.stringify(m));
  });

  test(`${lang}: ${doc.tokens.length}-token script, 40-60 word utterances with rewrites`, () => {
    const m = timeEvents(doc, H.recognize(doc, [{ read: [0, 40] }], { seed: 1, rewriteRate: 0.4, rewriteSpan: 5, finalEvery: [40, 60] }));
    const w = timeEvents(doc, firstWordRewrite(H.recognize(doc, [{ read: [0, 40] }], { seed: 1, finalEvery: [50, 70] }), lang));
    H.note(`${lang} long utterances`, { rewrites: m, firstWordRewrite: w });
    assert.ok(m.p95 < 2.5, `rewrites ${JSON.stringify(m)}`);
    assert.ok(w.max < 5, `first-word rewrites ${JSON.stringify(w)}`);
  });

  test(`${lang}: ${doc.tokens.length}-token script, far jumps (start -> end -> start)`, () => {
    const P = doc.phrases.length;
    const sim = H.recognize(doc, [{ read: [0, 5] }, { read: [P - 30, P - 22] }, { read: [2, 8] }], { seed: 1 });
    let worst = { ms: Infinity };
    let f;
    for (let rep = 0; rep < 3; rep++) {
      f = new H.Follower(doc);
      let w = { ms: 0 };
      for (const ev of sim.events) {
        const t0 = process.hrtime.bigint();
        f.onSpeech(ev.kind, ev.text, ev.t);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > w.ms) w = { ms: +ms.toFixed(2), text: ev.text.slice(-30) };
      }
      if (w.ms < worst.ms) worst = w;
    }
    const jumps = f.events.filter((e) => e.how === 'jump' || e.how === 'back').map((e) => `${e.how}:${e.from}->${e.to}`);
    H.note(`${lang} far jumps`, { worstEventMs: worst.ms, jumps });
    assert.ok(worst.ms < 5, `slowest event ${worst.ms} ms (${jumps.join(' ')})`);
  });

  // After a long Q&A (the display held, ~160 words buffered) the speaker
  // jumps to the conclusion, or clicks to the last slide.
  test(`${lang}: ${doc.tokens.length}-token script, long Q&A then far jump / far slide change`, () => {
    const P = doc.phrases.length;
    const qa = lang === 'zh'
      ? '好我们回答几个问题这个问题问得很好我觉得关键在于数据和评估大家平时做实验的时候一定要注意记录每一次的结果否则很难复现'.repeat(4)
      : Array.from({ length: 16 }, () => 'that is a great question and honestly it depends on your data and your evaluation').join(' ');
    const sim = H.recognize(doc, [{ read: [0, 5] }, { say: qa }, { read: [P - 30, P - 22] }], { seed: 2 });
    const pre = H.recognize(doc, [{ read: [0, 5] }, { say: qa }], { seed: 2 });
    let worst = { ms: Infinity };
    let slideMs = Infinity;
    let f;
    let f2;
    for (let rep = 0; rep < 3; rep++) {
      f = new H.Follower(doc);
      let w = { ms: 0 };
      for (const ev of sim.events) {
        const t0 = process.hrtime.bigint();
        f.onSpeech(ev.kind, ev.text, ev.t);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > w.ms) w = { ms: +ms.toFixed(2), kind: ev.kind };
      }
      if (w.ms < worst.ms) worst = w;
      // same Q&A, then a click to the last slide instead of speech
      f2 = new H.Follower(doc);
      for (const ev of pre.events) f2.onSpeech(ev.kind, ev.text, ev.t);
      const t0 = process.hrtime.bigint();
      f2.slideChanged(doc.phrases[P - 20].tokStart, doc.tokens.length, 1e7);
      slideMs = Math.min(slideMs, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    H.note(`${lang} Q&A then far jump`, { worstEventMs: worst.ms, slideChangeMs: +slideMs.toFixed(2), buffered: f2.recent.length, jumps: f.events.filter((e) => e.how !== 'advance').map((e) => `${e.how}:${e.from}->${e.to}`) });
    assert.ok(worst.ms < 5, `slowest speech event ${worst.ms} ms`);
    assert.ok(slideMs < 5, `slideChanged took ${slideMs.toFixed(1)} ms`);
  });

  test(`${lang}: ${doc.tokens.length}-token script, slide change to the last slide`, () => {
    const target = doc.phrases[doc.phrases.length - 20].tokStart;
    let ms = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const f = new H.Follower(doc);
      f.onSpeech('final', doc.phrases.slice(0, 4).map((p) => p.text).join(doc.lang === 'zh' ? '' : ' '), 1000);
      const t0 = process.hrtime.bigint();
      f.slideChanged(target, doc.tokens.length, 2000);
      ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    H.note(`${lang} far slide change`, { ms: +ms.toFixed(2), span: target - 4 });
    assert.ok(ms < 5, `slideChanged over ${target} tokens took ${ms.toFixed(1)} ms`);
  });
}

test('short scripts: 1-2 sentences, empty, headings only, cue only', () => {
  const cases = {
    enOne: 'Thank you all for coming today.',
    enTwo: 'Good morning. Today we talk about alignment.',
    zhOne: '谢谢大家。',
    zhTwo: '大家好。今天我们讨论对齐。',
    enWord: 'Hello.',
    empty: '',
    onlyHeading: '# Title\n\n// look up\n\n[slide 2]',
    cueOnly: 'Hello [[pause]] world.',
  };
  const problems = [];
  for (const [name, text] of Object.entries(cases)) {
    const doc = H.parseScript(text);
    const N = doc.tokens.length;
    const zh = doc.lang === 'zh';
    const perfs = N ? {
      read: [{ read: [0, doc.phrases.length - 1] }],
      adlibFirst: [{ say: zh ? '嗯我先说两句题外话今天天气不错' : 'um let me first say something about the weather' }, { read: [0, doc.phrases.length - 1] }],
      readThenQA: [{ read: [0, doc.phrases.length - 1] }, { say: zh ? '好的现在开始提问环节有问题可以举手' : 'okay now we open the floor for questions please raise your hand' }],
      twice: [{ read: [0, doc.phrases.length - 1] }, { read: [0, doc.phrases.length - 1] }],
    } : { adlib: [{ say: 'hello there everyone' }] };
    for (const [pn, perf] of Object.entries(perfs)) {
      try {
        const r = H.runRec(doc, perf, { seed: 3 });
        r.f.view(r.sim.duration);
        if (r.f.pos !== N) problems.push(`${name}/${pn}: ended at ${r.f.pos}/${N}`);
        if (pn !== 'adlibFirst' && r.f.skipped.size) problems.push(`${name}/${pn}: skipped ${[...r.f.skipped]}`);
        if (pn === 'adlibFirst' && r.f.skipped.size) problems.push(`${name}/${pn}: read phrase(s) ${[...r.f.skipped]} left marked skipped`);
      } catch (e) {
        problems.push(`${name}/${pn}: ${e.message}`);
      }
    }
  }
  H.note('short scripts', { problems });
  assert.deepEqual(problems, []);
});

test.after(() => H.printNotes('tracker-perf'));
