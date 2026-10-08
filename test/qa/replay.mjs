// End-to-end replay: speak each case into the app's real Follower (lexical
// tracker) and SemanticClient, word by word like a streaming recognizer, and
// see what Jev is actually asked and what the prompter ends up showing.
// fetch('/api/jev/track') is forwarded to the running server (or to a variant
// module in-process); /api/jev/skipped is stubbed.
//
//   node test/qa/replay.mjs [--code head|proposed] [--variant baseline|baseline-local|proposed|<variant>]
//                           [--no-jev] [--cases FILE] [--tag NAME]
//   --code proposed   uses test/qa/proposed/follower.js + semantic-client.js
//   --variant proposed uses test/qa/proposed/semantic.mjs in-process

import { join } from 'node:path';
import { QA, loadDoc, readJson, writeJson } from './lib.mjs';
import { speechTokens } from '../../public/lib/lang.js';
import { outcome } from './action.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const variant = opt('variant', 'baseline');
const code = opt('code', 'head');
const casesFile = opt('cases', 'jev-cases.json');
const noJev = args.includes('--no-jev');
const { Follower } = await import(code === 'proposed' ? './proposed/follower.js' : '../../public/lib/follower.js');
const { SemanticClient } = await import(code === 'proposed' ? './proposed/semantic-client.js' : '../../public/lib/semantic-client.js');
const tag = opt('tag', `${noJev ? 'replay-lexical' : `replay-${variant}`}${code === 'proposed' ? '-code-proposed' : ''}${casesFile === 'jev-cases.json' ? '' : '-' + casesFile.replace(/\.json$/, '')}`);
const SERVER = process.env.QA_SERVER || 'http://127.0.0.1:5217';
const realFetch = globalThis.fetch;

let judge = null;
if (!noJev) {
  if (variant === 'baseline') {
    judge = async (payload) => {
      const res = await realFetch(`${SERVER}/api/jev/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return res.json();
    };
  } else {
    const path = variant === 'baseline-local' ? '../../server/semantic.mjs' : variant === 'proposed' ? './proposed/semantic.mjs' : `./variants/${variant}.mjs`;
    const mod = await import(path);
    judge = (payload) => mod.trackJudgment(payload);
  }
}

let calls = [];
globalThis.fetch = async (url, init) => {
  if (/^https?:/.test(String(url))) return realFetch(url, init); // Jev API (in-process judges) / server
  if (url === '/api/jev/track') {
    const payload = JSON.parse(init.body);
    const j = await judge(payload);
    calls.push({ current: payload.current, off: payload.offScript, leadIn: payload.leadIn, speech: payload.speech, onScript: j.onScript, nCands: payload.candidates.length, tokens: j.tokens, relation: j.relation?.choice, relP: j.relation?.probabilities?.[j.relation?.choice], where: j.where?.choice, whereP: j.where?.probabilities?.[j.where?.choice] });
    return { ok: true, json: async () => j };
  }
  return { ok: true, json: async () => ({ important: 0 }) };
};

const { cases } = readJson(join(QA, casesFile));
const out = [];
let tokens = 0;
for (const c of cases) {
  const doc = loadDoc(c.script);
  const lang = doc.lang;
  const sep = lang === 'zh' ? '' : ' ';
  const startPh = Math.max(0, c.cur - 3);
  const f = new Follower(doc);
  f.reset(doc.phrases[startPh].tokStart);
  const judgments = [];
  const sc = new SemanticClient(doc, f, { enabled: !noJev, onJudgment: (j) => judgments.push(j), onSkipReminder: () => {} });
  const pending = [];
  const q = sc._query.bind(sc);
  sc._query = (off, now) => {
    const p = q(off, now);
    pending.push(p);
    return p;
  };
  calls = [];
  let t = 1000;
  const dt = lang === 'zh' ? 240 : 400;
  const chunk = lang === 'zh' ? 12 : 8;
  let offStartSeen = null;
  const speak = async (text, phase) => {
    const toks = speechTokens(text, lang).map((x) => x.n);
    for (let i = 0; i < toks.length; i += chunk) {
      const utt = toks.slice(i, i + chunk);
      for (let k = 1; k <= utt.length; k++) {
        const kind = k === utt.length ? 'final' : 'interim';
        f.onSpeech(kind, utt.slice(0, k).join(sep === '' ? ' ' : ' '), t);
        if (phase === 'off' && offStartSeen === null && f.status === 'offscript') offStartSeen = i + k;
        sc.check(t);
        if (pending.length) {
          await Promise.all(pending.splice(0));
        }
        t += dt;
      }
    }
  };
  const lead = doc.phrases.slice(startPh, c.cur).map((p) => p.text).join(' ');
  await speak(lead, 'lead');
  const leadPos = f.pos;
  const leadPh = doc.tokens[Math.min(leadPos, doc.tokens.length - 1)].phrase;
  await speak(c.asr, 'off');
  const finalPh = doc.tokens[Math.min(f.pos, doc.tokens.length - 1)].phrase;
  const o = outcome(c, finalPh);
  for (const x of calls) tokens += x.tokens || 0;
  out.push({
    id: c.id, label: c.label, cur: c.cur, expect: c.expect, leadPh, finalPh, outcome: o,
    wentOffScript: offStartSeen !== null, offAfterTokens: offStartSeen, requests: calls.length,
    actions: judgments.map((j) => j.action || (j.error ? 'error' : '?')), calls,
    moves: f.events.filter((e) => e.how !== 'advance').map((e) => ({ how: e.how, from: e.from, to: e.to, label: e.label })),
  });
}
globalThis.fetch = realFetch;
writeJson(join(QA, 'results', `${tag}.json`), { tag, variant, code, casesFile, noJev, tokens, costUSD: +(tokens * 0.042 / 1e6).toFixed(5), results: out });
const tally = out.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] || 0) + 1), a), {});
const lagged = out.filter((r) => r.leadPh !== r.cur).map((r) => `${r.id}:P${r.leadPh}`);
console.log(`${tag}: ${JSON.stringify(tally)}; requests ${out.reduce((a, r) => a + r.requests, 0)}; tokens ${tokens}; cases never off-script ${out.filter((r) => !r.wentOffScript).length}; lead-in not at cur: ${lagged.join(' ') || 'none'}`);
