// Side-by-side comparison of variants run with --mode prefix.
//   node test/qa/compare.mjs results/baseline-local-prefix.json results/v1-criteria-prefix.json ...
// The full-text judgment is the last request of each episode.

import {
  loadCases, loadResults, relationStats, whereStats, relationCalibration, whereCalibration,
  actionStats, episodeStats, latency, mdConfusion,
} from './metrics.mjs';
import { lastPerCase } from './tune.mjs';

const GUARD = { direction: true, minBack: 2, relP: 0.6 };
const pct = (a, b) => `${Math.round((100 * a) / b)}%`;
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');

const files = process.argv.slice(2).filter((f) => !f.startsWith('--'));
const showConf = process.argv.includes('--confusion');
const rows = [];
for (const file of files) {
  const res = loadResults(file);
  const cases = loadCases(res.casesFile || 'jev-cases.json');
  const last = lastPerCase(res.results);
  const rel = relationStats(cases, last);
  const relEn = relationStats(cases, last, (c) => c.script.startsWith('en'));
  const relZh = relationStats(cases, last, (c) => c.script.startsWith('zh'));
  const wh = whereStats(cases, last);
  const cal = relationCalibration(cases, last);
  const wcal = whereCalibration(cases, last);
  const act = actionStats(cases, last);
  const ep = episodeStats(cases, res.results);
  const epG = episodeStats(cases, res.results, { sim: GUARD });
  const lat = latency(res.results);
  // mean probability given to the gold label on the full text (margin)
  const goldP = cases.reduce((s, c) => s + (last[c.id]?.relation?.probabilities?.[c.label] ?? 0), 0) / cases.length;
  const firstWrong = ep.firstQueryWrong;
  rows.push({ file, res, rel, relEn, relZh, wh, cal, wcal, act, ep, epG, lat, goldP, firstWrong, cases, last });
}

console.log('| variant | relation acc (en / zh) | macro-F1 | mean p(gold) | where top-1 / ±1 | ECE rel | AUROC where-p | full-text action correct / wrong | episode correct / **wrong** | episode + guards correct / **wrong** | p50 / p95 ms | tokens/req | $ per 255 req |');
console.log('|---|---|---:|---:|---|---:|---:|---|---|---|---|---:|---:|');
for (const r of rows) {
  const name = r.res.variant + (r.res.client === 'v0' ? ' (v0 client)' : '');
  console.log(`| ${name} | ${f2(r.rel.acc)} (${f2(r.relEn.acc)} / ${f2(r.relZh.acc)}) | ${f2(r.rel.macroF1)} | ${f2(r.goldP)} | ${pct(r.wh.exact, r.wh.n)} / ${pct(r.wh.near, r.wh.n)} | ${f2(r.cal.ece)} | ${f2(r.wcal.aurocP)} | ${r.act.correct} / ${r.act.wrong} | ${r.ep.correct} / **${r.ep.wrong}** | ${r.epG.correct} / **${r.epG.wrong}** | ${r.lat.p50} / ${r.lat.p95} | ${Math.round(r.lat.tokMean)} | ${(r.res.costUSD * 255 / r.res.requests).toFixed(4)} |`);
}
for (const r of rows) {
  const bad = r.ep.rows.filter((x) => x.outcome !== 'correct').map((x) => `${x.id}:${x.outcome}${x.at ? '@' + x.at : ''}`);
  const badG = r.epG.rows.filter((x) => x.outcome !== 'correct').map((x) => `${x.id}:${x.outcome}${x.at ? '@' + x.at : ''}`);
  const relBad = r.cases.filter((c) => r.last[c.id]?.relation?.choice !== c.label).map((c) => `${c.id}→${r.last[c.id]?.relation?.choice}`);
  console.log(`\n${r.res.variant}: episode misses ${bad.join(' ') || 'none'}\n   with guards: ${badG.join(' ') || 'none'}\n   full-text relation errors: ${relBad.join(' ') || 'none'}`);
  if (showConf) console.log('\n' + mdConfusion(r.rel));
}
