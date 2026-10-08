// Script parser: turns the speaker's text into sections, paragraphs,
// sentences, fixed highlight phrases and matchable tokens.
//
// Script syntax (all optional):
//   # Heading            section heading (not spoken)
//   [slide] / [slide 3] / [slide 3: Title] / ---    slide boundary
//   // note              stage direction shown as a cue (not spoken)
//   >> short summary     custom outline line for the next paragraph
//   [must] / [必讲]       keep the next paragraph in full at every detail level
//   [[pause]]            inline cue inside a sentence (not spoken)
//   [click]              one click of the slide show here (a build or the next
//                        slide); also [[click]], [next], [build], [点击], [动画],
//                        [下一步] (full-width brackets too), ▶, and [click x2]
//                        for two clicks. A line with only markers joins the
//                        text around it; markers in a heading go with the text
//                        after it.
//   blank line           paragraph break; a single newline is a phrase break

import { detectLang, pieces, isStopToken } from './lang.js';

const SENT_END = /^[。！？!?…]+$|^[.]$/;
const CLAUSE = /^[，,、；;：:—–]$|^——$/;
const CLOSERS = /^["”’）)」』】\]]$/;
const EN_ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'fig', 'no', 'eg', 'ie', 'inc', 'jr', 'sr']);
const EN_CONJ = new Set(['and', 'but', 'or', 'because', 'which', 'that', 'when', 'where', 'while',
  'if', 'so', 'than', 'then', 'after', 'before', 'until', 'although', 'though', 'unless', 'whether']);
const EN_PREP = new Set(['to', 'of', 'in', 'for', 'with', 'on', 'by', 'as', 'from', 'into', 'about', 'toward', 'towards']);
const EN_BINDS_NEXT = new Set(['the', 'a', 'an', 'of', 'to', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
  'this', 'these', 'those', 'very', 'more', 'most', 'in', 'on', 'at', 'for', 'with', 'by']);
const ZH_SPLIT_AFTER = new Set(['的', '了', '和', '与', '是', '在', '就', '也', '都', '而', '把', '被', '让', '对']);

const SLIDE_RE = /^\s*\[(?:slide|幻灯片|页)\s*(\d+)?\s*(?:[:：]\s*(.*?))?\s*\]\s*$/i;
const RULE_RE = /^\s*-{3,}\s*$/;
const HEAD_RE = /^\s*(#{1,6})\s+(.*)$/;
const CUE_RE = /^\s*\/\/\s?(.*)$/;
const OUTLINE_RE = /^\s*>>\s?(.*)$/;

const LIMITS = { zh: { max: 18, min: 3 }, en: { max: 9, min: 2 } };

// Build markers (see the syntax above). Inside the parser they are inline
// cues: [[click]], [[点击 x2]], ...
const BUILD_CUE_RE = /^(?:click|next|build|▶|►|>|点击|动画|下一步)(?:\s*[x×*]\s*(\d+))?$/i;
const BUILD_SHORT_RE = /(?<![[［])[[【［]\s*(click|next|build|点击|动画|下一步)(\s*[x×*]\s*\d+)?\s*[\]】］](?![\]］])/gi;
const BUILD_ARROW_RE = /(?<!\[\[)▶\uFE0F?(\s*[x×*]\s*\d+)?/g;
const CUES_ONLY_RE = /^\s*(?:\[\[[^\]]*\]\]\s*)+$/;

// {count} when an inline cue's text is a build marker, else null.
export function buildCue(text) {
  const m = String(text || '').trim().match(BUILD_CUE_RE);
  if (!m) return null;
  return { count: m[1] ? Math.max(1, Math.min(20, parseInt(m[1], 10))) : 1 };
}

function normalizeBuildMarkers(line) {
  return line.replace(BUILD_SHORT_RE, (_, w, n) => `[[${w}${n || ''}]]`)
    .replace(BUILD_ARROW_RE, (_, n) => `[[▶${n || ''}]]`);
}

function onlyBuildCues(line) {
  if (!CUES_ONLY_RE.test(line)) return false;
  const inner = [...line.matchAll(/\[\[([^\]]*)\]\]/g)].map((m) => m[1]);
  return inner.length > 0 && inner.every((t) => buildCue(t));
}

function unitLen(ps) {
  return ps.reduce((n, p) => n + (p.kind === 'han' || p.kind === 'word' || p.kind === 'num' ? 1 : p.kind === 'math' && p.toks ? 2 : 0), 0);
}

// a spoken unit: words, numbers, characters, and formulas with a reading
function isWordish(p) {
  return p.kind === 'han' || p.kind === 'word' || p.kind === 'num' || (p.kind === 'math' && !!p.toks);
}

// shown but not spoken: inline cues and formulas without a reading
const isMark = (p) => p.kind === 'cue' || (p.kind === 'math' && !p.toks);

// A line that is only a display formula: $$…$$ (with no {reading}).
const DISPLAY_RE = /^\s*\$\$([\s\S]+?)\$\$\s*$/;

// Split one logical line of paragraph text into sentences of phrases.
// Returns [{phrases: [pieces[]], ended: bool}] where ended marks a true
// sentence end (vs. a line break).
function splitLine(ps, lang) {
  const sentences = [];
  let phrases = [];
  let cur = [];
  const endPhrase = () => {
    if (cur.some(isWordish) || cur.some(isMark)) phrases.push(cur);
    else if (cur.length && phrases.length) phrases[phrases.length - 1].push(...cur);
    cur = [];
  };
  const endSentence = (ended) => {
    endPhrase();
    if (phrases.length) sentences.push({ phrases, ended });
    phrases = [];
  };
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    cur.push(p);
    if (p.kind !== 'punct') continue;
    // absorb closing quotes/brackets that follow the punctuation
    while (i + 1 < ps.length && ps[i + 1].kind === 'punct' && CLOSERS.test(ps[i + 1].t)) cur.push(ps[++i]);
    if (SENT_END.test(p.t)) {
      if (p.t === '.') {
        const prev = [...cur].reverse().find(isWordish);
        const next = ps[i + 1];
        const after = ps.slice(i + 1).find(isWordish);
        const abbr = prev && prev.kind === 'word' && (EN_ABBR.has(prev.t.toLowerCase()) || prev.t.length === 1);
        const boundary = !next || (next.kind === 'space' && (!after || !/^[a-z]/.test(after.t)));
        if (abbr || !boundary) continue;
      }
      endSentence(true);
    } else if (CLAUSE.test(p.t)) {
      endPhrase();
    }
  }
  endSentence(false);
  return sentences;
}

let zhSegmenter = null;

// Unit indices u (split before the u-th word-like piece) that fall on a
// Chinese word boundary, so long phrases are not cut inside a word.
function zhUnitBreaks(units) {
  if (!zhSegmenter && typeof Intl !== 'undefined' && Intl.Segmenter) {
    zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  }
  const breaks = new Set();
  if (!zhSegmenter) return null;
  const starts = new Map();
  let off = 0;
  units.forEach((p, u) => {
    starts.set(off, u);
    off += p.t.length;
  });
  let pos = 0;
  for (const seg of zhSegmenter.segment(units.map((p) => p.t).join(''))) {
    pos += seg.segment.length;
    if (starts.has(pos)) breaks.add(starts.get(pos));
  }
  return breaks;
}

// Break a phrase that is too long into two near its middle, preferring
// natural break points. Recurses until every part fits.
function enforceMax(ph, lang) {
  const { max } = LIMITS[lang];
  const n = unitLen(ph);
  if (n <= max) return [ph];
  const unitIdx = [];
  ph.forEach((p, i) => { if (isWordish(p)) unitIdx.push(i); });
  const target = n / 2;
  if (unitIdx.length < 2) return [ph]; // formulas remain atomic
  let best = -1;
  let bestScore = Infinity;
  const zhBreaks = lang === 'zh' ? zhUnitBreaks(unitIdx.map((i) => ph[i])) : null;
  let weight = 0;
  for (let u = 1; u < unitIdx.length; u++) {
    weight += ph[unitIdx[u - 1]].kind === 'math' ? 2 : 1;
    if (weight < 2 || n - weight < 2) continue;
    const i = unitIdx[u]; // split before piece i (u-th unit)
    let score = Math.abs(weight - target);
    const prevP = ph[unitIdx[u - 1]];
    const nextP = ph[i];
    if (lang === 'en') {
      const nw = nextP.t.toLowerCase();
      const pw = prevP.t.toLowerCase();
      if (EN_CONJ.has(nw)) score -= 3.5;
      else if (EN_PREP.has(nw)) score -= 2;
      else if (EN_BINDS_NEXT.has(nw)) score -= 1.5; // start a phrase with "the", "a", ...
      if (EN_BINDS_NEXT.has(pw)) score += 3;
      // two content words in a row are usually one noun phrase
      if (!EN_CONJ.has(nw) && !EN_PREP.has(nw) && !EN_BINDS_NEXT.has(nw) && !EN_BINDS_NEXT.has(pw) && !EN_CONJ.has(pw)) score += 1.2;
    } else {
      if (zhBreaks && !zhBreaks.has(u)) score += 6; // avoid splitting inside a word
      if (ZH_SPLIT_AFTER.has(prevP.t)) score -= 1.5;
      if (prevP.t === '一') score += 4; // 一来, 聊一聊, 一种: keep together
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return [ph];
  let cut = best;
  while (cut > 0 && ph[cut - 1].kind === 'space') cut--;
  const a = ph.slice(0, cut);
  const b = ph.slice(cut);
  while (b.length && b[0].kind === 'space') a.push(b.shift());
  return [...enforceMax(a, lang), ...enforceMax(b, lang)];
}

function mergeTiny(phrases, lang) {
  const { min, max } = LIMITS[lang];
  const out = [];
  for (let i = 0; i < phrases.length; i++) {
    const ph = phrases[i];
    const n = unitLen(ph);
    if (n < min && i + 1 < phrases.length && n + unitLen(phrases[i + 1]) <= max + 2) {
      phrases[i + 1] = [...ph, ...phrases[i + 1]];
      continue;
    }
    if (n < min && out.length && unitLen(out[out.length - 1]) + n <= max + 2) {
      out[out.length - 1] = [...out[out.length - 1], ...ph];
      continue;
    }
    out.push(ph);
  }
  return out;
}

export function parseScript(source, opts = {}) {
  const text = (source || '').replace(/\r\n?/g, '\n');
  const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : detectLang(text);
  const doc = {
    lang,
    title: opts.title || '',
    blocks: [],
    sections: [],
    paras: [],
    sents: [],
    phrases: [],
    tokens: [],
    vocab: [],
    slides: [],
    cues: [],
    builds: [], // [{idx, tok, count, slide, section, phrase}]: click markers
  };

  let section = null;
  let slideCounter = 0;
  let curSlide = null; // the slide the text belongs to (headings inside a slide keep it)
  const newSection = (title, slide) => {
    closeSection();
    section = {
      idx: doc.sections.length, title: title || '', slide: slide ?? null,
      paraStart: doc.paras.length, paraEnd: doc.paras.length,
      tokStart: doc.tokens.length, tokEnd: doc.tokens.length,
    };
    doc.sections.push(section);
    if (slide != null) doc.slides.push({ n: slide, section: section.idx, tokStart: section.tokStart, title: title || '' });
    return section;
  };
  const closeSection = () => {
    if (!section) return;
    section.paraEnd = doc.paras.length;
    section.tokEnd = doc.tokens.length;
  };

  let pendingOutline = null;
  let pendingMust = false;
  let paraLines = [];
  let lastWasSlideMarker = false;
  let pendingBuilds = ''; // marker-only lines waiting for the next text line

  // Markers left at the end of a slide (no text after them on that slide)
  // stand on their own at the end of the slide's text.
  const flushBuilds = () => {
    if (!pendingBuilds) return;
    for (const m of pendingBuilds.matchAll(/\[\[([^\]]*)\]\]/g)) {
      const piece = { t: m[1].trim(), kind: 'cue' };
      registerBuild(piece, null);
      if (piece.build != null) doc.blocks.push({ type: 'build', build: piece.build });
    }
    pendingBuilds = '';
  };

  const flushPara = () => {
    if (!paraLines.length) return;
    if (!section) newSection('', null);
    const para = {
      idx: doc.paras.length, section: section.idx, outline: pendingOutline, must: pendingMust,
      sentStart: doc.sents.length, sentEnd: doc.sents.length,
      tokStart: doc.tokens.length, tokEnd: doc.tokens.length, text: '',
    };
    pendingOutline = null;
    pendingMust = false;
    doc.paras.push(para);
    doc.blocks.push({ type: 'para', para: para.idx });

    // Build sentences across lines: a line that does not end a sentence
    // still ends a phrase; the sentence continues onto the next line.
    let openSentence = null;
    for (const line of paraLines) {
      const ps = pieces(line, lang);
      const sentences = splitLine(ps, lang);
      for (const s of sentences) {
        if (openSentence) {
          openSentence.phrases.push(...s.phrases);
          openSentence.ended = s.ended;
        } else {
          openSentence = s;
        }
        if (openSentence.ended) {
          addSentence(para, openSentence.phrases);
          openSentence = null;
        }
      }
    }
    if (openSentence) addSentence(para, openSentence.phrases);
    para.sentEnd = doc.sents.length;
    para.tokEnd = doc.tokens.length;
    para.text = doc.sents.slice(para.sentStart, para.sentEnd).map((s) => s.text).join(lang === 'zh' ? '' : ' ');
    paraLines = [];
  };

  // A build marker piece gets its click position: the next token's index.
  const registerBuild = (piece, phraseIdx) => {
    const b = buildCue(piece.t);
    if (!b) return;
    piece.build = doc.builds.length;
    doc.builds.push({
      idx: doc.builds.length, tok: doc.tokens.length, count: b.count,
      slide: curSlide, section: section ? section.idx : null, phrase: phraseIdx,
    });
  };

  const addSentence = (para, rawPhrases) => {
    let phrases = [];
    for (const ph of rawPhrases) phrases.push(...enforceMax(ph, lang));
    phrases = mergeTiny(phrases, lang);
    if (!phrases.length) return;
    // Only cues and no words (a marker or a formula after the last
    // sentence of a paragraph): they join the paragraph's last phrase
    // instead of making an empty sentence.
    if (!phrases.some((ph) => ph.some((p) => p.toks))) {
      const last = doc.phrases[doc.phrases.length - 1];
      for (const p of phrases.flat().filter(isMark)) {
        const piece = p.kind === 'math' ? { t: p.t, kind: 'math', tex: p.tex, display: p.display } : { t: p.t, kind: 'cue' };
        if (last && last.para === para.idx) {
          if (piece.kind === 'cue') registerBuild(piece, last.idx);
          last.pieces.push(piece);
        } else if (piece.kind === 'math') {
          doc.blocks.push({ type: 'math', tex: piece.tex });
        } else {
          registerBuild(piece, null);
          if (piece.build != null) doc.blocks.push({ type: 'build', build: piece.build });
        }
      }
      return;
    }
    const sent = {
      idx: doc.sents.length, para: para.idx, section: para.section,
      phStart: doc.phrases.length, phEnd: doc.phrases.length,
      tokStart: doc.tokens.length, tokEnd: doc.tokens.length, text: '',
    };
    doc.sents.push(sent);
    for (const ph of phrases) {
      // trim leading spaces
      while (ph.length && ph[0].kind === 'space') ph.shift();
      const phrase = {
        idx: doc.phrases.length, sent: sent.idx, para: para.idx, section: para.section,
        tokStart: doc.tokens.length, tokEnd: doc.tokens.length, pieces: [], text: '',
      };
      for (const p of ph) {
        const piece = { t: p.t, kind: p.kind };
        if (p.kind === 'cue') registerBuild(piece, phrase.idx);
        if (p.kind === 'math') {
          piece.tex = p.tex;
          piece.display = p.display;
          piece.explicit = p.explicit;
        }
        if (p.toks) {
          piece.tok = doc.tokens.length;
          for (const tk of p.toks) doc.tokens.push({ ...tk, phrase: phrase.idx, piece: phrase.pieces.length });
          piece.tokEnd = doc.tokens.length;
        }
        phrase.pieces.push(piece);
      }
      phrase.tokEnd = doc.tokens.length;
      phrase.text = ph.filter((p) => p.kind !== 'cue').map((p) => p.t).join('').replace(/\s+/g, ' ').trim();
      doc.phrases.push(phrase);
    }
    sent.phEnd = doc.phrases.length;
    sent.tokEnd = doc.tokens.length;
    sent.text = doc.phrases.slice(sent.phStart, sent.phEnd).map((p) => p.text).join(lang === 'zh' ? '' : ' ');
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    let m;
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (/^\s*\[(?:must|必讲)\]\s*$/i.test(line)) {
      flushPara();
      pendingMust = true;
      continue;
    }
    if ((m = line.match(SLIDE_RE)) || RULE_RE.test(line)) {
      flushPara();
      flushBuilds();
      // Markdown-deck convention (Marp, reveal.js): `---` separates slides,
      // so whatever precedes the first separator is slide 1.
      if (!m && !doc.slides.length && doc.blocks.length) {
        const first = doc.sections[0];
        first.slide = 1;
        doc.slides.push({ n: 1, section: first.idx, tokStart: first.tokStart, title: first.title || '' });
        const at = doc.blocks.findIndex((b) => b.type === 'para' || b.type === 'heading');
        doc.blocks.splice(Math.max(0, at), 0, { type: 'slide', n: 1, title: first.title || '', section: first.idx });
        slideCounter = 1;
        for (const b of doc.builds) if (b.slide == null) b.slide = 1;
      }
      const n = m && m[1] ? parseInt(m[1], 10) : slideCounter + 1;
      slideCounter = n;
      curSlide = n;
      const title = m && m[2] ? m[2] : '';
      const s = newSection(title, n);
      doc.blocks.push({ type: 'slide', n, title, section: s.idx });
      lastWasSlideMarker = true;
      continue;
    }
    if ((m = line.match(HEAD_RE))) {
      flushPara();
      flushBuilds();
      // a marker in a heading clicks where the text after the heading starts
      const marked = normalizeBuildMarkers(m[2]);
      const marks = [...marked.matchAll(/\[\[([^\]]*)\]\]/g)].filter((x) => buildCue(x[1])).map((x) => x[0]);
      for (const x of marks) pendingBuilds += `${x} `;
      const title = (marks.length ? marks.reduce((t, x) => t.replace(x, ' '), marked) : m[2]).replace(/\s+/g, ' ').trim();
      if (lastWasSlideMarker && section && !section.title && section.paraStart === doc.paras.length) {
        section.title = title;
        const sl = doc.slides[doc.slides.length - 1];
        if (sl && sl.section === section.idx) sl.title = title;
        const blk = [...doc.blocks].reverse().find((b) => b.type === 'slide');
        if (blk) blk.title = title;
      } else {
        const s = newSection(title, null);
        doc.blocks.push({ type: 'heading', level: m[1].length, text: title, section: s.idx });
      }
      lastWasSlideMarker = false;
      continue;
    }
    lastWasSlideMarker = false;
    if ((m = line.match(CUE_RE))) {
      flushPara();
      const cue = { idx: doc.cues.length, text: m[1], beforeToken: doc.tokens.length };
      doc.cues.push(cue);
      doc.blocks.push({ type: 'cue', cue: cue.idx, text: m[1] });
      continue;
    }
    if ((m = line.match(OUTLINE_RE))) {
      flushPara();
      pendingOutline = m[1].trim();
      continue;
    }
    if ((m = line.match(DISPLAY_RE))) {
      // a display formula on its own line: shown, not spoken
      flushPara();
      doc.blocks.push({ type: 'math', tex: m[1].trim(), beforeToken: doc.tokens.length });
      continue;
    }
    const text = normalizeBuildMarkers(line);
    if (onlyBuildCues(text)) {
      // a line of markers belongs to the text around it
      if (paraLines.length) paraLines[paraLines.length - 1] += ` ${text.trim()}`;
      else pendingBuilds += `${text.trim()} `;
      continue;
    }
    paraLines.push(pendingBuilds ? `${pendingBuilds}${text}` : text);
    pendingBuilds = '';
  }
  flushPara();
  flushBuilds();
  if (!doc.sections.length) newSection('', null);
  closeSection();

  // vocabulary + informativeness weights
  const vocabIndex = new Map();
  const freq = new Map();
  for (const t of doc.tokens) freq.set(t.n, (freq.get(t.n) || 0) + 1);
  for (const t of doc.tokens) {
    let vid = vocabIndex.get(t.n);
    if (vid === undefined) {
      vid = doc.vocab.length;
      vocabIndex.set(t.n, vid);
      const { n, kind, py, fz, stem, key } = t;
      doc.vocab.push({ n, kind, py, fz, stem, key });
    }
    t.vid = vid;
    const base = isStopToken(t) ? 0.35 : t.kind === 'num' ? 1.2 : 1.0;
    t.w = base * (0.55 + 0.45 / Math.sqrt(freq.get(t.n)));
    t.stop = isStopToken(t);
  }
  doc.vocabIndex = vocabIndex;
  return doc;
}

// Text helpers used by the UI and the semantic layer.
export function phraseText(doc, i) {
  return doc.phrases[i] ? doc.phrases[i].text : '';
}

export function textOfPhrases(doc, a, b) {
  const sep = doc.lang === 'zh' ? '' : ' ';
  return doc.phrases.slice(Math.max(0, a), Math.max(0, b)).map((p) => p.text).join(sep);
}

export function phraseAtToken(doc, tok) {
  if (!doc.tokens.length) return 0;
  if (tok >= doc.tokens.length) return doc.phrases.length - 1;
  return doc.tokens[Math.max(0, tok)].phrase;
}

// Rare, distinctive terms for recognizer biasing (contextual strings).
export function distinctiveTerms(doc, limit = 80) {
  const counts = new Map();
  for (const ph of doc.phrases) {
    for (const p of ph.pieces) {
      if (p.kind === 'word' && (/[A-Z]/.test(p.t.slice(1)) || /^[A-Z]/.test(p.t) || p.t.length >= 9)) {
        counts.set(p.t, (counts.get(p.t) || 0) + 1);
      }
    }
    if (doc.lang === 'zh') {
      // Latin terms inside Chinese text are the usual recognizer trouble spots.
      const m = ph.text.match(/[A-Za-z][A-Za-z0-9\-]+/g);
      if (m) for (const w of m) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}
