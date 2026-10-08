// Validate jev-cases.json and print what each case sends.
//   node test/qa/check-cases.mjs [--quiet]
import { join } from 'node:path';
import { QA, loadDoc, normSpeech, buildPayload, phraseIdx, readJson, units } from './lib.mjs';

const quiet = process.argv.includes('--quiet');
const file = process.argv.find((a) => a.endsWith('.json')) || 'jev-cases.json';
const { cases, labels } = readJson(join(QA, file));
let bad = 0;
const count = {};
const ids = new Set();
for (const c of cases) {
  const doc = loadDoc(c.script);
  const errs = [];
  if (ids.has(c.id)) errs.push('duplicate id');
  ids.add(c.id);
  if (!labels.includes(c.label)) errs.push(`bad label ${c.label}`);
  if (!(c.cur >= 0 && c.cur < doc.phrases.length)) errs.push('cur out of range');
  if (!(c.expect >= 0 && c.expect < doc.phrases.length)) errs.push('expect out of range');
  const holdLabel = ['adlib_related', 'false_start', 'unrelated'].includes(c.label);
  if (holdLabel && c.expect !== c.cur) errs.push('hold label must expect cur');
  const w = phraseIdx(c.where);
  if (['reading_current', 'paraphrase', 'jumped_ahead', 'went_back'].includes(c.label) && w < 0) errs.push('on-script label needs where');
  if (c.label === 'jumped_ahead' && !(w > c.cur)) errs.push('jumped_ahead where must be after cur');
  if (c.label === 'went_back' && !(w < c.cur)) errs.push('went_back where must be before cur');
  const off = normSpeech(c.asr, doc.lang);
  const p = buildPayload(doc, c.cur, off);
  const inWin = w < 0 || p.candidates.some((x) => x.id === c.where);
  const key = `${doc.lang}:${c.label}`;
  count[key] = (count[key] || 0) + 1;
  if (errs.length) bad++;
  if (!quiet || errs.length) {
    console.log(`\n${c.id} [${c.label}${c.hard ? ' / ' + c.hard : ''}] ${errs.length ? 'ERR ' + errs.join('; ') : ''}`);
    console.log(`  cur   P${c.cur}: ${doc.phrases[c.cur]?.text}`);
    console.log(`  off   (${units(off, doc.lang)}u) ${off}`);
    if (w >= 0) console.log(`  where ${c.where}: ${doc.phrases[w]?.text}${inWin ? '' : '   <-- NOT IN CANDIDATES'}`);
    console.log(`  expect P${c.expect}: ${doc.phrases[c.expect]?.text}   (cands ${p.candidates[0].id}..${p.candidates[p.candidates.length - 1].id}, n=${p.candidates.length})`);
  }
}
console.log(`\n${cases.length} cases, ${bad} with errors`);
console.log(count);
