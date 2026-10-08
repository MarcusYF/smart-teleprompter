// Check that simAction (defaults) reproduces Follower.applySemantic on every
// stored answer, so offline threshold tuning is faithful to the app.
//   node test/qa/verify-sim.mjs results/*.json
import { loadDoc, readJson } from './lib.mjs';
import { realAction, simAction } from './action.mjs';
import { loadCases } from './metrics.mjs';

let n = 0;
let bad = 0;
for (const file of process.argv.slice(2)) {
  const r = readJson(file);
  if (!r || !r.results || !r.results[0] || !r.results[0].relation) continue;
  const cases = Object.fromEntries(loadCases(r.casesFile || 'jev-cases.json').map((c) => [c.id, c]));
  for (const j of r.results) {
    const c = cases[j.id];
    if (!c || j.error) continue;
    const doc = loadDoc(c.script);
    const a = realAction(doc, c.cur, j);
    const b = simAction(doc, c.cur, j);
    n++;
    if (a.action !== b.action || a.final !== b.final) {
      bad++;
      if (bad <= 10) console.log('MISMATCH', file, j.id, j.n, a, b);
    }
  }
}
console.log(`simAction vs applySemantic: ${n - bad}/${n} identical`);
