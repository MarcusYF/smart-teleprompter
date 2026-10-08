// Outline spot-check on the two QA scripts via POST /api/outline (running
// server). Prints per-sentence importance and the chosen cue fragment, and
// flags fragments a glancing speaker would find weak:
//   end-fn     ends on a function word (en stop word / zh 的了是在和…)
//   start-fn   starts on a function word
//   mid-word   zh: starts or ends inside a word (Intl.Segmenter)
//   split-term cuts an English technical term or a number in two
//   no-num     the sentence has a number/key figure the cue drops
//   whole      the cue is the whole sentence (no condensation)
//   null       no cue chosen
//   node test/qa/run-outline.mjs

import { join } from 'node:path';
import { QA, loadDoc, writeJson } from './lib.mjs';
import { isStopToken, speechTokens } from '../../public/lib/lang.js';
import { keyphraseCandidates } from '../../public/lib/outline.js';

const SERVER = process.env.QA_SERVER || 'http://127.0.0.1:5217';
const seg = new Intl.Segmenter('zh', { granularity: 'word' });
const ZH_FN = new Set([...'的了是在和与就都而及也很把被让从到对着过还又所其之等得地么']);

function flags(doc, sentText, kp) {
  const out = [];
  if (!kp) return ['null'];
  const t = kp.text;
  if (t.replace(/[\s\p{P}]/gu, '') === sentText.replace(/[\s\p{P}]/gu, '')) out.push('whole');
  const toks = speechTokens(t, doc.lang);
  if (toks.length) {
    if (isStopToken(toks[toks.length - 1]) || (doc.lang === 'zh' && ZH_FN.has(t.replace(/[\s\p{P}]+$/u, '').slice(-1)))) out.push('end-fn');
    if (isStopToken(toks[0])) out.push('start-fn');
  }
  if (doc.lang === 'zh') {
    const s = sentText;
    const i = s.indexOf(t);
    if (i >= 0) {
      const bounds = new Set([0]);
      let off = 0;
      for (const w of seg.segment(s)) {
        off += w.segment.length;
        bounds.add(off);
      }
      if (!bounds.has(i) || !bounds.has(i + t.length)) out.push('mid-word');
      const before = s.slice(0, i);
      const after = s.slice(i + t.length);
      if (/[A-Za-z0-9-]$/.test(before) && /^[A-Za-z0-9]/.test(t)) out.push('split-term');
      if (/[A-Za-z0-9]$/.test(t) && /^\s?[A-Za-z0-9]/.test(after) && /[A-Za-z]{3,}$/.test(t)) out.push('split-term');
    }
  } else {
    const s = sentText;
    const i = s.indexOf(t);
    const after = i >= 0 ? s.slice(i + t.length) : '';
    if (/^\s?(thousand|million|percent|times)\b/i.test(after)) out.push('split-term');
  }
  const nums = sentText.match(/\d[\d.,%]*|百分之[一二三四五六七八九十百]+|[一二三四五六七八九十两]+(?:千|万|倍|点)|four|eight|three|thousand|square root/gi) || [];
  if (nums.length && !nums.some((n) => t.includes(n))) out.push('no-num');
  return out;
}

const report = {};
for (const name of ['en-lecture', 'zh-lecture']) {
  const doc = loadDoc(name);
  const t0 = Date.now();
  const res = await fetch(`${SERVER}/api/outline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: doc.sourceText, lang: doc.lang }),
  });
  const j = await res.json();
  const rows = [];
  for (const s of doc.sents) {
    const a = j.sents?.[s.idx];
    const para = doc.paras[s.para];
    const isMain = j.paras?.[para.idx]?.main === s.idx;
    const nCands = keyphraseCandidates(doc, s.idx).length;
    rows.push({ sent: s.idx, para: para.idx, text: s.text, imp: a?.imp, impConf: a?.impConf, kp: a?.kp?.text ?? null, kpConf: a?.kpConf, main: isMain, nCands, flags: flags(doc, s.text, a?.kp) });
  }
  report[name] = { ms: Date.now() - t0, tokens: j.tokens, cachedParas: j.cachedParas, errors: j.errors, rows };
  console.log(`\n### ${name}: ${j.ms} ms, ${j.tokens} input tokens, cached paragraphs ${j.cachedParas}, errors ${j.errors}\n`);
  console.log('| S | ¶ | imp | main | cue fragment | flags | sentence |');
  console.log('|---:|---:|---:|:-:|---|---|---|');
  for (const r of rows) console.log(`| ${r.sent} | ${r.para} | ${r.imp?.toFixed(2)} | ${r.main ? '●' : ''} | ${r.kp ?? '–'} | ${r.flags.join(' ')} | ${r.text} |`);
}
writeJson(join(QA, 'results', 'outline.json'), report);
