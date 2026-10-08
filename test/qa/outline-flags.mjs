// Word-level cue checks on stored outline results (no API calls).
//   node test/qa/outline-flags.mjs [results/outline.json]
import { join } from 'node:path';
import { QA, readJson } from './lib.mjs';

const EN_FN = new Set('a an the of to in on at for and or but so that which with from by as is are was were be it its this these those than then into about'.split(' '));
const ZH_FN_END = new Set(['的', '了', '是', '在', '和', '与', '就', '都', '而', '也', '把', '被', '让', '对', '着', '过', '地', '得', '上', '里', '中', '时', '一到']);
const ZH_FN_START = new Set(['但是', '而是', '而', '就', '也', '所以', '因为', '如果', '那么', '然后', '它', '他', '这', '那', '这样', '一旦', '比如']);
const seg = new Intl.Segmenter('zh', { granularity: 'word' });
const words = (t) => [...seg.segment(t)].filter((s) => s.isWordLike).map((s) => s.segment);

export function cueFlags(lang, sent, cue) {
  if (!cue) return ['no-cue'];
  const f = [];
  const strip = (x) => x.replace(/[\s\p{P}]/gu, '');
  if (strip(cue) === strip(sent)) f.push('whole-sentence');
  if (lang === 'en') {
    const w = cue.toLowerCase().match(/[a-z']+/g) || [];
    if (EN_FN.has(w[w.length - 1])) f.push('ends-on-function-word');
    const i = sent.indexOf(cue);
    const after = i >= 0 ? sent.slice(i + cue.length) : '';
    if (/^\s+(other|thousand|million|percent|times)\b/i.test(after) || /\bevery$/i.test(cue)) f.push('cuts-expression');
  } else {
    const w = words(cue);
    if (ZH_FN_END.has(w[w.length - 1])) f.push('ends-on-function-word');
    if (ZH_FN_START.has(w[0])) f.push('starts-with-connective');
    const i = sent.indexOf(cue);
    if (i >= 0) {
      const b = new Set([0]);
      let off = 0;
      for (const s of seg.segment(sent)) b.add((off += s.segment.length));
      if (!b.has(i) || !b.has(i + cue.length)) f.push('cuts-a-word');
    }
  }
  const figs = sent.match(/\d[\d.,%-]*\d?%?|百分之[一二三四五六七八九十百]+|十二点|\bsquare root\b|\bfour thousand\b|\beight\b|\bfour times\b/gi) || [];
  if (figs.length && !figs.some((n) => cue.includes(n))) f.push(`drops: ${figs.join(', ')}`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rep = readJson(join(QA, process.argv[2] || 'results/outline.json'));
  for (const [name, r] of Object.entries(rep)) {
    const lang = name.startsWith('zh') ? 'zh' : 'en';
    let n = 0;
    const tally = {};
    for (const row of r.rows) {
      const fl = cueFlags(lang, row.text, row.kp);
      n++;
      for (const x of fl) tally[x.replace(/:.*/, '')] = (tally[x.replace(/:.*/, '')] || 0) + 1;
      if (fl.length) console.log(`${name} S${row.sent} imp ${row.imp?.toFixed(2)}  "${row.kp}"  -> ${fl.join('; ')}`);
    }
    console.log(`${name}: ${n} sentences, flags ${JSON.stringify(tally)}\n`);
  }
}
