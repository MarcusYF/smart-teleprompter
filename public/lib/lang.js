// Language utilities shared by the browser and Node: tokenization,
// normalization, pinyin lookup and token similarity for English and Chinese.

import { PINYIN_FIRST, PINYIN_TABLE } from './pinyin-table.js';
import { readTex } from './math.js';

const PINYIN = PINYIN_TABLE.split(' ');

export const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/u;

export function isHan(ch) {
  return HAN_RE.test(ch);
}

export function pinyinOf(ch) {
  const cp = ch.codePointAt(0);
  const i = cp - PINYIN_FIRST;
  return i >= 0 && i < PINYIN.length ? PINYIN[i] || null : null;
}

// Collapse the distinctions most often lost in accented Mandarin or by the
// recognizer (zh/z, ch/c, sh/s, n/l, -ng/-n, f/h).
export function fuzzyPinyin(py) {
  if (!py) return null;
  return py
    .replace(/^zh/, 'z').replace(/^ch/, 'c').replace(/^sh/, 's')
    .replace(/^n/, 'l').replace(/^f/, 'h').replace(/^r/, 'l')
    .replace(/ng$/, 'n');
}

export function detectLang(text) {
  let han = 0;
  let words = 0;
  for (const ch of text) if (isHan(ch)) han++;
  const m = text.match(/[A-Za-z]+/g);
  if (m) words = m.length;
  if (han + words === 0) return 'en';
  return han >= 0.3 * (han + words * 1.5) ? 'zh' : 'en';
}

const EN_STOP = new Set(('a an the of to in on at for and or but nor is are was were be been being am ' +
  'it its this that these those i me my you your we our us they them their he him his she her ' +
  'as by with from so do does did not no yes have has had will would can could should shall may might ' +
  'just very really um uh oh okay ok well then than there here what which who whom whose when where why how ' +
  'if into out up down over about also all any some such only own same too s t').split(' '));

const ZH_STOP = new Set([...
  '的了是在和与就都而及也很我你他她它们这那个一不有为以于上中下对把被让从到说会能要可啊呢吗吧呀嗯哦着过还又所其之等得地么什如果因此但并或来去给使用做自己看想好多些样时后前里面儿点最更再已经没只才将该']);

export function isStopToken(tok) {
  if (tok.kind === 'han') return ZH_STOP.has(tok.n);
  if (tok.kind === 'word') return EN_STOP.has(tok.n);
  return false;
}

// ---------------------------------------------------------------- numbers

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n) {
  const out = [];
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)], 'hundred');
    n %= 100;
  }
  if (n >= 20) {
    out.push(TENS[Math.floor(n / 10)]);
    if (n % 10) out.push(ONES[n % 10]);
  } else if (n > 0 || out.length === 0) {
    out.push(ONES[n]);
  }
  return out;
}

function intToWords(n) {
  if (n === 0) return ['zero'];
  const out = [];
  const units = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  for (const [v, name] of units) {
    if (n >= v) {
      out.push(...below1000(Math.floor(n / v)), name);
      n %= v;
    }
  }
  if (n > 0) out.push(...below1000(n));
  return out;
}

// English reading of a numeric string, e.g. "2026" -> twenty twenty six,
// "3.5" -> three point five, "40%" -> forty percent.
export function numberWordsEn(raw) {
  let s = raw.replace(/,/g, '');
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  let words;
  if (/^\d+\.\d+$/.test(s)) {
    const [a, b] = s.split('.');
    words = [...intToWords(parseInt(a, 10)), 'point', ...[...b].map((d) => ONES[+d])];
  } else if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (s.length === 4 && n >= 1100 && n <= 2099 && !(n >= 2000 && n <= 2009) && n % 100 !== 0) {
      words = [...below1000(Math.floor(n / 100)), ...(n % 100 < 10 ? ['oh', ONES[n % 100]] : below1000(n % 100))];
    } else if (s.length > 12) {
      words = [...s].map((d) => ONES[+d]);
    } else {
      words = intToWords(n);
    }
  } else {
    words = [s.toLowerCase()];
  }
  if (pct) words.push('percent');
  return words;
}

const ZH_DIGIT = '零一二三四五六七八九';

function zhBelow10000(n) {
  // n in [1, 9999]; standard reading with 零 for gaps
  const units = ['', '十', '百', '千'];
  const ds = String(n).split('').map(Number);
  let out = '';
  let zero = false;
  ds.forEach((d, i) => {
    const u = units[ds.length - 1 - i];
    if (d === 0) {
      zero = out.length > 0;
      return;
    }
    if (zero) out += '零';
    zero = false;
    out += ZH_DIGIT[d] + u;
  });
  if (out.startsWith('一十')) out = out.slice(1); // 十五 not 一十五
  return out;
}

function zhInt(n) {
  if (n === 0) return '零';
  if (n >= 1e8) return String(n).split('').map((d) => ZH_DIGIT[+d]).join('');
  const hi = Math.floor(n / 10000);
  const lo = n % 10000;
  let out = hi ? `${zhBelow10000(hi)}万` : '';
  if (lo) out += (hi && lo < 1000 ? '零' : '') + zhBelow10000(lo);
  return out;
}

// Chinese reading of a numeric string, so "20%" matches 百分之二十 and
// "2026年" matches 二零二六年 whichever form the script or recognizer uses.
export function numberHanZh(raw, next = '') {
  let s = raw.replace(/,/g, '');
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  let out;
  if (/^\d+\.\d+$/.test(s)) {
    const [a, b] = s.split('.');
    out = `${zhInt(parseInt(a, 10))}点${[...b].map((d) => ZH_DIGIT[+d]).join('')}`;
  } else if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    const yearLike = next === '年' && s.length >= 2;
    if (yearLike || s.length > 8 || (s.length > 1 && s[0] === '0')) out = [...s].map((d) => ZH_DIGIT[+d]).join('');
    else out = zhInt(n);
  } else {
    return null;
  }
  return pct ? `百分之${out}` : out;
}

// ------------------------------------------------------------ tokenization

// One regex pass over text. Groups: 1 inline cue, 2 han, 3 number, 4 word.
const PIECE_RE = /\[\[([^\]]*)\]\]|([〇㐀-䶿一-鿿豈-﫿])|(\d+(?:[.,]\d+)*%?)|([A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*)|(\s+)|([\s\S])/gu;

export function normWord(w) {
  return w.normalize('NFKC').toLowerCase().replace(/['’]/g, '');
}

function stemEn(w) {
  if (w.length <= 4) return w;
  return w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|ly|s)$/, '') || w;
}

// Rough phonetic key so recognizer spellings that sound alike still match.
export function phoneticKey(w) {
  let s = w.replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s.replace(/^(kn|gn|pn|wr|ps)/, (m) => m[1])
    .replace(/ph/g, 'f').replace(/gh(?![aeiou])/g, '').replace(/ck/g, 'k')
    .replace(/(sh|ch|tio|sio)/g, 'X').replace(/th/g, '0').replace(/dg/g, 'j')
    .replace(/c(?=[iey])/g, 's').replace(/[cqk]/g, 'k').replace(/x/g, 'ks')
    .replace(/z/g, 's').replace(/v/g, 'f').replace(/wh/g, 'w');
  const first = /[aeiouy]/.test(s[0]) ? 'A' : s[0];
  const rest = s.slice(1).replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
  return first + rest;
}

// Characters that read the same as numbers: 两 = 二, 〇 = 零.
const HAN_EQUIV = { 两: '二', '\u3007': '零' };

export function makeToken(n, kind) {
  if (kind === 'han' && HAN_EQUIV[n]) n = HAN_EQUIV[n];
  const tok = { n, kind };
  if (kind === 'han') {
    tok.py = pinyinOf(n);
    tok.fz = fuzzyPinyin(tok.py);
  } else if (kind === 'word') {
    tok.stem = stemEn(n);
    tok.key = phoneticKey(n);
  }
  return tok;
}

// Split text into display pieces. Each piece: {t, kind, toks?}
// kind: 'han' | 'num' | 'word' | 'space' | 'punct' | 'cue' | 'math'.
// toks: normalized tokens used for matching (numbers may expand to several).
// Math ($…$ inline, $$…$$ display, optionally followed by {its reading}) is
// one piece: t is the reading (spoken words), tex the formula; its tokens
// come from the reading, generated from the formula in English scripts when
// none is given.
const MATH_RE = /\$\$([\s\S]+?)\$\$(?:\{([^{}]*)\})?|\$(?=\S)((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)(?:\{([^{}]*)\})?/g;

export function pieces(text, lang) {
  if (!text.includes('$')) return plainPieces(text, lang);
  const out = [];
  let last = 0;
  MATH_RE.lastIndex = 0;
  for (const m of text.matchAll(MATH_RE)) {
    if (m.index > last) out.push(...plainPieces(text.slice(last, m.index), lang));
    out.push(mathPiece(m, lang));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...plainPieces(text.slice(last), lang));
  return out;
}

function mathPiece(m, lang) {
  const display = m[1] !== undefined;
  const tex = (display ? m[1] : m[3]).trim();
  const given = display ? m[2] : m[4];
  const reading = given != null ? given.trim() : lang === 'zh' ? '' : readTex(tex);
  const toks = reading ? plainPieces(reading, lang).flatMap((p) => p.toks || []) : [];
  const piece = { t: reading, kind: 'math', tex, display, explicit: given != null };
  if (toks.length) piece.toks = toks;
  return piece;
}

function plainPieces(text, lang) {
  const out = [];
  PIECE_RE.lastIndex = 0;
  let m;
  while ((m = PIECE_RE.exec(text))) {
    if (m[1] !== undefined) out.push({ t: m[1].trim(), kind: 'cue' });
    else if (m[2]) out.push({ t: m[2], kind: 'han', toks: [makeToken(m[2], 'han')] });
    else if (m[3]) {
      let toks;
      if (lang === 'en') toks = numberWordsEn(m[3]).map((w) => makeToken(w, 'word'));
      else {
        const han = numberHanZh(m[3], text[PIECE_RE.lastIndex] || '');
        toks = han ? [...han].map((c) => makeToken(c, 'han')) : [makeToken(m[3].replace(/,/g, ''), 'num')];
      }
      out.push({ t: m[3], kind: 'num', toks });
    } else if (m[4]) out.push({ t: m[4], kind: 'word', toks: [makeToken(normWord(m[4]), 'word')] });
    else if (m[5]) out.push({ t: m[5], kind: 'space' });
    else out.push({ t: m[6], kind: 'punct' });
  }
  return mergeLetters(out);
}

// Spelled-out letters ("y i x i", common when reading formulas) come back
// from recognizers as one word ("YIXI"); speechTokens() joins them the same
// way, so the script does too. The display keeps the spaces.
function mergeLetters(ps) {
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const single = (p) => p && p.kind === 'word' && p.t.length === 1 && /[A-Za-z]/.test(p.t);
    if (!single(ps[i])) {
      out.push(ps[i]);
      continue;
    }
    let j = i;
    const run = [ps[i]];
    while (ps[j + 1] && ps[j + 1].kind === 'space' && ps[j + 1].t === ' ' && single(ps[j + 2])) {
      run.push(ps[j + 1], ps[j + 2]);
      j += 2;
    }
    if (run.length === 1) {
      out.push(ps[i]);
      continue;
    }
    const letters = run.filter((p) => p.kind === 'word').map((p) => p.t).join('');
    out.push({ t: run.map((p) => p.t).join(''), kind: 'word', toks: [makeToken(normWord(letters), 'word')] });
    i = j;
  }
  return out;
}

// Tokens of recognized speech (no display info needed).
export function speechTokens(text, lang) {
  const toks = [];
  for (const p of pieces(text, lang)) if (p.toks) toks.push(...p.toks);
  // Recognizers often spell acronyms letter by letter ("R L H F", "P P O"):
  // a run of two or more single-letter words becomes one word.
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    let j = i;
    while (j < toks.length && toks[j].kind === 'word' && toks[j].n.length === 1) j++;
    if (j - i >= 2) {
      out.push(makeToken(toks.slice(i, j).map((t) => t.n).join(''), 'word'));
      i = j - 1;
    } else out.push(toks[i]);
  }
  return out;
}

// ------------------------------------------------------------- similarity

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Similarity in [0, 1] between a spoken token and a script token.
export function tokenSim(a, b) {
  if (a.n === b.n) return 1;
  if (a.kind === 'han' && b.kind === 'han') {
    if (a.py && a.py === b.py) return 0.85;
    if (a.fz && a.fz === b.fz) return 0.62;
    return 0;
  }
  if (a.kind === 'word' && b.kind === 'word') {
    if (a.stem === b.stem) return 0.9;
    const la = a.n.length;
    const lb = b.n.length;
    if (a.key && a.key === b.key && Math.abs(la - lb) <= 2 && Math.min(la, lb) >= 3) return 0.75;
    if (Math.min(la, lb) < 4 || Math.abs(la - lb) > 3) return 0;
    const r = 1 - levenshtein(a.n, b.n) / Math.max(la, lb);
    return r >= 0.75 ? r * 0.9 : 0;
  }
  return 0;
}
