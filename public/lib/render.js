// Prompter renderer: builds the DOM for a document at a granularity level,
// applies highlight classes from the follower's view, and scrolls the
// current phrase to the reading line with smooth, pace-aware motion.

import { outlineItems } from './outline.js';
import { toMathML } from './math.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Renderer {
  constructor({ stage, scroller, content, onPick }) {
    this.stage = stage;
    this.scroller = scroller;
    this.content = content;
    this.onPick = onPick;
    this.level = 0;
    this.detail = 0.5;
    this.mathMode = 'formula'; // 'formula' | 'both' (formula + reading) | 'words'
    this.readingLine = 0.38;
    this.wordProgress = true;
    this.y = 0;
    this.targetY = 0;
    this.tau = 0.25;
    this.manualUntil = 0;
    this.manualOffset = 0;
    this.lastView = null;
    this._raf = null;
    this.content.addEventListener('click', (e) => this._click(e));
    this.stage.addEventListener('wheel', (e) => {
      this.manualOffset += e.deltaY;
      this.manualUntil = performance.now() + 2500;
      this._kick();
    }, { passive: true });
    window.addEventListener('resize', () => this.relayout());
  }

  setDoc(doc, analysis) {
    this.doc = doc;
    this.analysis = analysis;
    this.build();
    this.snap = true; // a new script appears in place, without scrolling
  }

  setAnalysis(analysis) {
    this.analysis = analysis;
    if (this.level > 0) this.build();
  }

  setLevel(level) {
    this.level = level;
    this.build();
  }

  setMathMode(mode) {
    this.mathMode = mode;
    this.build();
  }

  setDetail(detail) {
    this.detail = detail;
    if (this.level === 1 || this.level === 2) this.build();
  }

  // ------------------------------------------------------------- building

  _phraseEl(ph) {
    const span = el('span', 'ph');
    span.dataset.ph = ph.idx;
    for (const p of ph.pieces) {
      if (p.kind === 'math') {
        const m = this._mathEl(p);
        if (p.tok !== undefined) {
          m.classList.add('w');
          m.dataset.t = p.tok;
          m.dataset.te = p.tokEnd;
          for (let k = p.tok; k < p.tokEnd; k++) this.wordEls[k] = m;
        }
        span.appendChild(m);
      } else if (p.kind === 'cue' && p.build != null) {
        span.appendChild(this._buildEl(p.build));
      } else if (p.kind === 'cue') {
        span.appendChild(el('span', 'icue', p.t));
      } else if (p.tok !== undefined) {
        const w = el('span', 'w', p.t);
        w.dataset.t = p.tok;
        w.dataset.te = p.tokEnd;
        span.appendChild(w);
        for (let k = p.tok; k < p.tokEnd; k++) this.wordEls[k] = w;
      } else {
        span.appendChild(document.createTextNode(p.t));
      }
    }
    this.phEls[ph.idx] = span;
    return span;
  }

  // A formula: rendered MathML, its reading, or both (reading under it).
  _mathEl(p) {
    const e = el('span', `mth${p.display ? ' disp' : ''}`);
    const words = p.t || '';
    if (this.mathMode === 'words' && words) {
      e.textContent = words;
      return e;
    }
    const f = el('span', 'mth-f');
    f.innerHTML = toMathML(p.tex, { display: !!p.display });
    if (this.mathMode === 'both' && words) {
      const r = document.createElement('ruby');
      r.appendChild(f);
      r.appendChild(el('rt', null, words));
      e.appendChild(r);
    } else {
      e.appendChild(f);
      if (words) e.title = words;
    }
    return e;
  }

  // Text with $…$ formulas (cues, display lines): formulas rendered.
  _richEl(tag, cls, text) {
    const e = el(tag, cls);
    const re = /\$\$([\s\S]+?)\$\$|\$(?=\S)((?:\\.|[^$\\\n])+?)(?<=\S)\$(?!\d)(?:\{[^{}]*\})?/g;
    let last = 0;
    for (const m of String(text || '').matchAll(re)) {
      if (m.index > last) e.appendChild(document.createTextNode(text.slice(last, m.index)));
      const f = el('span', 'mth');
      f.innerHTML = toMathML(m[1] ?? m[2], { display: false });
      e.appendChild(f);
      last = m.index + m[0].length;
    }
    if (last < String(text || '').length) e.appendChild(document.createTextNode(text.slice(last)));
    return e;
  }

  _mathBlock(tex) {
    const d = el('div', 'mblock');
    d.innerHTML = toMathML(tex, { display: true });
    return d;
  }

  // A click marker: a small chip that shows whether its build is out yet.
  _buildEl(idx) {
    const b = this.doc.builds[idx];
    const e = el('span', 'bmk', b && b.count > 1 ? `▶×${b.count}` : '▶');
    e.dataset.b = idx;
    this.buildEls.push(e);
    return e;
  }

  // stateOf(idx) -> 'done' | 'next' | 'todo'
  markBuilds(stateOf) {
    this.buildState = stateOf;
    for (const e of this.buildEls) {
      const st = stateOf(+e.dataset.b);
      const cls = `bmk ${st}`;
      if (e.className !== cls) e.className = cls;
    }
  }

  _sentenceInto(parent, si) {
    const doc = this.doc;
    const s = doc.sents[si];
    for (let pi = s.phStart; pi < s.phEnd; pi++) {
      if (doc.lang !== 'zh' && parent.childNodes.length) parent.appendChild(document.createTextNode(' '));
      parent.appendChild(this._phraseEl(doc.phrases[pi]));
    }
  }

  _rangeEl(tag, cls, text, a, b) {
    const e = el(tag, cls, text);
    e.dataset.a = a;
    e.dataset.b = b;
    this.rangeEls.push(e);
    return e;
  }

  build() {
    const doc = this.doc;
    this.content.innerHTML = '';
    this.phEls = [];
    this.wordEls = [];
    this.rangeEls = [];
    this.markEls = [];
    this.buildEls = [];
    if (!doc) return;
    const root = this.content;
    root.dataset.level = this.level;
    root.lang = doc.lang === 'zh' ? 'zh-CN' : 'en';
    if (this.level === 0) {
      for (const blk of doc.blocks) {
        if (blk.type === 'heading') root.appendChild(this._markEl('h2', 'sec-h', blk.text, doc.sections[blk.section].tokStart));
        else if (blk.type === 'slide') root.appendChild(this._slideEl(blk));
        else if (blk.type === 'cue') root.appendChild(this._richEl('div', 'cue', blk.text));
        else if (blk.type === 'math') root.appendChild(this._mathBlock(blk.tex));
        else if (blk.type === 'build') {
          const d = el('div', 'bmk-line');
          d.appendChild(this._buildEl(blk.build));
          root.appendChild(d);
        } else if (blk.type === 'para') {
          const p = el('p', 'para');
          const para = doc.paras[blk.para];
          if (para.must) p.classList.add('required');
          for (let si = para.sentStart; si < para.sentEnd; si++) this._sentenceInto(p, si);
          root.appendChild(p);
        }
      }
    } else {
      const items = outlineItems(doc, this.analysis, this.level, this.detail);
      for (const it of items) {
        if (it.type === 'heading') root.appendChild(this._markEl('h2', 'sec-h', it.text, it.tokStart));
        else if (it.type === 'slide') root.appendChild(this._slideEl(it));
        else if (it.type === 'cue') root.appendChild(this._richEl('div', 'cue', it.text));
        else if (it.type === 'math') root.appendChild(this._mathBlock(it.tex));
        else if (it.type === 'bullet') {
          const b = this._rangeEl('div', `bullet${it.custom ? ' custom' : ''}`, it.text, it.tokStart, it.tokEnd);
          root.appendChild(b);
        } else if (it.type === 'group') {
          if (this.level === 1) {
            const p = el('p', it.must ? 'para required' : 'para');
            for (const c of it.children) {
              if (c.type === 'full') this._sentenceInto(p, c.sent);
              else if (c.type === 'cue-sent') {
                if (doc.lang !== 'zh' && p.childNodes.length) p.appendChild(document.createTextNode(' '));
                p.appendChild(this._rangeEl('span', 'kp-sent', `…${c.text}…`, c.tokStart, c.tokEnd));
              }
            }
            root.appendChild(p);
          } else {
            const ul = el('ul', it.must ? 'points required' : 'points');
            for (const c of it.children) {
              const cls = c.type === 'custom' ? 'pt custom' : `pt${c.main ? ' main' : ''}${c.minor ? ' minor' : ''}`;
              if (c.type === 'full') {
                const li = el('li', cls);
                this._sentenceInto(li, c.sent);
                ul.appendChild(li);
              } else ul.appendChild(this._rangeEl('li', cls, c.text, c.tokStart, c.tokEnd));
            }
            root.appendChild(ul);
          }
        }
      }
      if (this.level === 4) {
        // headings-only view: show progress under each section heading
        for (const m of this.markEls) {
          const sec = doc.sections.find((x) => x.tokStart === +m.dataset.a && x.tokEnd > x.tokStart);
          if (!sec) continue;
          const bar = el('div', 'sec-bar');
          bar.appendChild(el('div', 'fill'));
          m.appendChild(bar);
        }
      }
    }
    this.lastApplied = new Map();
    if (this.buildState) this.markBuilds(this.buildState);
    this.relayout();
    if (this.lastView) this.update(this.lastView, true);
  }

  // Token starts of what is visible in outline levels (for ←/→).
  itemStarts() {
    const xs = new Set();
    for (const e of [...this.rangeEls, ...this.markEls]) xs.add(+e.dataset.a);
    return [...xs].sort((a, b) => a - b);
  }

  _markEl(tag, cls, text, tokStart) {
    const e = el(tag, cls, text);
    e.dataset.a = tokStart;
    this.markEls.push(e);
    return e;
  }

  _slideEl(blk) {
    const d = el('div', 'slide-mark');
    d.dataset.slide = blk.n;
    d.dataset.a = this.doc.sections[blk.section].tokStart;
    d.appendChild(el('span', 'n', `${blk.n}`));
    if (blk.title || blk.text) d.appendChild(el('span', 't', blk.title || blk.text));
    this.markEls.push(d);
    return d;
  }

  _click(e) {
    const w = e.target.closest('.w');
    if (w && this.onPick) return this.onPick(+w.dataset.t);
    const ph = e.target.closest('.ph');
    if (ph && this.onPick) return this.onPick(this.doc.phrases[+ph.dataset.ph].tokStart);
    const r = e.target.closest('[data-a]');
    if (r && this.onPick) this.onPick(+r.dataset.a);
  }

  // ------------------------------------------------------------- updates

  update(v, force = false) {
    this.lastView = v;
    const doc = this.doc;
    if (!doc) return;
    const cur = v.phrase;
    const ahead = v.aheadPhrase;
    const pos = v.pos;
    let target = null;
    // phrases (verbatim and full sentences in condensed mode)
    for (let i = 0; i < this.phEls.length; i++) {
      const e = this.phEls[i];
      if (!e) continue;
      let cls = 'ph';
      if (i < cur) cls += ' done';
      else if (i === cur) cls += ' cur';
      else if (i <= ahead) cls += ' ahead';
      if (v.skipped && v.skipped.has(i)) cls += ' skipped';
      if (force || this.lastApplied.get(e) !== cls) {
        e.className = cls;
        this.lastApplied.set(e, cls);
      }
      if (i === cur) target = e;
    }
    // word progress inside the current phrase
    if (this.wordProgress) {
      const ph = doc.phrases[cur];
      const lo = ph ? Math.max(0, ph.tokStart - 40) : 0;
      const hi = ph ? Math.min(doc.tokens.length, ph.tokEnd + 40) : 0;
      for (let k = lo; k < hi; k++) {
        const w = this.wordEls[k];
        if (!w || +w.dataset.t !== k) continue;
        const said = +w.dataset.te <= pos;
        if (w.classList.contains('said') !== said) w.classList.toggle('said', said);
      }
    }
    // outline ranges
    let curRange = null;
    for (const e of this.rangeEls) {
      const a = +e.dataset.a;
      const b = +e.dataset.b;
      let cls = e.className.replace(/\s*\b(done|cur|ahead)\b/g, '');
      const hp = Math.min(pos, doc.tokens.length - 1);
      if (b <= hp && !(a === b)) cls += ' done';
      else if (a <= hp && hp < b && !curRange) {
        cls += ' cur';
        curRange = e;
      }
      if (e.className !== cls) e.className = cls;
    }
    if (curRange && (this.level >= 2 || !target)) target = curRange;
    // section marks: active heading/slide, and progress bars in level 4
    let activeMark = null;
    for (const m of this.markEls) {
      if (+m.dataset.a <= pos) activeMark = m;
    }
    for (const m of this.markEls) {
      const on = m === activeMark;
      if (m.classList.contains('active') !== on) m.classList.toggle('active', on);
    }
    if (this.level === 4) {
      const sections = doc.sections;
      for (const m of this.markEls) {
        const a = +m.dataset.a;
        const sec = sections.find((s) => s.tokStart === a && s.tokEnd > s.tokStart) || null;
        const fill = m.querySelector('.fill');
        if (sec && fill) {
          const n = Math.max(1, sec.tokEnd - sec.tokStart);
          fill.style.width = `${Math.max(0, Math.min(1, (pos - sec.tokStart) / n)) * 100}%`;
        }
      }
      if (activeMark) target = activeMark;
    }
    if (!target && activeMark) target = activeMark;
    // pace-aware scroll smoothing: faster speech -> snappier motion
    const r = v.rate || 3;
    this.tau = Math.max(0.12, Math.min(0.45, 0.9 / (r + 1)));
    this._setTarget(target);
  }

  _setTarget(target) {
    if (!target) return;
    this.targetEl = target;
    const stageH = this.stage.clientHeight;
    // center the target's first line on the reading line
    const { top, height } = this._firstLine(target);
    this.targetY = Math.max(0, top + height / 2 - stageH * this.readingLine);
    if (this.snap) {
      this.snap = false;
      this.y = this.targetY;
      this.content.style.transform = `translate3d(0, ${-this.y.toFixed(1)}px, 0)`;
      return;
    }
    this._kick();
  }

  // Layout position (offsetTop is not affected by the mirror/flip
  // transforms), so the scroll math is the same in every display mode.
  _firstLine(e) {
    let top = 0;
    for (let n = e; n && n !== this.content; n = n.offsetParent) top += n.offsetTop;
    const rects = e.getClientRects();
    const r0 = rects[0] || e.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(e).fontSize) || 16;
    let height = r0.height;
    // a phrase that starts with a word or two at the end of a line: aim at
    // the next line, where most of it is
    if (rects.length > 1 && r0.width < fs * 2.6) {
      top += Math.abs(rects[1].top - r0.top) || height;
      height = rects[1].height;
    }
    return { top, height };
  }

  relayout() {
    if (this.targetEl) this._setTarget(this.targetEl);
  }

  _kick() {
    if (this._raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      let goal = this.targetY;
      if (now < this.manualUntil) goal += this.manualOffset;
      else this.manualOffset = 0;
      const k = 1 - Math.exp(-dt / this.tau);
      this.y += (goal - this.y) * k;
      if (Math.abs(goal - this.y) < 0.4 && now >= this.manualUntil) this.y = goal;
      this.content.style.transform = `translate3d(0, ${-this.y.toFixed(1)}px, 0)`;
      if (this.y !== goal || now < this.manualUntil) this._raf = requestAnimationFrame(step);
      else this._raf = null;
    };
    this._raf = requestAnimationFrame(step);
  }
}
