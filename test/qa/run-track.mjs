// Run one prompt variant over the labeled cases and store the raw answers.
//
//   node test/qa/run-track.mjs --variant baseline            # via the running server (/api/jev/track)
//   node test/qa/run-track.mjs --variant baseline-local      # server/semantic.mjs in-process
//   node test/qa/run-track.mjs --variant v1-criteria         # test/qa/variants/v1-criteria.mjs
//   options: --mode full|prefix  --concurrency N  --smart-join  --tag NAME  --only id,id
//
// full   = one request per case with the whole off-script stretch
// prefix = the requests the browser makes during the episode (semantic-client
//          check() + Follower.offScriptSpeech() as of HEAD 8013d1e): the first
//          once run >= 5 words / 8 zh tokens, then every ~1.5 s (+4 words /
//          +6 zh tokens at normal pace), the last one = the full stretch. The
//          text is the last max(run, 9 | 14) tokens, so early requests start
//          with the end of the script text read just before (lead-in tail).
//   --client v0 reproduces the original client (first request at 4 words /
//          6 zh tokens, no minimum window).
// The API key is only read by server/jev.mjs; nothing here prints it.

import { join } from 'node:path';
import { QA, loadDoc, normSpeech, buildPayload, readJson, writeJson } from './lib.mjs';
import { speechTokens } from '../../public/lib/lang.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (k) => args.includes(`--${k}`);
const variant = opt('variant', 'baseline');
const mode = opt('mode', 'full');
const conc = parseInt(opt('concurrency', '1'), 10);
const smartJoin = flag('smart-join');
const only = opt('only', null);
const client = opt('client', 'current');
const casesFile = opt('cases', 'jev-cases.json');
const windowBack = opt('window-back', null);
const tag = opt('tag', `${variant}-${mode}${client === 'v0' ? '-v0' : ''}${smartJoin ? '-sj' : ''}${windowBack ? '-w' + windowBack : ''}${casesFile === 'jev-cases.json' ? '' : '-' + casesFile.replace(/\.json$/, '')}`);
const SERVER = process.env.QA_SERVER || 'http://127.0.0.1:5217';

let judge;
if (variant === 'baseline') {
  judge = async (payload) => {
    const t0 = performance.now();
    const res = await fetch(`${SERVER}/api/jev/track`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return { ...j, rtt: Math.round(performance.now() - t0) };
  };
} else {
  const mod = variant === 'baseline-local'
    ? await import('../../server/semantic.mjs')
    : await import(`./variants/${variant}.mjs`);
  judge = async (payload) => {
    const t0 = performance.now();
    const j = await mod.trackJudgment(payload);
    return { ...j, rtt: Math.round(performance.now() - t0) };
  };
}

const { cases } = readJson(join(QA, casesFile));
const sel = only ? cases.filter((c) => only.split(',').includes(c.id)) : cases;

const CLIENT = {
  current: { en: { minRun: 5, minWin: 9, step: 4 }, zh: { minRun: 8, minWin: 14, step: 6 } },
  v0: { en: { minRun: 4, minWin: 0, step: 4 }, zh: { minRun: 6, minWin: 0, step: 6 } },
}[client];

export function leadText(c, doc) {
  return doc.phrases.slice(Math.max(0, c.cur - 3), c.cur).map((p) => p.text).join(doc.lang === 'zh' ? '' : ' ');
}

function prefixes(c, doc) {
  const L = CLIENT[doc.lang];
  const lead = speechTokens(leadText(c, doc), doc.lang).map((t) => t.n);
  const off = speechTokens(c.asr, doc.lang).map((t) => t.n);
  // off = what Follower.offScriptSpeech() sends; leadIn/speech = the same
  // text split into the padded lead-in (script words read just before) and
  // the words said since leaving the script (proposed client change).
  const at = (k) => {
    const all = [...lead, ...off.slice(0, k)];
    const n = Math.min(all.length, 48, Math.max(k, L.minWin));
    const win = all.slice(all.length - n);
    const nLead = Math.max(0, n - Math.min(k, n));
    const j = (xs) => normSpeech(xs.join(' '), doc.lang, { smartJoin });
    return { n: k, off: j(win), leadIn: j(win.slice(0, nLead)), speech: j(win.slice(nLead)) };
  };
  if (mode !== 'prefix') return [at(off.length)];
  const out = [];
  for (let k = L.minRun; k < off.length; k += L.step) out.push(at(k));
  out.push(at(off.length));
  return out;
}

const jobs = [];
for (const c of sel) {
  const doc = loadDoc(c.script);
  const lead = leadText(c, doc);
  for (const pr of prefixes(c, doc)) {
    const payload = buildPayload(doc, c.cur, pr.off, { recentPrefix: lead, back: windowBack == null ? null : parseInt(windowBack, 10) });
    Object.assign(payload, { leadIn: pr.leadIn, speech: pr.speech, curId: `P${c.cur}` });
    for (const x of payload.candidates) x.sent = doc.phrases[parseInt(x.id.slice(1), 10)].sent;
    jobs.push({ c, doc, pr, payload });
  }
}

const results = new Array(jobs.length);
let next = 0;
let tokens = 0;
let errors = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, async () => {
  while (next < jobs.length) {
    const k = next++;
    const { c, pr, payload } = jobs[k];
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await judge(payload);
        break;
      } catch (err) {
        r = { error: String(err.message || err) };
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      }
    }
    if (r.error) errors++;
    tokens += r.tokens || 0;
    results[k] = { id: c.id, n: pr.n, off: pr.off, nCands: payload.candidates.length, ...r };
  }
}));

const out = {
  variant, mode, client, casesFile, windowBack, smartJoin, tag, at: new Date().toISOString(), wallMs: Date.now() - t0,
  requests: jobs.length, errors, tokens, costUSD: +(tokens * 0.042 / 1e6).toFixed(5), results,
};
writeJson(join(QA, 'results', `${tag}.json`), out);
console.log(`${tag}: ${jobs.length} requests, ${errors} errors, ${tokens} input tokens ($${out.costUSD}), ${Math.round(out.wallMs / 1000)} s`);
