import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../public/lib/script.js';
process.env.TYPESAFE_API_KEY = 'offline-test-key';
const { alignSlides, analyzeOutline, PROMPT_VERSION } = await import('../server/semantic.mjs');
const { ask } = await import('../server/jev.mjs');
const doc = () => parseScript('First topic begins here.\n\nSecond topic starts here.', { lang: 'en', title: 'Talk A' });
const slides = [{ n: 1, title: 'First' }, { n: 2, title: 'Second' }];
const mock = (t, fn) => { const old = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = old; }); };
const response = answers => ({ ok: true, status: 200, json: async () => ({ answers, model: 'test-model', usage: { input_tokens: 12 } }) });

test('alignment API fails explicitly when model calls fail', async t => {
  mock(t, async () => ({ ok: false, status: 401, json: async () => ({ error: 'offline auth failure' }) }));
  await assert.rejects(alignSlides(doc(), slides), /failed for 2\/2/);
});
test('alignment rejects empty probabilities instead of fabricating paragraph zero', async t => {
  mock(t, async () => response({ para: { probabilities: {} } }));
  await assert.rejects(alignSlides(doc(), slides), /no usable alignment/);
});
test('confident mapping preserves order and flags weak assignments for human review', async t => {
  mock(t, async (_url, opts) => {
    const n = JSON.parse(opts.body).state.slide.number;
    return response({ para: { probabilities: n === 1 ? { A0: .95, A1: .05 } : { A0: .05, A1: .95 } } });
  });
  const good = await alignSlides(doc(), slides);
  assert.equal(good.needsReview, false); assert.deepEqual(good.mapping.map(m => m.para), [0, 1]);
  globalThis.fetch = async () => response({ para: { probabilities: { A0: .5, A1: .5 } } });
  assert.equal((await alignSlides(doc(), slides)).needsReview, true);
});
test('scripts over the alignment limit are rejected before any request', async t => {
  let calls = 0; mock(t, async () => { calls++; return response({}); });
  const long = parseScript(Array.from({ length: 251 }, (_, i) => `Paragraph number ${i} has some words.`).join('\n\n'), { lang: 'en' });
  await assert.rejects(alignSlides(long, slides), /250/); assert.equal(calls, 0);
});
test('outline cache includes talk title and exposes model/prompt provenance', async t => {
  let calls = 0; mock(t, async (_url, opts) => {
    calls++; const q = JSON.parse(opts.body).questions;
    return response(Object.fromEntries(Object.keys(q).map(k => [k, k.startsWith('imp_') ? { score: 2.2 } : { choice: 'C0' }])));
  });
  const cache = new Map(), a = doc();
  const one = await analyzeOutline(a, cache); assert.equal(one.errors, 0); assert.equal(one.promptVersion, PROMPT_VERSION); assert.deepEqual(one.models, ['test-model']);
  await analyzeOutline(a, cache); assert.equal(calls, 2);
  a.title = 'Talk B'; await analyzeOutline(a, cache); assert.equal(calls, 4);
});
test('empty outline responses are marked unavailable instead of claiming analysis success', async t => {
  mock(t, async () => response({}));
  const out = await analyzeOutline(doc(), new Map()); assert.equal(out.errors, 2); assert.deepEqual(out.sents, {});
});
test('Jev timeout includes a stalled response body', async t => {
  mock(t, async (_url, opts) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) }));
  const start = Date.now(); await assert.rejects(ask({}, {}, { timeoutMs: 30, retries: 0 }), /aborted/);
  assert.ok(Date.now() - start < 500);
});

test('cancelling an outline aborts running calls and prevents queued calls', async t => {
  let calls = 0;
  mock(t, async (_url, opts) => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    }) };
  });
  const d = parseScript(Array.from({ length: 20 }, (_, i) => `A paragraph about topic number ${i}.`).join('\n\n'), { lang: 'en' });
  const ctrl = new AbortController();
  const query = analyzeOutline(d, new Map(), { signal: ctrl.signal });
  await new Promise(r => setTimeout(r, 10)); ctrl.abort();
  await assert.rejects(query, { name: 'AbortError' }); assert.equal(calls, 8);
});
