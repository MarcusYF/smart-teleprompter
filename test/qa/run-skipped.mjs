// Skipped-passage importance.
//   node test/qa/run-skipped.mjs
// HEAD: server/semantic.mjs skippedJudgment in-process with the payload the
// HEAD client builds ({sentences, context, spoken}); reminder when a sentence
// has important >= 0.6 and covered < 0.5 (semantic-client.js _checkSkips).
// Old: the single-passage endpoint still served by the running 5217 server
// ({skipped, context} -> {important}); reminder when important >= 0.6.

import { join } from 'node:path';
import { QA, loadDoc, normSpeech, readJson, writeJson } from './lib.mjs';
import { textOfPhrases } from '../../public/lib/script.js';
import { skippedJudgment } from '../../server/semantic.mjs';

const SERVER = process.env.QA_SERVER || 'http://127.0.0.1:5217';
const { cases } = readJson(join(QA, 'skipped-cases.json'));
const out = [];
let tokens = 0;
for (const c of cases) {
  const doc = loadDoc(c.script);
  const s = doc.sents[c.sent];
  const sep = doc.lang === 'zh' ? '' : ' ';
  const g0 = s.phStart;
  const gN = s.phEnd - 1;
  const context = textOfPhrases(doc, g0 - 3, gN + 4);
  // what the recognizer heard: the two sentences before, then (if not
  // skipped) the paraphrase, then the first phrase after the skip
  const before = doc.sents.slice(Math.max(0, c.sent - 2), c.sent).map((x) => x.text).join(sep);
  const after = doc.phrases[s.phEnd] ? doc.phrases[s.phEnd].text : '';
  const heard = [before, c.paraphrase || '', after].filter(Boolean).join(' ');
  const spokenToks = normSpeech(heard, doc.lang).split(doc.lang === 'zh' ? '' : ' ');
  const spoken = (doc.lang === 'zh' ? [...normSpeech(heard, doc.lang)] : spokenToks).slice(-80).join(sep);
  const t0 = Date.now();
  const head = await skippedJudgment({ sentences: [s.text], context, spoken, lang: doc.lang });
  const ms = Date.now() - t0;
  const sj = head.sentences[0];
  const remindHead = (sj.covered ?? 0) < 0.5 && (sj.important ?? 0) >= 0.6;
  let old = null;
  if (!c.paraphrase) {
    const res = await fetch(`${SERVER}/api/jev/skipped`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: textOfPhrases(doc, g0, gN + 1), context, lang: doc.lang }),
    });
    old = await res.json();
  }
  const want = c.important && !c.paraphrase;
  out.push({ id: c.id, lang: doc.lang, text: s.text, important: c.important, paraphrased: !!c.paraphrase, want,
    head: { important: sj.important, covered: sj.covered, remind: remindHead, ms },
    old: old && { important: old.important, remind: (old.important ?? 0) >= 0.6 } });
}
writeJson(join(QA, 'results', 'skipped.json'), { at: new Date().toISOString(), results: out });

const fmt = (x) => (x == null ? '–' : x.toFixed(2));
console.log('| id | sentence | gold | HEAD important | HEAD covered | HEAD reminder | old important | old reminder |');
console.log('|---|---|---|---:|---:|---|---:|---|');
for (const r of out) {
  const mark = (ok) => (ok ? '' : ' ✗');
  console.log(`| ${r.id} | ${r.text.slice(0, 48)}${r.text.length > 48 ? '…' : ''} | ${r.paraphrased ? 'paraphrased' : r.important ? 'important' : 'filler'} | ${fmt(r.head.important)} | ${fmt(r.head.covered)} | ${r.head.remind ? 'yes' : 'no'}${mark(r.head.remind === r.want)} | ${r.old ? fmt(r.old.important) : '–'} | ${r.old ? (r.old.remind ? 'yes' : 'no') + mark(r.old.remind === r.want) : '–'} |`);
}
const acc = (k, xs) => xs.filter((r) => r[k] && r[k].remind === r.want).length;
const skips = out.filter((r) => !r.paraphrased);
console.log(`\nHEAD reminder correct ${acc('head', out)}/${out.length} (skips ${acc('head', skips)}/${skips.length}, paraphrased ${acc('head', out.filter((r) => r.paraphrased))}/${out.filter((r) => r.paraphrased).length}); old endpoint ${acc('old', skips)}/${skips.length}`);
for (const lang of ['en', 'zh']) {
  const xs = skips.filter((r) => r.lang === lang);
  const sep = (k) => {
    const imp = xs.filter((r) => r.important).map((r) => r[k].important);
    const fil = xs.filter((r) => !r.important).map((r) => r[k].important);
    return `important min ${Math.min(...imp).toFixed(2)} / filler max ${Math.max(...fil).toFixed(2)}`;
  };
  console.log(`${lang}: HEAD ${sep('head')}; old ${sep('old')}`);
}
