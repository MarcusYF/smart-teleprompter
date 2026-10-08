// Rubric variant (assignment / instruction / deadline named as important) on
// the skipped cases and the two QA scripts' outline. In-process, no cache.
//   node test/qa/run-rubric.mjs
import { join } from 'node:path';
import { QA, loadDoc, normSpeech, readJson, writeJson } from './lib.mjs';
import { textOfPhrases } from '../../public/lib/script.js';
import { skippedJudgment, analyzeOutline } from './variants/rubric.mjs';
import { usage } from '../../server/jev.mjs';

const head = Object.fromEntries(readJson(join(QA, 'results', 'skipped.json')).results.map((r) => [r.id, r]));
const { cases } = readJson(join(QA, 'skipped-cases.json'));
const rows = [];
for (const c of cases) {
  const doc = loadDoc(c.script);
  const s = doc.sents[c.sent];
  const sep = doc.lang === 'zh' ? '' : ' ';
  const context = textOfPhrases(doc, s.phStart - 3, s.phEnd + 3);
  const before = doc.sents.slice(Math.max(0, c.sent - 2), c.sent).map((x) => x.text).join(sep);
  const after = doc.phrases[s.phEnd] ? doc.phrases[s.phEnd].text : '';
  const heard = normSpeech([before, c.paraphrase || '', after].filter(Boolean).join(' '), doc.lang);
  const spoken = (doc.lang === 'zh' ? [...heard] : heard.split(' ')).slice(-80).join(sep);
  const r = await skippedJudgment({ sentences: [s.text], context, spoken });
  const x = r.sentences[0];
  rows.push({ id: c.id, want: c.important && !c.paraphrase, important: x.important, covered: x.covered, headImportant: head[c.id].head.important, headCovered: head[c.id].head.covered });
}
const decide = (imp, cov, thr) => (cov ?? 0) < 0.5 && (imp ?? 0) >= thr;
console.log('| threshold | HEAD prompt correct | rubric prompt correct |');
console.log('|---:|---:|---:|');
for (const thr of [0.3, 0.4, 0.5, 0.6]) {
  const a = rows.filter((r) => decide(r.headImportant, r.headCovered, thr) === r.want).length;
  const b = rows.filter((r) => decide(r.important, r.covered, thr) === r.want).length;
  console.log(`| ${thr} | ${a}/${rows.length} | ${b}/${rows.length} |`);
}
for (const r of rows) console.log(`  ${r.id.padEnd(8)} want ${r.want ? 'remind' : 'none  '}  important HEAD ${r.headImportant.toFixed(2)} -> rubric ${r.important.toFixed(2)}   covered ${r.covered?.toFixed(2)}`);

const noCache = { get: () => null, set: () => {} };
const out = {};
for (const name of ['en-lecture', 'zh-lecture']) {
  const doc = loadDoc(name);
  const j = await analyzeOutline(doc, noCache);
  out[name] = doc.sents.map((s) => ({ sent: s.idx, text: s.text, imp: j.sents[s.idx]?.imp, kp: j.sents[s.idx]?.kp?.text ?? null }));
}
const prev = readJson(join(QA, 'results', 'outline.json'));
console.log('\n| script | S | sentence | imp HEAD | imp rubric | cue HEAD | cue rubric |');
console.log('|---|---:|---|---:|---:|---|---|');
let maxShift = 0;
for (const name of Object.keys(out)) {
  for (const r of out[name]) {
    const h = prev[name].rows[r.sent];
    const d = Math.abs((r.imp ?? 0) - (h.imp ?? 0));
    if (!/homework|作业|截止|Tuesday/.test(r.text)) maxShift = Math.max(maxShift, d);
    if (d >= 0.3 || /homework|作业|截止|Tuesday/.test(r.text)) console.log(`| ${name} | ${r.sent} | ${r.text.slice(0, 40)}… | ${h.imp.toFixed(2)} | ${r.imp.toFixed(2)} | ${h.kp} | ${r.kp} |`);
  }
}
console.log(`\nlargest importance change on the other sentences: ${maxShift.toFixed(2)}`);
writeJson(join(QA, 'results', 'rubric.json'), { skipped: rows, outline: out, tokens: usage.inputTokens, costUSD: +(usage.inputTokens * 0.042 / 1e6).toFixed(5) });
console.log(`tokens ${usage.inputTokens} ($${(usage.inputTokens * 0.042 / 1e6).toFixed(5)})`);
