// Offline policy/threshold evaluation on stored answers (no API calls).
//   node test/qa/tune.mjs results/<x>-prefix.json [results/<y>-prefix.json ...]
// For each policy: episode outcomes (browser request schedule, first move
// ends the episode, path-aware), single-request outcomes on the full text
// (= last request of each episode), and how late correct moves happen.

import { loadCases, loadResults, episodeStats, actionStats } from './metrics.mjs';

export const POLICIES = {
  current: {},
  direction: { direction: true },
  'minBack2': { minBack: 2 },
  'dir+minBack2': { direction: true, minBack: 2 },
  'relP.5': { relP: 0.5 },
  'relP.6': { relP: 0.6 },
  'relP.7': { relP: 0.7 },
  'whereP.5': { whereP: 0.5 },
  'whereP.6': { whereP: 0.6 },
  'onScript.6': { onScript: 0.6 },
  'far6@.6': { farPhrases: 6, farWhereP: 0.6 },
  coveredFirst: { coveredFirst: true },
  'dir+minBack2+relP.6': { direction: true, minBack: 2, relP: 0.6 },
  'dir+minBack2+relP.6+coveredFirst': { direction: true, minBack: 2, relP: 0.6, coveredFirst: true },
  'dir+minBack2+relP.5': { direction: true, minBack: 2, relP: 0.5 },
  'dir+minBack2+whereP.5': { direction: true, minBack: 2, whereP: 0.5 },
};

export function lastPerCase(results) {
  const by = {};
  for (const r of results) if (!by[r.id] || r.n > by[r.id].n) by[r.id] = r;
  return by;
}

export function evaluate(file, policies = POLICIES, filter = () => true) {
  const res = loadResults(file);
  const cases = loadCases(res.casesFile || 'jev-cases.json');
  const last = lastPerCase(res.results);
  const rows = [];
  for (const [name, sim] of Object.entries(policies)) {
    const ep = episodeStats(cases, res.results, { sim, filter });
    const one = actionStats(cases, last, { sim, filter });
    // requests needed before the first correct move, for cases that need a move
    const moves = ep.rows.filter((r) => r.expect !== cases.find((c) => c.id === r.id).cur && r.outcome === 'correct');
    const meanAt = moves.length ? moves.reduce((a, r) => a + (r.at ?? r.of), 0) / moves.length : NaN;
    rows.push({ name, ep, one, meanAt });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of process.argv.slice(2)) {
    console.log(`\n### ${file}\n`);
    console.log('| policy | episode correct | held | partial | **wrong** | full-text correct | full-text wrong | mean tokens before a correct move |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of evaluate(file)) {
      console.log(`| ${r.name} | ${r.ep.correct}/${r.ep.n} | ${r.ep.held} | ${r.ep.partial} | **${r.ep.wrong}** | ${r.one.correct}/${r.one.n} | ${r.one.wrong} | ${r.meanAt.toFixed(1)} |`);
    }
  }
}
