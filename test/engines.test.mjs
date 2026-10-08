// Web Speech engine bookkeeping against a fake recognizer that mimics
// Chrome's event shape (cumulative result list, resultIndex, restarts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSpeechEngine } from '../public/lib/engines.js';

class FakeRecognition {
  static instances = [];
  constructor() {
    FakeRecognition.instances.push(this);
    this.results = [];
  }
  start() {
    this.started = true;
    queueMicrotask(() => this.onstart && this.onstart());
  }
  stop() {
    this.ended = true;
    this.onend && this.onend();
  }
  // helpers used by the test
  push(transcript, isFinal) {
    this.results.push({ isFinal, 0: { transcript }, length: 1 });
    this._emit(this.results.length - 1);
  }
  revise(i, transcript, isFinal) {
    this.results[i] = { isFinal, 0: { transcript }, length: 1 };
    this._emit(i);
  }
  _emit(resultIndex) {
    this.onresult({ resultIndex, results: this.results });
  }
}

function setup() {
  FakeRecognition.instances = [];
  globalThis.window = { webkitSpeechRecognition: FakeRecognition };
  const log = [];
  const eng = new WebSpeechEngine({
    lang: 'en-US',
    onInterim: (t) => log.push(['i', t]),
    onFinal: (t) => log.push(['f', t]),
    onState: (s, d) => log.push(['s', s, d]),
  });
  return { eng, log };
}

test('interim then final, then next utterance', () => {
  const { eng, log } = setup();
  eng.start();
  const r = FakeRecognition.instances[0];
  r.push('good', false);
  r.revise(0, 'good afternoon', false);
  r.revise(0, 'good afternoon everyone', true);
  r.push('today', false);
  r.revise(1, 'today I want', false);
  const finals = log.filter((x) => x[0] === 'f').map((x) => x[1]);
  const interims = log.filter((x) => x[0] === 'i').map((x) => x[1]);
  assert.deepEqual(finals, ['good afternoon everyone']);
  assert.equal(interims[interims.length - 1], 'today I want');
  assert.equal(interims[interims.length - 3], '', 'interim clears when the utterance is final');
});

test('two finals in one event are both committed in order', () => {
  const { eng, log } = setup();
  eng.start();
  const r = FakeRecognition.instances[0];
  r.results.push({ isFinal: true, 0: { transcript: 'one two' }, length: 1 });
  r.results.push({ isFinal: true, 0: { transcript: ' three four' }, length: 1 });
  r._emit(0);
  assert.deepEqual(log.filter((x) => x[0] === 'f').map((x) => x[1]), ['one two', ' three four']);
});

test('a later final behind a pending interim waits for its turn', () => {
  const { eng, log } = setup();
  eng.start();
  const r = FakeRecognition.instances[0];
  r.results.push({ isFinal: false, 0: { transcript: 'alpha' }, length: 1 });
  r.results.push({ isFinal: true, 0: { transcript: ' beta' }, length: 1 });
  r._emit(0);
  assert.equal(log.filter((x) => x[0] === 'f').length, 0);
  r.revise(0, 'alpha', true);
  assert.deepEqual(log.filter((x) => x[0] === 'f').map((x) => x[1]), ['alpha', ' beta']);
});

test('recognizer restarts after onend while listening, with fresh bookkeeping', async () => {
  const { eng, log } = setup();
  eng.start();
  const r1 = FakeRecognition.instances[0];
  r1.push('first session', true);
  r1.onend();
  await new Promise((res) => setTimeout(res, 200));
  const r2 = FakeRecognition.instances[1];
  assert.ok(r2 && r2.started, 'restarted');
  r2.push('second session', true);
  assert.deepEqual(log.filter((x) => x[0] === 'f').map((x) => x[1]), ['first session', 'second session']);
  eng.stop();
  assert.ok(log.some((x) => x[0] === 's' && x[1] === 'stopped'));
});

test('permission errors stop listening; phrases-not-supported retries without hints', async () => {
  const { eng, log } = setup();
  eng.terms = ['PPO'];
  eng.start();
  const r1 = FakeRecognition.instances[0];
  r1.onerror({ error: 'phrases-not-supported' });
  assert.deepEqual(eng.terms, []);
  r1.onend();
  await new Promise((res) => setTimeout(res, 200));
  const r2 = FakeRecognition.instances[1];
  r2.onerror({ error: 'not-allowed' });
  r2.onend();
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(FakeRecognition.instances.length, 2, 'no restart after a permission error');
  assert.ok(log.some((x) => x[0] === 's' && x[1] === 'error' && x[2] === 'not-allowed'));
});
