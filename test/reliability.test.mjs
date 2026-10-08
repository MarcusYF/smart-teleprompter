import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseScript } from '../public/lib/script.js';
import { BuildController, slideIndex } from '../public/lib/builds.js';
import { Follower } from '../public/lib/follower.js';
import { SemanticClient } from '../public/lib/semantic-client.js';
import { NativeEngine, MicMeter } from '../public/lib/engines.js';
import { NativeAsr } from '../server/native-asr.mjs';
import { Slides } from '../server/slides.mjs';
import { ScriptStore, JsonCache } from '../server/store.mjs';
import { checkRequest } from '../server/request-security.mjs';
import { ControlLease } from '../server/control-lease.mjs';

const text = '[slide 1]\nAlpha beta gamma delta.\n[click x3] Epsilon zeta eta theta.\n\n[slide 2]\nIota kappa lambda mu.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function builds(send = async () => {}) {
  const doc = parseScript(text, { lang: 'en' }), idx = slideIndex(doc);
  const ctl = new BuildController(doc, { range: idx.range, markers: idx.markers, send, options: { gapMs: 30 } });
  ctl.slideState({ slide: 1, playing: true, total: 2 });
  return { doc, ctl, reach: () => ctl.view({ pos: doc.builds[0].tok, status: 'tracking' }, true) };
}

for (const mode of ['pause', 'stop', 'dispose', 'watcher-stop']) {
  test(`queued clicks cancelled on ${mode}`, async () => {
    const sent = [], { ctl, reach } = builds(async () => { sent.push('next'); });
    reach();
    const before = sent.length;
    if (mode === 'pause') { ctl.builds = false; ctl.advance = false; }
    if (mode === 'stop') ctl.setListening(false);
    if (mode === 'dispose') ctl.dispose();
    if (mode === 'watcher-stop') ctl.slideState({ playing: false, slide: 1 });
    await sleep(120);
    assert.equal(sent.length, before);
    assert.equal(ctl.status().done, 1);
  });
}

test('pending clicks are not persisted as completed; failed send halts the entire queue', async () => {
  const d = deferred(); let sends = 0;
  const { ctl, reach } = builds(async () => { sends++; await d.promise; throw Error('automation denied'); });
  reach();
  assert.equal(ctl.status().done, 0);
  assert.equal(ctl.markerState(0, 1), 'next');
  d.resolve(); await sleep(10);
  assert.equal(ctl.done, 0);
  assert.equal(ctl.status().pending, 0);
  assert.match(ctl.error, /automation denied/);
  reach(); await sleep(80);
  assert.equal(sends, 1);
});

test('failed request for a previous slide cannot poison the new slide', async () => {
  const d = deferred(), { ctl, reach } = builds(async () => { await d.promise; throw Error('late failure'); });
  reach(); ctl.slideState({ slide: 2, playing: true, total: 2 });
  d.resolve(); await sleep(5);
  assert.equal(ctl.error, null); assert.equal(ctl.done, 0);
});

test('six consecutive formulas parse without losing their readings', () => {
  const doc = parseScript('$a$ $b$ $c$ $d$ $e$ $f$.', { lang: 'en' });
  assert.ok(doc.phrases.length > 1);
  assert.equal(doc.phrases.flatMap(p => p.pieces).filter(p => p.kind === 'math').length, 6);
  assert.ok(doc.tokens.length > 0);
});

const semanticDoc = () => parseScript('The deadline is Friday and the assignment has three mandatory sections.\n\nPlease submit your files through the course website.', { lang: 'en' });
const answer = { relation: { choice: 'paraphrase', probabilities: { paraphrase: .95 } }, where: { choice: 'none' }, covered: .95, onScript: .9 };
test('partial or low-confidence paraphrase cannot exempt the whole sentence', () => {
  for (const overrides of [{ covered: .05 }, { relation: { choice: 'paraphrase', probabilities: { paraphrase: .1 } } }, { onScript: .1 }]) {
    const f = new Follower(semanticDoc()); f.run = 8; f.offEpisode = true;
    assert.equal(f.applySemantic({ ...answer, ...overrides, requestPos: 0 }), 'hold');
    assert.equal(f.coveredSents.size, 0);
  }
});

for (const mode of ['disabled', 'suspended', 'disposed', 'reset', 'manual-jump', 'slide-change']) {
  test(`late Jev judgment discarded after ${mode}`, async (t) => {
    const d = deferred(), savedFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = savedFetch; });
    globalThis.fetch = () => d.promise;
    const doc = semanticDoc(), f = new Follower(doc); f.run = 8; f.offEpisode = true;
    const judgments = [], client = new SemanticClient(doc, f, { onJudgment: j => judgments.push(j) });
    const q = client._query('a paraphrase', Date.now());
    if (mode === 'disabled') client.enabled = false;
    if (mode === 'suspended') client.suspend();
    if (mode === 'disposed') client.dispose();
    if (mode === 'reset') f.reset();
    if (mode === 'manual-jump') f.jumpTo(0);
    if (mode === 'slide-change') f.slideChanged(0, doc.tokens.length);
    f.run = 8; f.offEpisode = true;
    d.resolve({ ok: true, json: async () => answer }); await q;
    assert.equal(f.pos, 0); assert.equal(judgments.length, 0);
    client.dispose();
  });
}

test('late skip response cannot delete marks or remind after re-reading', async (t) => {
  const d = deferred(), old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = () => d.promise;
  const doc = semanticDoc(), f = new Follower(doc), reminders = [];
  f.skipped.add(0);
  const c = new SemanticClient(doc, f, { onSkipReminder: r => reminders.push(r) });
  const q = c._checkSkips([0]); f.jumpTo(0); f.skipped.add(0);
  d.resolve({ ok: true, json: async () => ({ sentences: [{ important: .99, covered: 0 }] }) }); await q;
  assert.equal(reminders.length, 0); assert.ok(f.skipped.has(0)); c.dispose();
});

test('native frontend ignores events from other sessions and delayed start errors', async (t) => {
  const d = deferred(), old = globalThis.fetch, states = [], finals = [];
  t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = (url) => url.endsWith('/start') ? d.promise : Promise.resolve({});
  const e = new NativeEngine({ lang: 'en-US', text: '', onState: s => states.push(s), onFinal: x => finals.push(x) });
  const start = e.start();
  e.handle({ type: 'final', text: 'old words', sessionId: 'old-session' });
  e.handle({ type: 'status', state: 'stopped', sessionId: 'old-session' });
  assert.ok(e.active); assert.equal(finals.length, 0);
  e.handle({ type: 'final', text: 'current words', sessionId: e.sessionId });
  assert.deepEqual(finals, ['current words']);
  e.stop(); d.resolve({ ok: false, json: async () => ({ error: 'late error' }) }); await start;
  assert.deepEqual(states, ['stopped']);
});

test('native backend replacement ignores old exit and stop is session-scoped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-asr-test-')), helper = join(dir, 'helper');
  writeFileSync(helper, '#!/bin/sh\nprintf \'{"type":"status","state":"listening"}\\n\'\nread line\nsleep 0.05\n'); chmodSync(helper, 0o755);
  const n = new NativeAsr(helper), events = [];
  t.after(async () => { n.stop(); await sleep(100); rmSync(dir, { recursive: true }); });
  n.on('msg', m => events.push(m));
  n.start({ sessionId: 'first' }); await sleep(30);
  n.start({ sessionId: 'second' }); await sleep(130);
  n.stop('first'); assert.ok(n.proc);
  assert.ok(!events.some(e => e.state === 'stopped' && e.sessionId === 'second'));
  assert.ok(events.every(e => e.sessionId));
});

test('split UTF-8 chunks preserve Chinese recognition text', async () => {
  const stdout = new PassThrough(), lines = [], n = new NativeAsr('/unused');
  n._pipe({ stdout }, m => lines.push(m));
  const bytes = Buffer.from('{"text":"你好世界"}\n');
  for (const byte of bytes) stdout.write(Buffer.from([byte]));
  stdout.end(); assert.equal(lines[0].text, '你好世界');
});

test('stopping during mic permission prompt releases the late stream', async (t) => {
  const d = deferred(), old = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); let stops = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => d.promise } } });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'navigator', old); else delete globalThis.navigator; });
  const meter = new MicMeter(), start = meter.start(); meter.stop();
  d.resolve({ getTracks: () => [{ stop: () => { stops++; } }] });
  assert.equal(await start, false); assert.equal(stops, 1); assert.equal(meter.stream, null);
});

test('a deck change at the same slide number is broadcast', () => {
  const s = new Slides(), states = []; s.source = 'keynote'; s.on('state', st => states.push(st));
  s._update({ playing: true, slide: 1, total: 5, doc: 'A' });
  s._update({ playing: true, slide: 1, total: 5, doc: 'B' });
  assert.equal(states.length, 2); assert.equal(states[1].doc, 'B');
});

test('stale slide controls are rejected before any Apple Event', async () => {
  const s = new Slides(); s.source = 'keynote'; s._update({ playing: true, slide: 2, doc: 'B' });
  await assert.rejects(s.control('next', { source: 'keynote', slide: 1, doc: 'A' }), /changed/);
  await assert.rejects(s.control('arbitrary'), /Invalid/);
});

test('local API rejects hostile origins, form payloads and DNS rebinding hosts', () => {
  const req = { method: 'POST', url: '/api/scripts', headers: { host: '127.0.0.1:5217', 'content-type': 'application/json', 'content-length': '20' } };
  assert.equal(checkRequest(req), null);
  assert.equal(checkRequest({ ...req, headers: { ...req.headers, origin: 'http://127.0.0.1:5217' } }), null);
  assert.equal(checkRequest({ ...req, headers: { ...req.headers, origin: 'https://evil.example' } }).status, 403);
  assert.equal(checkRequest({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } }).status, 415);
  assert.equal(checkRequest({ ...req, headers: { ...req.headers, host: 'evil.example:5217' } }).status, 403);
  assert.equal(checkRequest({ ...req, url: '/api/slides/state', headers: { ...req.headers, origin: 'https://reveal.example' } }), null);
});

test('script writes are atomic and preserve stored deck identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-store-test-'));
  try {
    const store = new ScriptStore(dir), a = store.save({ title: 'A', text: 'old', deck: 'Deck A' });
    store.save({ ...a, text: 'new' });
    assert.equal(store.get(a.id).text, 'new'); assert.equal(store.get(a.id).deck, 'Deck A');
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
    const cache = new JsonCache(join(dir, 'cache.json')); cache.set('key', { value: 2 }); assert.equal(cache.flush(), true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'cache.json'))).key.value, 2);
  } finally { rmSync(dir, { recursive: true }); }
});

test('only one controller holds the lease; stale release cannot stop the new owner', () => {
  let now = 1000; const lease = new ControlLease(() => now, 100);
  lease.claim('take-one', 'page-one'); lease.assert('take-one');
  assert.throws(() => lease.claim('take-two', 'page-two'), /Another window/);
  now += 101; assert.throws(() => lease.assert('take-one'), /expired/);
  lease.claim('take-two', 'page-two'); lease.release('take-one'); lease.assert('take-two');
  lease.disconnect('page-one'); lease.assert('take-two');
  lease.disconnect('page-two'); assert.throws(() => lease.assert('take-two'), /expired/);
});

test('a cancelled recognizer start cannot arrive after its stop', () => {
  const n = new NativeAsr('/unused'); n.stop('cancelled-session');
  assert.throws(() => n.start({ sessionId: 'cancelled-session' }), /cancelled/);
});
