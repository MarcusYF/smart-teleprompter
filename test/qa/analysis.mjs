// Offline analyses on stored results (no API calls).
//   node test/qa/analysis.mjs
// 1. run-to-run noise of identical full-text payloads
// 2. first-request label quality (the request the prompter acts on first)
// 3. does confidence flag the wrong moves? (AUROC over move-triggering requests)

import { loadDoc, phraseIdx } from './lib.mjs';
import { loadCases, loadResults, relationStats, mdRelation, mdConfusion, calibration, LABELS } from './metrics.mjs';
import { realAction, simAction, outcome } from './action.mjs';
import { lastPerCase } from './tune.mjs';

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');

// 1 ---------------------------------------------------------------- noise
{
  const runs = ['results/baseline-local-full.json', 'results/baseline-endpoint-full.json'].map((f) => loadResults(f));
  const third = lastPerCase(loadResults('results/baseline-local-prefix.json').results);
  const A = Object.fromEntries(runs[0].results.map((r) => [r.id, r]));
  const B = Object.fromEntries(runs[1].results.map((r) => [r.id, r]));
  let relSame = 0;
  let whereSame = 0;
  let n = 0;
  let dp = 0;
  let dw = 0;
  let actSame = 0;
  const cases = loadCases();
  for (const c of cases) {
    const xs = [A[c.id], B[c.id], third[c.id]].filter((x) => x && x.off === A[c.id].off);
    if (xs.length < 3) continue;
    n++;
    if (new Set(xs.map((x) => x.relation.choice)).size === 1) relSame++;
    if (new Set(xs.map((x) => x.where.choice)).size === 1) whereSame++;
    const doc = loadDoc(c.script);
    if (new Set(xs.map((x) => realAction(doc, c.cur, x).final)).size === 1) actSame++;
    const p = xs.map((x) => x.relation.probabilities[c.label] ?? 0);
    const w = xs.map((x) => x.where.probabilities[x.where.choice] ?? 0);
    dp += Math.max(...p) - Math.min(...p);
    dw += Math.max(...w) - Math.min(...w);
  }
  console.log(`## 1. run-to-run noise (3 runs of the same ${n} full-text payloads)\n`);
  console.log(`relation label identical in all 3: ${relSame}/${n}; where identical: ${whereSame}/${n}; displayed phrase after the action identical: ${actSame}/${n}`);
  console.log(`mean spread (max-min) of p(gold label): ${f2(dp / n)}; of p(chosen where): ${f2(dw / n)}\n`);
}

// 2 ------------------------------------------------------- first requests
function firstRequests(file) {
  const res = loadResults(file);
  const by = {};
  for (const r of res.results) if (!by[r.id] || r.n < by[r.id].n) by[r.id] = r;
  return { res, by };
}
console.log('## 2. first request of each episode (what the prompter acts on first)\n');
for (const file of ['results/baseline-local-prefix.json', 'results/v2-layout-prefix.json', 'results/v4-split-prefix.json',
  'results/baseline-local-prefix-jev-cases-heldout.json', 'results/v2-layout-prefix-jev-cases-heldout.json', 'results/v4-split-prefix-jev-cases-heldout.json']) {
  const { res, by } = firstRequests(file);
  const cases = loadCases(res.casesFile || 'jev-cases.json');
  const st = relationStats(cases, by);
  console.log(`${res.variant}${res.casesFile && res.casesFile !== 'jev-cases.json' ? ' (held-out)' : ''}: first-request label accuracy ${f2(st.acc)} (${st.ok}/${st.n}), macro-F1 ${f2(st.macroF1)}`);
  if (file === 'results/baseline-local-prefix.json') {
    console.log('\n' + mdRelation(st) + '\n\n' + mdConfusion(st) + '\n');
  }
}

// 3 ------------------------------------------- confidence vs wrong moves
console.log('\n## 3. do low probabilities flag the wrong moves? (every request that moved the display, current rules)\n');
for (const file of ['results/baseline-local-prefix.json', 'results/baseline-prefix.json', 'results/baseline-local-prefix-jev-cases-heldout.json', 'results/v2-layout-prefix.json', 'results/v2-layout-prefix-jev-cases-heldout.json']) {
  const res = loadResults(file);
  const cases = Object.fromEntries(loadCases(res.casesFile || 'jev-cases.json').map((c) => [c.id, c]));
  const items = [];
  for (const j of res.results) {
    const c = cases[j.id];
    const doc = loadDoc(c.script);
    const a = realAction(doc, c.cur, j);
    if (a.action === 'hold') continue;
    const ok = outcome(c, a.final, { path: true }) === 'correct';
    const rel = j.relation;
    items.push({ ok, p: rel.probabilities[rel.choice] ?? 0, conf: rel.confidence ?? 0, wp: j.where.probabilities[j.where.choice] ?? 0, on: j.onScript ?? 0 });
  }
  const cal = calibration(items.map((x) => ({ p: x.p, conf: x.conf, ok: x.ok })));
  const calW = calibration(items.map((x) => ({ p: x.wp, conf: x.wp, ok: x.ok })));
  const calO = calibration(items.map((x) => ({ p: x.on, conf: x.on, ok: x.ok })));
  const wrong = items.filter((x) => !x.ok);
  const right = items.filter((x) => x.ok);
  const mean = (xs, k) => (xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : NaN);
  console.log(`${res.variant}${res.client === 'v0' ? ' (v0 client)' : ''}${res.casesFile && res.casesFile !== 'jev-cases.json' ? ' (held-out)' : ''}: ${items.length} moves, ${wrong.length} wrong. ` +
    `mean relation p right ${f2(mean(right, 'p'))} vs wrong ${f2(mean(wrong, 'p'))} (AUROC ${f2(cal.aurocP)}); ` +
    `where p ${f2(mean(right, 'wp'))} vs ${f2(mean(wrong, 'wp'))} (AUROC ${f2(calW.aurocP)}); onScript ${f2(mean(right, 'on'))} vs ${f2(mean(wrong, 'on'))} (AUROC ${f2(calO.aurocP)}); ` +
    `wrong moves with relation p < 0.6: ${wrong.filter((x) => x.p < 0.6).length}/${wrong.length}, right moves with p < 0.6: ${right.filter((x) => x.p < 0.6).length}/${right.length}`);
}
