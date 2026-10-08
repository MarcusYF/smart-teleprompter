// Outline / summary mode. Jev cannot write text, so summaries are built by
// selection: every sentence gets an importance score and a key fragment
// chosen from its own words, and every paragraph gets a main sentence.
// Changing the granularity only re-filters these judgments; nothing is
// re-computed.

import { isStopToken } from './lang.js';

export const KP_MAX = { zh: 12, en: 7 };
export const KP_MIN = { zh: 3, en: 2 };
export const LEVELS = [
  { id: 0, key: 'verbatim' },
  { id: 1, key: 'condensed' },
  { id: 2, key: 'points' },
  { id: 3, key: 'outline' },
  { id: 4, key: 'headings' },
];

const WORDISH = new Set(['han', 'word', 'num']);

let segmenter = null;
function zhWords(text) {
  if (!segmenter && typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  if (!segmenter) return [...text].map((c) => c);
  return [...segmenter.segment(text)].map((s) => s.segment);
}

// A document piece is a function word if its (first) token is one. Pieces of
// a parsed document carry token indices, not tokens.
function pieceIsStop(p, doc) {
  if (p.toks && p.toks.length) return isStopToken(p.toks[0]);
  return p.tok !== undefined && !!(doc && doc.tokens[p.tok] && doc.tokens[p.tok].stop);
}

function windowText(ph, a, b) {
  return ph.pieces.slice(a, b + 1).filter((p) => p.kind !== 'cue').map((p) => p.t).join('')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

// Candidate key fragments for a sentence: whole short phrases plus
// word-aligned windows inside longer ones.
export function keyphraseCandidates(doc, sentIdx, limit = 36) {
  const lang = doc.lang;
  const sent = doc.sents[sentIdx];
  const out = [];
  const seen = new Set();
  const add = (phIdx, a, b, units, content) => {
    const ph = doc.phrases[phIdx];
    const text = windowText(ph, a, b);
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ phrase: phIdx, pa: a, pb: b, text, units, content });
  };
  for (let pi = sent.phStart; pi < sent.phEnd; pi++) {
    const ph = doc.phrases[pi];
    // word-like pieces with their piece index
    const units = [];
    ph.pieces.forEach((p, i) => { if (WORDISH.has(p.kind)) units.push({ i, p }); });
    if (!units.length) continue;
    const contentOf = (a, b) => units.slice(a, b + 1).filter((u) => !pieceIsStop(u.p, doc)).length;
    // word boundaries (unit indices where a new word starts)
    let starts;
    if (lang === 'zh') {
      starts = new Set([0]);
      const words = zhWords(units.map((u) => u.p.t).join(''));
      let off = 0;
      const byOffset = new Map();
      let acc = 0;
      units.forEach((u, k) => { byOffset.set(acc, k); acc += u.p.t.length; });
      for (const w of words) {
        off += w.length;
        if (byOffset.has(off)) starts.add(byOffset.get(off));
      }
    } else {
      starts = new Set(units.map((_, k) => k));
    }
    // the whole phrase, minus leading/trailing function words (就是…, …的),
    // trimming only whole words (一种 keeps its 一)
    let ua = 0;
    let ub = units.length - 1;
    while (ua < ub && pieceIsStop(units[ua].p, doc) && starts.has(ua + 1)) ua++;
    while (ub > ua && pieceIsStop(units[ub].p, doc) && starts.has(ub)) ub--;
    if (ub - ua + 1 <= KP_MAX[lang] && ub - ua + 1 >= Math.min(KP_MIN[lang], units.length)) add(pi, units[ua].i, units[ub].i, ub - ua + 1, contentOf(ua, ub));
    const startList = [...starts].sort((x, y) => x - y);
    for (let s = 0; s < startList.length; s++) {
      const a = startList[s];
      if (pieceIsStop(units[a].p, doc)) continue;
      for (let e = s + 1; e <= startList.length; e++) {
        const bEnd = e < startList.length ? startList[e] - 1 : units.length - 1;
        const len = bEnd - a + 1;
        if (len > KP_MAX[lang]) break;
        if (len < KP_MIN[lang]) continue;
        if (pieceIsStop(units[bEnd].p, doc)) continue;
        if (a === ua && bEnd === ub) continue; // trimmed whole phrase already added
        add(pi, units[a].i, units[bEnd].i, len, contentOf(a, bEnd));
      }
    }
  }
  // two adjacent phrases of the sentence together (a long clause split by
  // the phrase limit, "Every word looks at every | other word")
  for (let pi = sent.phStart; pi + 1 < sent.phEnd; pi++) {
    const a = doc.phrases[pi];
    const b = doc.phrases[pi + 1];
    const ua = a.pieces.filter((p) => WORDISH.has(p.kind));
    const ub = b.pieces.filter((p) => WORDISH.has(p.kind));
    if (!ua.length || !ub.length || ua.length + ub.length > KP_MAX[lang] + 2) continue;
    if (pieceIsStop(ub[ub.length - 1], doc)) continue;
    // keep the original punctuation between the two phrases
    const aText = a.pieces.filter((p) => p.kind !== 'cue').map((p) => p.t).join('').trim();
    const bText = b.pieces.filter((p) => p.kind !== 'cue').map((p) => p.t).join('').trim();
    const joined = `${aText}${lang === 'zh' ? '' : ' '}${bText}`.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
    if (joined && !seen.has(joined)) {
      seen.add(joined);
      const content = [...ua, ...ub].filter((p) => !pieceIsStop(p, doc)).length;
      out.push({ phrase: pi, pa: 0, pb: a.pieces.length - 1, text: joined, units: ua.length + ub.length, content });
    }
  }
  if (out.length > limit) {
    const keep = new Set(out.map((c, i) => [c.content * 2 + c.units * 0.3, i]).sort((x, y) => y[0] - x[0]).slice(0, limit).map((x) => x[1]));
    return out.filter((_, i) => keep.has(i)).map((c, i) => ({ id: `C${i}`, ...c }));
  }
  return out.map((c, i) => ({ id: `C${i}`, ...c }));
}

const FILLER_RE = /^(thanks?|thank you|welcome|good (morning|afternoon|evening)|hello|hi|ok(ay)?|so|alright|let me|let's|now|next|谢谢|大家好|欢迎|好的|那么|接下来|下面|首先|最后)/i;

// Fallback analysis without Jev: position and length heuristics.
export function heuristicAnalysis(doc) {
  const sents = {};
  const paras = {};
  for (const para of doc.paras) {
    paras[para.idx] = { main: para.sentStart };
    for (let si = para.sentStart; si < para.sentEnd; si++) {
      const s = doc.sents[si];
      const n = s.tokEnd - s.tokStart;
      let imp = si === para.sentStart ? 2.1 : n >= (doc.lang === 'zh' ? 14 : 9) ? 1.6 : 1.0;
      if (/\d/.test(s.text)) imp += 0.4;
      if (FILLER_RE.test(s.text.trim()) && n < (doc.lang === 'zh' ? 10 : 7)) imp = 0.3;
      const cands = keyphraseCandidates(doc, si);
      let kp = cands[0] || null;
      for (const c of cands) if (!kp || c.content > kp.content) kp = c;
      sents[si] = { imp: Math.min(3, imp), kp: kp && { phrase: kp.phrase, pa: kp.pa, pb: kp.pb, text: kp.text }, text: s.text };
    }
  }
  return { source: 'heuristic', sents, paras };
}

// Merge a (possibly partial) Jev analysis over the heuristic one, checking
// that each record still matches the sentence text.
export function mergeAnalysis(doc, base, jev) {
  if (!jev) return base;
  const out = { source: 'jev', sents: { ...base.sents }, paras: { ...base.paras } };
  let used = 0;
  for (const [k, v] of Object.entries(jev.sents || {})) {
    const s = doc.sents[k];
    if (!s || v.text !== s.text) continue;
    out.sents[k] = v;
    used++;
  }
  for (const [k, v] of Object.entries(jev.paras || {})) {
    if (doc.paras[k] && v.text === doc.paras[k].text) out.paras[k] = v;
  }
  if (!used) out.source = base.source;
  return out;
}

// Importance thresholds for a detail setting in [0, 1] (0 = sparse,
// 1 = everything). Jev's scores cluster (filler near 0, content above 2),
// so the cut is taken by rank within this script: at detail d, level 1
// shows the top 25%..100% of sentences in full and level 2 lists the top
// 35%..100% as points. Main sentences always show.
export function thresholds(detail = 0.5, imps = null) {
  const d = Math.max(0, Math.min(1, detail));
  if (!imps || !imps.length) return { full: 2.9 - 2.2 * d, point: 2.8 - 2.6 * d };
  const sorted = [...imps].sort((a, b) => b - a);
  const at = (frac) => (frac >= 1 ? -Infinity : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(frac * sorted.length) - 1))]);
  return { full: at(0.25 + 0.75 * d), point: at(0.35 + 0.65 * d) };
}

// Items for a granularity level. Each item covers a token range so the
// follower's position can highlight it.
export function outlineItems(doc, analysis, level, detail = 0.5) {
  const imps = doc.sents.map((s) => (analysis.sents[s.idx] ? analysis.sents[s.idx].imp : 1.5));
  const thr = thresholds(detail, imps);
  const items = [];
  const push = (it) => items.push(it);
  for (const blk of doc.blocks) {
    if (blk.type === 'heading') {
      push({ type: 'heading', text: blk.text, section: blk.section, tokStart: doc.sections[blk.section].tokStart, tokEnd: doc.sections[blk.section].tokEnd });
      continue;
    }
    if (blk.type === 'slide') {
      push({ type: 'slide', n: blk.n, text: blk.title, section: blk.section, tokStart: doc.sections[blk.section].tokStart, tokEnd: doc.sections[blk.section].tokEnd });
      continue;
    }
    if (blk.type === 'cue') {
      if (level <= 2) push({ type: 'cue', text: blk.text });
      continue;
    }
    if (blk.type === 'math') {
      if (level <= 3) push({ type: 'math', tex: blk.tex });
      continue;
    }
    if (blk.type !== 'para') continue;
    const para = doc.paras[blk.para];
    if (para.must) {
      push({ type: 'group', must: true, para: para.idx, tokStart: para.tokStart, tokEnd: para.tokEnd,
        children: doc.sents.slice(para.sentStart, para.sentEnd).map(s => ({ type: 'full', sent: s.idx, tokStart: s.tokStart, tokEnd: s.tokEnd, main: true })) });
      continue;
    }
    if (level >= 4 || para.sentStart === para.sentEnd) continue;
    const pa = analysis.paras[para.idx] || { main: para.sentStart };
    if (level === 3) {
      let text = para.outline;
      if (!text) {
        const ms = doc.sents[pa.main] || doc.sents[para.sentStart];
        const a = analysis.sents[ms.idx];
        const short = ms.tokEnd - ms.tokStart <= (doc.lang === 'zh' ? 18 : 12);
        text = short ? ms.text : (a && a.kp ? a.kp.text : ms.text);
      }
      push({ type: 'bullet', text, para: para.idx, tokStart: para.tokStart, tokEnd: para.tokEnd, main: true, custom: !!para.outline });
      continue;
    }
    // levels 1 and 2 work per sentence
    const group = { type: 'group', para: para.idx, tokStart: para.tokStart, tokEnd: para.tokEnd, children: [] };
    if (para.outline && level === 2) group.children.push({ type: 'custom', text: para.outline, tokStart: para.tokStart, tokEnd: para.tokStart });
    let lastItem = null;
    let pendingStart = null; // hidden sentences before the first point
    for (let si = para.sentStart; si < para.sentEnd; si++) {
      const s = doc.sents[si];
      const a = analysis.sents[si] || { imp: 1.5, kp: null };
      const isMain = si === pa.main;
      if (level === 1) {
        if (a.imp >= thr.full || isMain || !a.kp) group.children.push({ type: 'full', sent: si, tokStart: s.tokStart, tokEnd: s.tokEnd, main: isMain });
        else group.children.push({ type: 'cue-sent', sent: si, text: a.kp.text, tokStart: s.tokStart, tokEnd: s.tokEnd });
      } else if (a.imp >= thr.point || isMain) {
        lastItem = { type: 'point', sent: si, text: a.kp ? a.kp.text : s.text, tokStart: pendingStart ?? s.tokStart, tokEnd: s.tokEnd, main: isMain, imp: a.imp };
        pendingStart = null;
        group.children.push(lastItem);
      } else if (lastItem) {
        lastItem.tokEnd = s.tokEnd; // hidden sentence folds into the previous point
      } else if (pendingStart === null) {
        pendingStart = s.tokStart;
      }
    }
    if (pendingStart !== null) {
      // the whole paragraph is low-importance: keep one minor point
      const s = doc.sents[para.sentStart];
      const a = analysis.sents[para.sentStart] || {};
      group.children.push({ type: 'point', sent: s.idx, text: a.kp ? a.kp.text : s.text, tokStart: pendingStart, tokEnd: para.tokEnd, minor: true, imp: a.imp });
    }
    push(group);
  }
  return items;
}
