// The proposed server/semantic.mjs must send exactly the tested requests:
// track = variants/v2-layout.mjs, skipped/outline = variants/rubric.mjs.
// fetch is stubbed, so no API call is made; only the request body is compared.
import { loadDoc, buildPayload, normSpeech } from './lib.mjs';

const bodies = [];
globalThis.fetch = async (url, init) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'stub', answers: {}, usage: { input_tokens: 0 } }) };
};
const P = await import('./proposed/semantic.mjs');
const V2 = await import('./variants/v2-layout.mjs');
const RB = await import('./variants/rubric.mjs');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let ok = 0;
let n = 0;
for (const [script, cur, asr] of [['en-demo', 18, 'um actually let me go back to what i said'], ['zh-lecture', 12, '我们在 validation loss 里啊不对']]) {
  const doc = loadDoc(script);
  const p = buildPayload(doc, cur, normSpeech(asr, doc.lang));
  Object.assign(p, { leadIn: 'the words just read', speech: normSpeech(asr, doc.lang), curId: `P${cur}` });
  bodies.length = 0;
  await P.trackJudgment(p);
  await V2.trackJudgment(p);
  n++;
  if (same(bodies[0], bodies[1])) ok++;
  else console.log('track differs for', script);
  bodies.length = 0;
  const sk = { sentences: [doc.sents[3].text], context: 'ctx', spoken: 'spoken words' };
  await P.skippedJudgment(sk);
  await RB.skippedJudgment(sk);
  n++;
  if (same(bodies[0], bodies[1])) ok++;
  else console.log('skipped differs for', script);
  bodies.length = 0;
  const noCache = { get: () => null, set: () => {} };
  await P.analyzeOutline(doc, noCache);
  const k = bodies.length;
  await RB.analyzeOutline(doc, noCache);
  n++;
  if (same(bodies.slice(0, k), bodies.slice(k))) ok++;
  else console.log('outline differs for', script);
}
console.log(`proposed/semantic.mjs request bodies identical to the tested variants: ${ok}/${n}`);
