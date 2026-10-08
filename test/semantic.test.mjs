// Follower + semantic client behavior with a mocked Jev server (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript } from '../public/lib/script.js';
import { Follower } from '../public/lib/follower.js';
import { SemanticClient } from '../public/lib/semantic-client.js';

const ZH = parseScript(readFileSync(new URL('../public/samples/zh-demo.md', import.meta.url), 'utf8'));
const EN = parseScript(readFileSync(new URL('../public/samples/en-demo.md', import.meta.url), 'utf8'));

function readPhrases(f, doc, a, b, t0 = 0) {
  let t = t0;
  for (let p = a; p <= b; p++) {
    t += 900;
    f.onSpeech('final', doc.phrases[p].text, t);
  }
  return t;
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const out = handler(url, body);
    return { ok: true, status: 200, json: async () => out };
  };
  return calls;
}

const choice = (c, conf = 0.9) => ({ choice: c, confidence: conf, probabilities: { [c]: conf } });

test('jumped_ahead with a confident line re-anchors and marks skipped phrases', () => {
  const f = new Follower(EN);
  const t = readPhrases(f, EN, 0, 3);
  f.onSpeech('interim', 'so here is something completely different about', t + 500);
  const pos = f.pos;
  const act = f.applySemantic({ relation: choice('jumped_ahead'), where: choice('P11', 0.8), onScript: 0.9, covered: 0.1, requestPos: pos }, t + 800);
  assert.equal(act, 'jump-forward');
  assert.equal(f.pos, EN.phrases[11].tokStart);
  for (let p = 4; p <= 10; p++) assert.ok(f.skipped.has(p), `phrase ${p} skipped`);
});

test('adlib holds position', () => {
  const f = new Follower(EN);
  const t = readPhrases(f, EN, 0, 3);
  f.onSpeech('interim', 'and I remember the first time I tried this with my class it was chaos', t + 500);
  const pos = f.pos;
  const act = f.applySemantic({ relation: choice('adlib_related'), where: choice('none'), onScript: 0.1, covered: 0.1, requestPos: pos }, t + 800);
  assert.equal(act, 'hold');
  assert.equal(f.pos, pos);
});

test('paraphrase pointing back inside the current sentence does not move back', () => {
  const f = new Follower(ZH);
  const t = readPhrases(f, ZH, 0, 5);
  // lexical tracker is somewhere inside sentence 2; speaker paraphrases it
  f.onSpeech('interim', '说白了就是人喜欢的答案给它加分', t + 400);
  f.onSpeech('interim', '说白了就是人喜欢的答案给它加分不喜欢的扣分啊对吧', t + 900);
  const cur = f.currentPhrase(t + 900);
  const sentStart = ZH.sents[ZH.phrases[cur].sent].phStart;
  const before = f.pos;
  if (cur > sentStart) {
    f.run = Math.max(f.run, 1);
    const act = f.applySemantic({ relation: choice('paraphrase'), where: choice(`P${sentStart}`, 0.7), onScript: 0.8, covered: 0.3, requestPos: f.pos }, t + 1000);
    assert.equal(act, 'hold');
    assert.equal(f.pos, before);
  }
});

test('paraphrase with the sentence covered advances to the next sentence', () => {
  const f = new Follower(ZH);
  const t = readPhrases(f, ZH, 0, 4);
  f.onSpeech('interim', '说白了就是人喜欢的给加分不喜欢的就扣分', t + 800);
  f.run = Math.max(f.run, 1);
  const cur = f.currentPhrase(t + 800);
  const sent = ZH.sents[ZH.phrases[cur].sent];
  const act = f.applySemantic({ relation: choice('paraphrase'), where: choice('none'), onScript: 0.8, covered: 0.8, requestPos: f.pos }, t + 900);
  assert.equal(act, 'advance-sentence');
  assert.equal(f.pos, ZH.sents[sent.idx + 1].tokStart);
  assert.ok(f.coveredSents.has(sent.idx));
});

test('stale judgments are ignored once the speaker is back on script', () => {
  const f = new Follower(EN);
  const t = readPhrases(f, EN, 0, 5);
  const act = f.applySemantic({ relation: choice('jumped_ahead'), where: choice('P20', 0.9), onScript: 0.9, requestPos: f.pos }, t + 100);
  assert.equal(act, 'stale');
});

test('skip check: covered sentences are unmarked, reminder names the key sentence', async () => {
  const f = new Follower(ZH);
  let t = readPhrases(f, ZH, 0, 7);
  t = readPhrases(f, ZH, 17, 21, t);
  const skippedBefore = [...f.skipped];
  assert.ok(skippedBefore.length >= 4);
  const calls = mockFetch((url, body) => {
    assert.ok(url.endsWith('/api/jev/skipped'));
    return {
      sentences: body.sentences.map((s) => ({
        text: s,
        important: s.includes('噪声') ? 0.85 : 0.3,
        covered: s.includes('人类的判断') ? 0.8 : 0.05,
      })),
    };
  });
  const reminders = [];
  const sc = new SemanticClient(ZH, f, { base: 'http://x', onSkipReminder: (r) => reminders.push(r) });
  await sc._checkSkips([...f.skipped].sort((a, b) => a - b));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.spoken.length > 10, 'recent speech is sent');
  // only the skipped part of a sentence is judged; a covered part is unmarked
  assert.ok(calls[0].body.sentences.every((x) => x.length < 40), 'fragments, not whole passages');
  const coveredSent = ZH.sents.find((s) => s.text.includes('人类的判断'));
  for (let p = coveredSent.phStart; p < coveredSent.phEnd; p++) assert.ok(!f.skipped.has(p), 'covered part unmarked');
  assert.equal(reminders.length, 1);
  assert.ok(reminders[0].text.includes('噪声'));
});

test('semantic client waits for enough off-script speech before asking', () => {
  const f = new Follower(EN);
  const t = readPhrases(f, EN, 0, 3);
  const calls = mockFetch(() => ({ relation: choice('adlib_related'), where: choice('none'), onScript: 0.1, covered: 0.1 }));
  const sc = new SemanticClient(EN, f, { base: 'http://x', now: () => t + 2000 });
  f.onSpeech('interim', 'you know what', t + 300);
  sc.check(t + 2000);
  assert.equal(calls.length, 0, 'three words are not enough');
  f.onSpeech('interim', 'you know what I actually tried this once with my students', t + 900);
  sc.check(t + 4000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.offScript.split(' ').length >= 5);
});
