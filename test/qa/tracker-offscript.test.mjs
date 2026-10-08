// Off-script episodes: related ad-libs, audience Q&A, resuming mid-phrase.
// The display should hold while the speaker is off script, even when the
// ad-lib reuses words from the upcoming text, and pick up quickly when the
// speaker returns to the script (at the hold point or a little later).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

const { EN, ZH } = H;
const SEEDS = [1, 2, 3, 4, 5];

import { EN_RELATED, ZH_RELATED, EN_QA, ZH_QA } from './tracker-corpus.mjs';

// Read up to `stopPh` (optionally stopping mid-phrase), go off script, then
// resume at `resume` ('hold' | 'mid' | 'next') and read 4 more phrases.
function episode(doc, stopPh, speech, resume, seed, { midStop = false } = {}) {
  const ph = doc.phrases[stopPh];
  const mid = ph.tokStart + Math.floor((ph.tokEnd - ph.tokStart) / 2);
  const hold = midStop ? mid : ph.tokStart;
  const perf = [{ read: [0, stopPh - 1] }];
  if (midStop) perf.push({ readTok: [ph.tokStart, mid] });
  perf.push({ pause: 700 }, { say: speech }, { pause: 900 });
  const resumeTok = resume === 'hold' ? hold : resume === 'mid' ? mid + (midStop ? 2 : 0) : ph.tokEnd;
  const endTok = doc.phrases[stopPh + 4].tokEnd;
  perf.push({ readTok: [resumeTok, endTok] });
  const r = H.runRec(doc, perf, { seed });
  const ad = r.sim.truth.filter((x) => x.mode === 'adlib');
  const tA = ad[0].t;
  const tR = r.sim.truth.find((x) => x.mode === 'read' && x.t > ad[ad.length - 1].t).t;
  const d = H.offScriptDrift(r.sim, r.trace);
  const movesDuring = r.f.events.filter((e) => e.t > tA + 800 && e.t < tR).length;
  const rec = H.recoveryUnits(r.sim, r.trace, tR);
  // phrases before the hold point were read; the resume skipped nothing
  // (except the phrase remainder for 'next', which is legitimately skipped)
  const readSet = H.range(0, doc.tokens[Math.max(0, hold - 1)].phrase);
  for (let p = doc.tokens[resumeTok]?.phrase ?? 0; p <= stopPh + 4; p++) readSet.add(p);
  if (resume === 'next') readSet.delete(stopPh);
  const wrong = H.wrongSkips(doc, r.f, readSet);
  return { fwd: d.fwd, back: d.back, offShare: d.offShare, movesDuring, rec, wrong, end: r.f.pos - endTok };
}

function worst(rows) {
  return {
    fwd: Math.max(...rows.map((x) => x.fwd)),
    back: Math.max(...rows.map((x) => x.back)),
    moves: Math.max(...rows.map((x) => x.movesDuring)),
    rec: Math.max(...rows.map((x) => x.rec)),
    wrongSkips: [...new Set(rows.flatMap((x) => x.wrong))],
    endErr: Math.max(...rows.map((x) => Math.abs(x.end))),
  };
}

const cases = [
  ['en', EN, 16, EN_RELATED, 'related ad-lib (reuses next sentence words)'],
  ['zh', ZH, 15, ZH_RELATED, 'related ad-lib (reuses next sentence words)'],
  ['en', EN, 14, EN_QA, 'audience Q&A answer (talk vocabulary)'],
  ['zh', ZH, 12, ZH_QA, 'audience Q&A answer (talk vocabulary)'],
];

for (const [lang, doc, stopPh, speech, what] of cases) {
  test(`${lang}: ${what} holds position`, () => {
    const rows = SEEDS.map((seed) => episode(doc, stopPh, speech, 'hold', seed));
    const w = worst(rows);
    H.note(`${lang} ${what}`, w);
    assert.ok(w.fwd <= 3, `display crept ${w.fwd} tokens forward while off script`);
    assert.ok(w.back <= 3, `display moved ${w.back} tokens back while off script`);
    assert.ok(w.moves <= 1, `${w.moves} display moves while off script`);
    assert.ok(w.rec <= (lang === 'zh' ? 12 : 8), `recovery took ${w.rec} units`);
    assert.equal(w.endErr, 0, 'final position');
  });
}

for (const [lang, doc, stopPh, speech] of [['en', EN, 14, EN_QA], ['zh', ZH, 12, ZH_QA]]) {
  for (const resume of ['mid', 'next']) {
    test(`${lang}: stop mid-phrase, Q&A, resume ${resume === 'mid' ? 'two words later' : 'at the next phrase'}`, () => {
      const rows = SEEDS.map((seed) => episode(doc, stopPh, speech, resume, seed, { midStop: true }));
      const w = worst(rows);
      H.note(`${lang} Q&A resume ${resume}`, w);
      assert.ok(w.fwd <= 3, `display crept ${w.fwd} tokens forward while off script`);
      // zh 15: resuming past unread text right after off-script speech needs a
      // 7-character streak (follower longStreak), one more than a plain resume
      assert.ok(w.rec <= (lang === 'zh' ? 15 : 9), `recovery took ${w.rec} units`);
      assert.deepEqual(w.wrongSkips, [], 'phrases that were read are not marked skipped');
      assert.equal(w.endErr, 0, 'final position');
    });
  }
}

// The unrelated ad-libs of the existing suite, as a control (should pass).
test('control: unrelated ad-libs hold (en, zh)', () => {
  const en = SEEDS.map((seed) => episode(EN, 7, 'and I think this is really important because in my own experience with students the annotations were all over the place', 'hold', seed));
  const zh = SEEDS.map((seed) => episode(ZH, 8, '我记得第一次在课上做这个实验的时候学生们完全没有共识特别有意思大家可以想一想为什么会这样', 'hold', seed));
  const we = worst(en);
  const wz = worst(zh);
  H.note('control unrelated ad-lib en', we);
  H.note('control unrelated ad-lib zh', wz);
  assert.ok(we.fwd <= 3 && wz.fwd <= 3);
  assert.ok(we.rec <= 8 && wz.rec <= 12);
});

// Mechanism check: one coincidental strong match must not end the
// off-script episode (follower status flips to 'tracking' and the next
// event may then move the display without the two-match guard).
test('en: a single coincidental content word does not end an off-script episode', () => {
  const f = new H.Follower(EN);
  let t = 0;
  const say = (text) => {
    const words = text.split(' ');
    for (let i = 1; i <= words.length; i++) f.onSpeech('interim', words.slice(0, i).join(' '), (t += 400));
    f.onSpeech('final', text, (t += 100));
  };
  say(EN.phrases.slice(0, 16).map((p) => p.text).join(' ').replace(/[,.:]/g, ''));
  const hold = f.pos;
  say('so before we go on let me tell you a story from my class');
  assert.equal(f.status, 'offscript');
  // "reward" matches a word 4 tokens ahead ("train a reward model")
  say('the reward');
  const afterOne = { status: f.status, pos: f.pos };
  say('was that nobody agreed at all');
  H.note('single coincidental match', { hold, afterOne, statusAfter: f.status, posAfter: f.pos });
  assert.equal(afterOne.status, 'offscript', 'status after one stray match');
  assert.ok(f.pos - hold <= 1, `display moved ${f.pos - hold} tokens on a stray match`);
});

test.after(() => H.printNotes('tracker-offscript'));
