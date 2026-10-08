// Shared helpers for the Jev QA harness (test/qa). Read-only use of the app
// modules: scripts are parsed with the real parser and track payloads are
// built by the real SemanticClient._payload, so the evaluation sees exactly
// what the browser would send.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '../../public/lib/script.js';
import { speechTokens } from '../../public/lib/lang.js';
import { SemanticClient } from '../../public/lib/semantic-client.js';

export const QA = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(QA, '..', '..');

export const SCRIPT_FILES = {
  'en-demo': join(ROOT, 'public', 'samples', 'en-demo.md'),
  'zh-demo': join(ROOT, 'public', 'samples', 'zh-demo.md'),
  'en-lecture': join(QA, 'scripts', 'en-lecture.md'),
  'zh-lecture': join(QA, 'scripts', 'zh-lecture.md'),
};

const docs = new Map();
export function loadDoc(name) {
  if (!docs.has(name)) {
    const text = readFileSync(SCRIPT_FILES[name], 'utf8');
    const doc = parseScript(text, { lang: name.startsWith('zh') ? 'zh' : 'en' });
    doc.sourceText = text;
    docs.set(name, doc);
  }
  return docs.get(name);
}

// What the follower would put in offScriptSpeech(): recognized text ->
// normalized tokens (lowercase, no punctuation, digits spelled out in
// English) joined with '' (zh) or ' ' (en). `smartJoin` keeps a space between
// two Latin-script tokens in Chinese (tested as a client-side variant).
export function normSpeech(text, lang, { smartJoin = false } = {}) {
  const toks = speechTokens(text, lang).map((t) => t.n);
  if (lang !== 'zh') return toks.join(' ');
  if (!smartJoin) return toks.join('');
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const latin = /^[a-z0-9]/i.test(toks[i]);
    const prevLatin = i > 0 && /^[a-z0-9]/i.test(toks[i - 1]);
    out += (latin && prevLatin ? ' ' : '') + toks[i];
  }
  return out;
}

export function units(text, lang) {
  return lang === 'zh' ? text.length : text.split(' ').filter(Boolean).length;
}

// Build the /api/jev/track payload with the app's own client code.
export function buildPayload(doc, cur, offScript, { recentPrefix = '', back = null } = {}) {
  const lang = doc.lang;
  const sep = lang === 'zh' ? '' : ' ';
  const recentToks = [...speechTokens(recentPrefix, lang).map((t) => t.n), ...speechTokens(offScript, lang).map((t) => t.n)];
  const stub = {
    currentPhrase: () => cur,
    recentSpeech: (n) => recentToks.slice(-n).join(sep),
  };
  const sc = new SemanticClient(doc, stub, { enabled: false });
  const payload = sc._payload(offScript);
  if (back != null) {
    // proposed client change: candidates from cur-back (instead of cur-8)
    const cands = [];
    const lo = Math.max(0, cur - back);
    const hi = Math.min(doc.phrases.length, cur + 30);
    for (let i = lo; i < hi; i++) cands.push({ id: `P${i}`, text: doc.phrases[i].text });
    for (const para of doc.paras) {
      const first = doc.sents[para.sentStart]?.phStart;
      if (first !== undefined && first >= hi && cands.length < 60) cands.push({ id: `P${first}`, text: doc.phrases[first].text });
    }
    payload.candidates = cands;
  }
  return payload;
}

export function phraseIdx(id) {
  return /^P\d+$/.test(id || '') ? parseInt(id.slice(1), 10) : -1;
}

export function readJson(p, dflt = null) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt;
}

export function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 1));
}

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
