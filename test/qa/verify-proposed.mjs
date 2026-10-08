// The proposed Follower.applySemantic (test/qa/proposed/follower.js) must equal
// simAction({direction, minBack: 2, relP: 0.6}) on every stored answer.
import { loadDoc, readJson } from './lib.mjs';
import { simAction } from './action.mjs';
import { loadCases } from './metrics.mjs';
import { Follower } from './proposed/follower.js';

function proposedAction(doc, cur, j) {
  const f = new Follower(doc);
  const pos = doc.phrases[cur].tokStart;
  f.tracker.setPosition(pos);
  f.pos = pos;
  f.run = 6;
  f.status = 'offscript';
  const action = f.applySemantic({ ...j, requestPos: pos });
  return { action, final: doc.tokens[Math.min(f.pos, doc.tokens.length - 1)].phrase };
}
let n = 0;
let bad = 0;
for (const file of process.argv.slice(2)) {
  const r = readJson(file);
  const cases = Object.fromEntries(loadCases(r.casesFile || 'jev-cases.json').map((c) => [c.id, c]));
  for (const j of r.results) {
    const c = cases[j.id];
    if (!c || j.error || !j.relation) continue;
    const doc = loadDoc(c.script);
    const a = proposedAction(doc, c.cur, j);
    const b = simAction(doc, c.cur, j, { direction: true, minBack: 2, relP: 0.6 });
    n++;
    if (a.action !== b.action || a.final !== b.final) {
      bad++;
      if (bad < 6) console.log('MISMATCH', file, j.id, j.n, a, b);
    }
  }
}
console.log(`proposed applySemantic vs simAction(guards): ${n - bad}/${n} identical`);
