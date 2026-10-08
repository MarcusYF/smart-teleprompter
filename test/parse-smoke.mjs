import { readFileSync } from 'node:fs';
import { parseScript } from '../public/lib/script.js';
for (const f of ['zh-demo.md', 'en-demo.md']) {
  const doc = parseScript(readFileSync(new URL('../public/samples/' + f, import.meta.url), 'utf8'));
  console.log(`\n== ${f}: lang=${doc.lang} sections=${doc.sections.length} paras=${doc.paras.length} sents=${doc.sents.length} phrases=${doc.phrases.length} tokens=${doc.tokens.length} slides=${doc.slides.map(s=>s.n+':'+s.title).join(', ')}`);
  for (const ph of doc.phrases) console.log(String(ph.idx).padStart(3), `s${ph.sent} p${ph.para} §${ph.section}`, `[${ph.tokEnd-ph.tokStart}]`, ph.text);
  console.log('cues:', doc.cues.map(c=>c.text), 'outlines:', doc.paras.map(p=>p.outline).filter(Boolean));
}
