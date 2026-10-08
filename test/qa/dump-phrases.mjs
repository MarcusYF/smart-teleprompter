// Print every phrase of the four QA scripts with its id, sentence and
// paragraph, to write and check labeled cases.
//   node test/qa/dump-phrases.mjs [script-name]
import { loadDoc, SCRIPT_FILES } from './lib.mjs';

const only = process.argv[2];
for (const name of Object.keys(SCRIPT_FILES)) {
  if (only && name !== only) continue;
  const doc = loadDoc(name);
  console.log(`\n=== ${name} (${doc.lang}) phrases=${doc.phrases.length} sents=${doc.sents.length} paras=${doc.paras.length}`);
  for (const ph of doc.phrases) {
    const s = doc.sents[ph.sent];
    const first = s.phStart === ph.idx ? `S${ph.sent}` : '';
    const pfirst = doc.paras[ph.para].sentStart === ph.sent && s.phStart === ph.idx ? ` ¶${ph.para}` : '';
    console.log(`P${ph.idx}\t${first}${pfirst}\t${ph.text}`);
  }
}
