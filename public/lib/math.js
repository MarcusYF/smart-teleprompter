// LaTeX math for the prompter: a small parser for the notation used in
// lecture scripts, turned into MathML (rendered natively by WebKit and
// Chromium, with the system's STIX Two Math font) and into an English
// reading ("one over the norm of w") that the speech tracker can follow.
//
//   toMathML(tex, {display})  -> '<math>…</math>' (never throws; unknown input
//                                is shown as source)
//   readTex(tex)              -> 'one over the norm of w'
//
// Covered: letters, numbers, Greek, ^ _ ' (primes), \frac \dfrac \tfrac
// \binom \sqrt, accents (\hat \tilde \bar \overline \vec \dot), fonts
// (\mathbb \mathbf \mathcal \mathrm \text \operatorname \boldsymbol),
// operators and relations, big operators with limits (\sum \prod \int \max
// \min \arg\min \lim), \left…\right and \big delimiters, spacing, and the
// cases / matrix / array environments.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const GREEK_NAME = Object.fromEntries(Object.entries(GREEK).map(([k, v]) => [v, k.replace(/^var/, '').toLowerCase()]));

// symbol, MathML role, reading
const OPS = {
  '=': ['=', 'rel', 'equals'], '<': ['<', 'rel', 'is less than'], '>': ['>', 'rel', 'is greater than'],
  '+': ['+', 'bin', 'plus'], '-': ['−', 'bin', 'minus'], '*': ['∗', 'bin', 'star'], '/': ['/', 'bin', 'over'],
  ',': [',', 'punct', ''], ';': [';', 'punct', ''], ':': [':', 'rel', ''], '!': ['!', 'post', 'factorial'],
  '.': ['.', 'punct', ''], '?': ['?', 'punct', ''],
  '(': ['(', 'open', ''], ')': [')', 'close', ''], '[': ['[', 'open', ''], ']': [']', 'close', ''],
  '|': ['|', 'fence', ''],
};
const CMD_OPS = {
  neq: ['≠', 'rel', 'is not equal to'], ne: ['≠', 'rel', 'is not equal to'],
  le: ['≤', 'rel', 'less than or equal to'], leq: ['≤', 'rel', 'less than or equal to'],
  ge: ['≥', 'rel', 'greater than or equal to'], geq: ['≥', 'rel', 'greater than or equal to'],
  ll: ['≪', 'rel', 'much less than'], gg: ['≫', 'rel', 'much greater than'],
  approx: ['≈', 'rel', 'is approximately'], sim: ['∼', 'rel', 'is distributed as'], simeq: ['≃', 'rel', 'is approximately'],
  equiv: ['≡', 'rel', 'is equivalent to'], propto: ['∝', 'rel', 'is proportional to'], cong: ['≅', 'rel', 'is congruent to'],
  in: ['∈', 'rel', 'in'], notin: ['∉', 'rel', 'not in'], ni: ['∋', 'rel', 'contains'],
  subset: ['⊂', 'rel', 'subset of'], subseteq: ['⊆', 'rel', 'subset of'], supset: ['⊃', 'rel', 'superset of'], supseteq: ['⊇', 'rel', 'superset of'],
  to: ['→', 'rel', 'to'], rightarrow: ['→', 'rel', 'to'], leftarrow: ['←', 'rel', 'from'], gets: ['←', 'rel', 'gets'],
  mapsto: ['↦', 'rel', 'maps to'], Rightarrow: ['⇒', 'rel', 'implies'], implies: ['⟹', 'rel', 'implies'],
  Leftarrow: ['⇐', 'rel', 'is implied by'], impliedby: ['⟸', 'rel', 'is implied by'],
  Leftrightarrow: ['⇔', 'rel', 'if and only if'], iff: ['⟺', 'rel', 'if and only if'], leftrightarrow: ['↔', 'rel', 'if and only if'],
  perp: ['⊥', 'rel', 'is perpendicular to'], mid: ['∣', 'rel', 'given'], parallel: ['∥', 'rel', 'is parallel to'],
  pm: ['±', 'bin', 'plus or minus'], mp: ['∓', 'bin', 'minus or plus'], cdot: ['⋅', 'bin', 'times'], times: ['×', 'bin', 'times'],
  div: ['÷', 'bin', 'divided by'], ast: ['∗', 'bin', 'star'], star: ['⋆', 'bin', 'star'], circ: ['∘', 'bin', 'composed with'],
  cup: ['∪', 'bin', 'union'], cap: ['∩', 'bin', 'intersect'], setminus: ['∖', 'bin', 'minus'], wedge: ['∧', 'bin', 'and'],
  vee: ['∨', 'bin', 'or'], land: ['∧', 'bin', 'and'], lor: ['∨', 'bin', 'or'], oplus: ['⊕', 'bin', 'direct sum'], otimes: ['⊗', 'bin', 'tensor'],
  colon: [':', 'punct', ''], vert: ['|', 'fence', ''], lvert: ['|', 'open', ''], rvert: ['|', 'close', ''],
  Vert: ['‖', 'fence', ''], lVert: ['‖', 'open', ''], rVert: ['‖', 'close', ''], '|': ['‖', 'fence', ''],
  langle: ['⟨', 'open', ''], rangle: ['⟩', 'close', ''], lfloor: ['⌊', 'open', ''], rfloor: ['⌋', 'close', ''],
  lceil: ['⌈', 'open', ''], rceil: ['⌉', 'close', ''], '{': ['{', 'open', ''], '}': ['}', 'close', ''],
  lbrace: ['{', 'open', ''], rbrace: ['}', 'close', ''], lbrack: ['[', 'open', ''], rbrack: [']', 'close', ''],
  neg: ['¬', 'pre', 'not'], lnot: ['¬', 'pre', 'not'], forall: ['∀', 'pre', 'for all'], exists: ['∃', 'pre', 'there exists'],
  nabla: ['∇', 'pre', 'the gradient of'], partial: ['∂', 'pre', 'partial'],
};
const SYMBOLS = {
  infty: ['∞', 'infinity'], emptyset: ['∅', 'the empty set'], varnothing: ['∅', 'the empty set'], top: ['⊤', 'transpose'],
  bot: ['⊥', 'bottom'], prime: ['′', 'prime'], ell: ['ℓ', 'ell'], hbar: ['ℏ', 'h bar'], dots: ['…', 'and so on'],
  ldots: ['…', 'and so on'], cdots: ['⋯', 'and so on'], vdots: ['⋮', ''], ddots: ['⋱', ''], Re: ['ℜ', 'real part'],
  Im: ['ℑ', 'imaginary part'], aleph: ['ℵ', 'aleph'], checkmark: ['✓', ''],
};
const BIG_OPS = {
  sum: ['∑', 'the sum'], prod: ['∏', 'the product'], int: ['∫', 'the integral'], oint: ['∮', 'the integral'],
  bigcup: ['⋃', 'the union'], bigcap: ['⋂', 'the intersection'], coprod: ['∐', 'the coproduct'],
};
// named operators; true = limits go under/over in display style
const FUNCS = {
  log: false, ln: false, exp: false, sin: false, cos: false, tan: false, sec: false, csc: false, cot: false,
  sinh: false, cosh: false, tanh: false, arcsin: false, arccos: false, arctan: false, det: true, dim: false,
  ker: false, deg: false, gcd: true, Pr: true, max: true, min: true, sup: true, inf: true, lim: true,
  liminf: true, limsup: true, arg: false, sgn: false, sign: false, tr: false, rank: false, diag: false, var: false,
};
const FUNC_READ = { ln: 'natural log', exp: 'exp', Pr: 'the probability', sup: 'the supremum', inf: 'the infimum', lim: 'the limit', det: 'the determinant of', tr: 'the trace of' };
const SPACES = { ',': 0.1667, ':': 0.2222, '>': 0.2222, ';': 0.2778, ' ': 0.25, quad: 1, qquad: 2, '!': -0.1667, enspace: 0.5, thinspace: 0.1667 };
const ACCENTS = { hat: 'ˆ', widehat: '^', tilde: '˜', widetilde: '~', bar: '¯', overline: '‾', vec: '→', dot: '˙', ddot: '¨', check: 'ˇ', breve: '˘', acute: '´', grave: '`' };
const ACCENT_READ = { 'ˆ': 'hat', '^': 'hat', '˜': 'tilde', '~': 'tilde', '¯': 'bar', '‾': 'bar', '→': '', '˙': 'dot', '¨': 'double dot', 'ˇ': 'check', '˘': 'breve', '´': '', '`': '' };
// wide accents stretch over their base; the others keep the glyph size
const WIDE = new Set(['^', '~', '‾', '→']);

// Mathematical alphanumerics for the font commands (MathML Core renders only
// "normal" mathvariant; styled letters are separate Unicode characters).
const SCRIPT_EXC = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' };
const DOUBLE_EXC = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
const FRAKTUR_EXC = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
function styled(ch, font) {
  const up = ch >= 'A' && ch <= 'Z';
  const low = ch >= 'a' && ch <= 'z';
  const dig = ch >= '0' && ch <= '9';
  const cp = (base, i) => String.fromCodePoint(base + i);
  if (font === 'bb') {
    if (DOUBLE_EXC[ch]) return DOUBLE_EXC[ch];
    if (up) return cp(0x1D538, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D552, ch.charCodeAt(0) - 97);
    if (dig) return cp(0x1D7D8, ch.charCodeAt(0) - 48);
  } else if (font === 'bf') {
    if (up) return cp(0x1D400, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D41A, ch.charCodeAt(0) - 97);
    if (dig) return cp(0x1D7CE, ch.charCodeAt(0) - 48);
  } else if (font === 'bi') {
    if (up) return cp(0x1D468, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D482, ch.charCodeAt(0) - 97);
  } else if (font === 'cal') {
    if (SCRIPT_EXC[ch]) return SCRIPT_EXC[ch];
    if (up) return cp(0x1D49C, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D4B6, ch.charCodeAt(0) - 97);
  } else if (font === 'frak') {
    if (FRAKTUR_EXC[ch]) return FRAKTUR_EXC[ch];
    if (up) return cp(0x1D504, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D51E, ch.charCodeAt(0) - 97);
  } else if (font === 'sf') {
    if (up) return cp(0x1D5A0, ch.charCodeAt(0) - 65);
    if (low) return cp(0x1D5BA, ch.charCodeAt(0) - 97);
  }
  return null;
}
// plain letter behind a styled one (for readings)
const PLAIN = new Map();
for (const font of ['bb', 'bf', 'bi', 'cal', 'frak', 'sf']) {
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    const s = styled(c, font);
    if (s) PLAIN.set(s, c);
  }
}

// ------------------------------------------------------------------ lexer

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+\*?|.)/s.exec(src.slice(i));
      if (!m) { i++; continue; }
      toks.push({ k: 'cmd', v: m[1] });
      i += m[0].length;
      // a control word swallows the spaces after it
      if (/[A-Za-z]/.test(m[1][0])) while (i < src.length && src[i] === ' ') i++;
      continue;
    }
    if (/\s/.test(c)) {
      // kept for \text{…}; math mode skips them
      if (toks.length && toks[toks.length - 1].k !== 'space') toks.push({ k: 'space' });
      i++;
      continue;
    }
    if (c === '{' || c === '}' || c === '^' || c === '_' || c === '&' || c === "'") { toks.push({ k: c }); i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
      toks.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) { toks.push({ k: 'let', v: c }); i++; continue; }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    toks.push({ k: 'ch', v: ch });
    i += ch.length;
  }
  return toks;
}

// ----------------------------------------------------------------- parser
// AST nodes: {t: 'row', items} {t: 'mi', v, plain?} {t: 'mn', v} {t: 'mo', v, role, read}
// {t: 'text', v} {t: 'frac', num, den, style} {t: 'sqrt', body, index}
// {t: 'scripts', base, sub, sup} {t: 'accent', base, acc} {t: 'fenced', open, close, body}
// {t: 'table', rows, env} {t: 'space', w} {t: 'func', v, limits}

class Parser {
  constructor(src) {
    this.toks = lex(src);
    this.i = 0;
    this.errors = 0;
  }
  skip() { while (this.toks[this.i] && this.toks[this.i].k === 'space') this.i++; }
  peek() { this.skip(); return this.toks[this.i]; }
  next() { this.skip(); return this.toks[this.i++]; }
  done() { this.skip(); return this.i >= this.toks.length; }

  // expression until a terminator: } \right & \\ \end, or the end
  expr(stop = {}) {
    const items = [];
    while (!this.done()) {
      const t = this.peek();
      if (t.k === '}' && stop.brace) break;
      if (t.k === '&' && stop.cell) break;
      if (t.k === 'cmd' && (t.v === 'right' && stop.right)) break;
      if (t.k === 'cmd' && (t.v === '\\' || t.v === 'cr') && stop.cell) break;
      if (t.k === 'cmd' && t.v === 'end' && stop.cell) break;
      if (t.k === '}') { this.next(); this.errors++; continue; } // stray brace
      const a = this.scripted();
      if (a) items.push(a);
    }
    return { t: 'row', items };
  }

  // one atom with its sub/superscripts and primes
  scripted() {
    let base = this.atom();
    if (base === null) return null;
    let sub = null;
    let sup = null;
    let primes = 0;
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === "'") { this.next(); primes++; continue; }
      if (t.k === '^' && !sup) { this.next(); sup = this.arg(); continue; }
      if (t.k === '_' && !sub) { this.next(); sub = this.arg(); continue; }
      break;
    }
    if (primes) {
      const p = { t: 'mo', v: '′'.repeat(primes), role: 'ord', read: primes === 1 ? 'prime' : primes === 2 ? 'double prime' : 'triple prime' };
      sup = sup ? { t: 'row', items: [p, sup] } : p;
    }
    if (!sub && !sup) return base;
    return { t: 'scripts', base, sub, sup };
  }

  // a group {…} or a single atom (for arguments and scripts)
  arg() {
    const t = this.peek();
    if (!t) { this.errors++; return { t: 'row', items: [] }; }
    // like TeX, an argument without braces is one character: \frac12, x^12
    if (t.k === 'num' && t.v.length > 1 && !t.v.includes('.')) {
      this.next();
      this.toks.splice(this.i, 0, { k: 'num', v: t.v.slice(1) });
      return { t: 'mn', v: t.v[0] };
    }
    if (t.k === '{') {
      this.next();
      const e = this.expr({ brace: true });
      if (this.peek() && this.peek().k === '}') this.next(); else this.errors++;
      return e;
    }
    return this.atom() || { t: 'row', items: [] };
  }

  // raw text inside braces (for \text, \operatorname, environments)
  rawGroup() {
    const t = this.peek();
    if (!t || t.k !== '{') return '';
    this.next();
    let depth = 1;
    let out = '';
    while (!this.done()) {
      const x = this.next();
      if (x.k === '{') depth++;
      if (x.k === '}' && --depth === 0) break;
      out += x.k === 'cmd' ? (/^[A-Za-z]/.test(x.v) ? `\\${x.v} ` : x.v === ' ' ? ' ' : x.v) : x.v ?? x.k;
    }
    return out;
  }

  // the text of a \text{} group, spaces kept: re-lex from the source is not
  // possible, so the lexer's dropped spaces are restored between words
  textGroup() {
    const t = this.peek();
    if (!t || t.k !== '{') return '';
    this.next();
    let depth = 1;
    const parts = [];
    while (this.i < this.toks.length) {
      const x = this.toks[this.i++];
      if (x.k === '{') { depth++; continue; }
      if (x.k === '}') { if (--depth === 0) break; continue; }
      if (x.k === 'space') parts.push(' ');
      else if (x.k === 'cmd') parts.push(x.v === ' ' || x.v === ',' || x.v === ';' ? ' ' : SYMBOLS[x.v]?.[0] ?? GREEK[x.v] ?? '');
      else parts.push(x.v ?? x.k);
    }
    return parts.join('');
  }

  atom() {
    const t = this.next();
    if (!t) return null;
    switch (t.k) {
      case '{': {
        const e = this.expr({ brace: true });
        if (this.peek() && this.peek().k === '}') this.next(); else this.errors++;
        return e;
      }
      case 'let': return { t: 'mi', v: t.v };
      case 'num': return { t: 'mn', v: t.v };
      case 'ch': {
        if (OPS[t.v]) {
          const [v, role, read] = OPS[t.v];
          return { t: 'mo', v, role, read };
        }
        if (GREEK_NAME[t.v]) return { t: 'mi', v: t.v };
        if (/[∀-⋿←-⇿]/.test(t.v)) return { t: 'mo', v: t.v, role: 'rel', read: '' };
        return { t: 'mi', v: t.v };
      }
      case '^': case '_': {
        // a script with no base: attach to an empty row
        this.i--;
        return { t: 'row', items: [] };
      }
      case '&': this.errors++; return null;
      case "'": return { t: 'mo', v: '′', role: 'ord', read: 'prime' };
      case 'cmd': return this.command(t.v);
      default: this.errors++; return null;
    }
  }

  command(name) {
    if (GREEK[name]) return { t: 'mi', v: GREEK[name], up: /^[A-Z]/.test(name) };
    if (CMD_OPS[name]) {
      const [v, role, read] = CMD_OPS[name];
      return { t: 'mo', v, role, read };
    }
    if (SYMBOLS[name]) return { t: 'mo', v: SYMBOLS[name][0], role: name === 'top' || name === 'prime' ? 'ord' : 'ord', read: SYMBOLS[name][1], sym: name };
    if (BIG_OPS[name]) return { t: 'mo', v: BIG_OPS[name][0], role: 'big', read: BIG_OPS[name][1] };
    if (name in FUNCS) {
      // \arg\min and \arg\max read and render as one operator
      if (name === 'arg' && this.peek()?.k === 'cmd' && (this.peek().v === 'min' || this.peek().v === 'max')) {
        const m = this.next().v;
        return { t: 'func', v: `arg ${m}`, limits: true };
      }
      return { t: 'func', v: name, limits: FUNCS[name] };
    }
    if (name in SPACES) return { t: 'space', w: SPACES[name] };
    if (ACCENTS[name]) return { t: 'accent', base: this.arg(), acc: ACCENTS[name] };
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return { t: 'frac', num: this.arg(), den: this.arg(), style: name === 'dfrac' ? 'display' : name === 'tfrac' ? 'text' : null };
      case 'binom': case 'dbinom': case 'tbinom':
        return { t: 'fenced', open: '(', close: ')', body: { t: 'frac', num: this.arg(), den: this.arg(), noline: true } };
      case 'sqrt': {
        let index = null;
        if (this.peek()?.k === 'ch' && this.peek().v === '[') {
          this.next();
          const items = [];
          while (!this.done() && !(this.peek().k === 'ch' && this.peek().v === ']')) {
            const a = this.scripted();
            if (a) items.push(a);
          }
          this.next();
          index = { t: 'row', items };
        }
        return { t: 'sqrt', body: this.arg(), index };
      }
      case 'mathbb': case 'mathbf': case 'mathcal': case 'mathscr': case 'mathfrak': case 'mathsf': case 'boldsymbol': case 'bm': {
        const font = { mathbb: 'bb', mathbf: 'bf', mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak', mathsf: 'sf', boldsymbol: 'bi', bm: 'bi' }[name];
        return restyle(this.arg(), font);
      }
      case 'mathrm': case 'mathit': case 'mathtt': case 'rm': {
        const body = this.arg();
        if (name === 'mathit') return body;
        return upright(body);
      }
      case 'text': case 'textrm': case 'textit': case 'textbf': case 'mbox': case 'textsf': case 'texttt':
        return { t: 'text', v: this.textGroup() };
      case 'operatorname': case 'operatorname*': {
        const v = this.rawGroup().replace(/\\,|\\ /g, ' ').trim();
        return { t: 'func', v, limits: name.endsWith('*') };
      }
      case 'left': case 'bigl': case 'Bigl': case 'biggl': case 'Biggl': {
        if (name !== 'left') return this.delim('open');
        const open = this.delim('open');
        const body = this.expr({ right: true });
        let close = null;
        if (this.peek()?.k === 'cmd' && this.peek().v === 'right') {
          this.next();
          close = this.delim('close');
        } else this.errors++;
        return { t: 'fenced', open: open?.v ?? '', close: close?.v ?? '', body, stretch: true };
      }
      case 'right': this.errors++; return null;
      case 'big': case 'Big': case 'bigg': case 'Bigg': case 'bigm': case 'Bigm':
        return this.delim('fence');
      case 'bigr': case 'Bigr': case 'biggr': case 'Biggr':
        return this.delim('close');
      case 'middle': return this.delim('fence');
      case 'begin': return this.env(this.rawGroup().trim());
      case 'displaystyle': case 'textstyle': case 'scriptstyle': case 'limits': case 'nolimits': case 'mathstrut': case 'strut':
      case 'label': case 'nonumber': case 'notag':
        if (name === 'label') this.rawGroup();
        return { t: 'row', items: [] };
      case 'not': {
        const a = this.atom();
        if (a && a.t === 'mo' && a.v === '=') return { t: 'mo', v: '≠', role: 'rel', read: 'is not equal to' };
        if (a && a.t === 'mo' && a.v === '∈') return { t: 'mo', v: '∉', role: 'rel', read: 'not in' };
        return a;
      }
      case 'phantom': this.arg(); return { t: 'row', items: [] };
      case '[': case ']': case '(': case ')': return { t: 'row', items: [] }; // \[ … \] inside a source
      case 'stackrel': case 'overset': {
        const over = this.arg();
        return { t: 'over', base: this.arg(), over };
      }
      case 'underset': {
        const under = this.arg();
        return { t: 'under', base: this.arg(), under };
      }
      case 'underbrace': case 'overbrace': return this.arg();
      default:
        this.errors++;
        return { t: 'mo', v: `\\${name}`, role: 'ord', read: name, unknown: true };
    }
  }

  delim(role) {
    const t = this.next();
    if (!t) return null;
    if (t.k === 'ch' && OPS[t.v]) return { t: 'mo', v: OPS[t.v][0], role, read: '', stretch: true };
    if (t.k === 'ch' && t.v === '.') return { t: 'mo', v: '', role, read: '' };
    if (t.k === 'cmd' && CMD_OPS[t.v]) return { t: 'mo', v: CMD_OPS[t.v][0], role, read: '', stretch: true };
    if (t.k === 'ch') return { t: 'mo', v: t.v, role, read: '', stretch: true };
    this.errors++;
    return null;
  }

  env(name) {
    const rows = [[]];
    let cell = [];
    if (name === 'array') this.rawGroup(); // column spec
    while (!this.done()) {
      const t = this.peek();
      if (t.k === 'cmd' && t.v === 'end') {
        this.next();
        this.rawGroup();
        break;
      }
      if (t.k === '&') {
        this.next();
        rows[rows.length - 1].push({ t: 'row', items: cell });
        cell = [];
        continue;
      }
      if (t.k === 'cmd' && (t.v === '\\' || t.v === 'cr')) {
        this.next();
        rows[rows.length - 1].push({ t: 'row', items: cell });
        cell = [];
        rows.push([]);
        continue;
      }
      const e = this.expr({ cell: true });
      cell.push(...e.items);
    }
    if (cell.length || rows[rows.length - 1].length) rows[rows.length - 1].push({ t: 'row', items: cell });
    if (rows.length > 1 && !rows[rows.length - 1].length) rows.pop();
    const fences = {
      pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'],
      cases: ['{', ''], rcases: ['', '}'], dcases: ['{', ''],
    }[name] || ['', ''];
    const table = { t: 'table', rows, env: name };
    if (!fences[0] && !fences[1]) return table;
    return { t: 'fenced', open: fences[0], close: fences[1], body: table, stretch: true };
  }
}

function restyle(node, font) {
  if (!node) return node;
  if (node.t === 'row' && node.items.length === 1) return restyle(node.items[0], font);
  if (node.t === 'mi' || node.t === 'mn') {
    const s = [...node.v].map((c) => styled(c, font) || c).join('');
    return { t: 'mi', v: s, styled: true };
  }
  if (node.t === 'row') return { t: 'row', items: node.items.map((x) => restyle(x, font)) };
  if (node.t === 'scripts') return { ...node, base: restyle(node.base, font) };
  return node;
}

function upright(node) {
  if (!node) return node;
  if (node.t === 'row') {
    // a run of letters is one upright word: \mathrm{sign}
    const letters = node.items.every((x) => x.t === 'mi' || x.t === 'mn');
    if (letters && node.items.length > 1) return { t: 'mi', v: node.items.map((x) => x.v).join(''), up: true, word: true };
    return { t: 'row', items: node.items.map(upright) };
  }
  if (node.t === 'mi') return { ...node, up: true };
  return node;
}

// ----------------------------------------------------------------- MathML

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ml(node, ctx = {}) {
  if (!node) return '<mrow></mrow>';
  switch (node.t) {
    case 'row': {
      const items = node.items;
      if (items.length === 1) return ml(items[0], ctx);
      return `<mrow>${items.map((x) => ml(x, ctx)).join('')}</mrow>`;
    }
    case 'mi': {
      const v = node.v;
      const one = [...v].length === 1;
      if (node.up && one) return `<mi mathvariant="normal">${esc(v)}</mi>`;
      if (one && GREEK_NAME[v] && /[Α-Ω]/.test(v)) return `<mi mathvariant="normal">${esc(v)}</mi>`;
      return `<mi>${esc(v)}</mi>`;
    }
    case 'mn': return `<mn>${esc(node.v)}</mn>`;
    case 'text': return `<mtext>${esc(node.v)}</mtext>`;
    case 'space': return `<mspace width="${node.w}em"></mspace>`;
    case 'mo': {
      if (node.unknown) return `<mtext class="tex-unknown">${esc(node.v)}</mtext>`;
      const a = [];
      if (node.role === 'big') a.push('largeop="true"', 'movablelimits="true"');
      if (node.stretch) a.push('stretchy="true"');
      else if (node.role === 'open' || node.role === 'close' || node.role === 'fence') a.push('stretchy="false"');
      // bars of |x| and ‖x‖ hug their content
      if (node.role === 'fence') a.push('lspace="0.05em"', 'rspace="0.05em"');
      if (node.role === 'pre' && node.v === '∇') a.push('lspace="0"', 'rspace="0"');
      if (node.role === 'ord') a.push('lspace="0"', 'rspace="0"');
      return `<mo${a.length ? ' ' + a.join(' ') : ''}>${esc(node.v)}</mo>`;
    }
    case 'func': return `<mi${[...node.v].length === 1 ? ' mathvariant="normal"' : ''}>${esc(node.v)}</mi>`;
    case 'frac': {
      const a = [];
      if (node.noline) a.push('linethickness="0"');
      const inner = `<mfrac${a.length ? ' ' + a.join(' ') : ''}>${ml(node.num, ctx)}${ml(node.den, ctx)}</mfrac>`;
      if (node.style === 'display') return `<mstyle displaystyle="true">${inner}</mstyle>`;
      if (node.style === 'text') return `<mstyle displaystyle="false">${inner}</mstyle>`;
      return inner;
    }
    case 'sqrt':
      return node.index ? `<mroot>${ml(node.body, ctx)}${ml(node.index, ctx)}</mroot>` : `<msqrt>${ml(node.body, ctx)}</msqrt>`;
    case 'accent': {
      const stretch = WIDE.has(node.acc) ? ' stretchy="true"' : ' stretchy="false"';
      return `<mover accent="true">${ml(node.base, ctx)}<mo${stretch}>${esc(node.acc)}</mo></mover>`;
    }
    case 'over': return `<mover>${ml(node.base, ctx)}${ml(node.over, ctx)}</mover>`;
    case 'under': return `<munder>${ml(node.base, ctx)}${ml(node.under, ctx)}</munder>`;
    case 'scripts': {
      const b = node.base;
      const limits = (b.t === 'mo' && b.role === 'big') || (b.t === 'func' && b.limits);
      let base = ml(b, ctx);
      if (b.t === 'func' && b.limits) base = `<mo movablelimits="true" form="prefix" lspace="0" rspace="0.1667em">${esc(b.v)}</mo>`;
      if (limits) {
        if (node.sub && node.sup) return `<munderover>${base}${ml(node.sub, ctx)}${ml(node.sup, ctx)}</munderover>`;
        if (node.sub) return `<munder>${base}${ml(node.sub, ctx)}</munder>`;
        return `<mover>${base}${ml(node.sup, ctx)}</mover>`;
      }
      if (node.sub && node.sup) return `<msubsup>${base}${ml(node.sub, ctx)}${ml(node.sup, ctx)}</msubsup>`;
      if (node.sub) return `<msub>${base}${ml(node.sub, ctx)}</msub>`;
      return `<msup>${base}${ml(node.sup, ctx)}</msup>`;
    }
    case 'fenced': {
      const o = node.open ? `<mo stretchy="${node.stretch ? 'true' : 'false'}" fence="true" form="prefix">${esc(node.open)}</mo>` : '';
      const c = node.close ? `<mo stretchy="${node.stretch ? 'true' : 'false'}" fence="true" form="postfix">${esc(node.close)}</mo>` : '';
      return `<mrow>${o}${ml(node.body, ctx)}${c}</mrow>`;
    }
    case 'table': {
      const left = node.env === 'cases' || node.env === 'dcases' || node.env === 'aligned' || node.env === 'align' || node.env === 'array';
      const rows = node.rows.map((r) => `<mtr>${r.map((c) => `<mtd${left ? ' style="text-align:left;padding:0.1em 0.6em 0.1em 0"' : ' style="padding:0.1em 0.4em"'}>${ml(c, ctx)}</mtd>`).join('')}</mtr>`).join('');
      return `<mtable>${rows}</mtable>`;
    }
    default: return '<mrow></mrow>';
  }
}

export function parseTex(tex) {
  const p = new Parser(String(tex || ''));
  const ast = p.expr();
  return { ast, errors: p.errors };
}

// '<math …>…</math>' for the tex; a source fallback when it cannot be read.
export function toMathML(tex, { display = false } = {}) {
  const src = String(tex || '').trim();
  let out;
  try {
    const { ast, errors } = parseTex(src);
    if (errors > 2 || !ast.items.length) throw new Error('tex');
    out = `<math${display ? ' display="block"' : ''}>${ml(ast)}</math>`;
  } catch {
    out = `<code class="tex">${esc(src)}</code>`;
  }
  return out;
}

// ---------------------------------------------------------------- reading

function letterRead(v) {
  const out = [];
  for (const ch of v) {
    if (GREEK_NAME[ch]) out.push(GREEK_NAME[ch]);
    else if (PLAIN.has(ch)) out.push(PLAIN.get(ch));
    else if (/[A-Za-z0-9]/.test(ch)) out.push(ch);
  }
  return out.join(' ');
}

function isSimple(node) {
  if (!node) return true;
  if (node.t === 'mi' || node.t === 'mn') return true;
  if (node.t === 'row') return node.items.length <= 1 && node.items.every(isSimple);
  return false;
}

const FENCE_READ = { '|': 'the absolute value of', '‖': 'the norm of' };
const TEXT_READ = { 's.t.': 'subject to', 'st': 'subject to', 'i.e.': 'that is', 'e.g.': 'for example', 'w.r.t.': 'with respect to', 'iff': 'if and only if', 'otherwise': 'otherwise' };

// a fence bar, possibly carrying the subscript of a norm: \|w\|_2
const barOf = (x) => (x.t === 'mo' && FENCE_READ[x.v] ? x.v : x.t === 'scripts' && x.base.t === 'mo' && FENCE_READ[x.base.v] ? x.base.v : null);
// Letters that usually name functions: f(x) reads "f of x", but y_i(w + b)
// and w^T(x - z) are products.
const FN_LETTERS = new Set([...'fghlLpqrsFGHKPQRSTℓσϕφψΦΨ']);
const unwrap = (x) => (x && x.t === 'row' && x.items.length === 1 ? unwrap(x.items[0]) : x);
function applies(x) {
  x = unwrap(x);
  if (!x) return false;
  if (x.t === 'func') return true;
  if (x.t === 'mi') return x.styled || FN_LETTERS.has(x.v);
  if (x.t === 'scripts') {
    const b = unwrap(x.base);
    const sup = x.sup ? unwrap(x.sup) : null;
    if (sup && sup.t === 'mo' && sup.v === '⊤') return false;
    if (sup && sup.t === 'mo' && sup.v === '∗') return b && b.t === 'mi'; // w^*(α)
    if (sup && sup.t !== 'mo') return false; // x^2(…)
    return applies(b);
  }
  return false;
}
const NUM_FRAC = { '1/2': 'one half', '1/3': 'one third', '1/4': 'one quarter', '3/4': 'three quarters', '2/3': 'two thirds' };

function rd(node) {
  if (!node) return '';
  switch (node.t) {
    case 'row': {
      const parts = [];
      const items = node.items;
      for (let i = 0; i < items.length; i++) {
        const x = items[i];
        // |…| and ‖…‖ read as "the absolute value of" / "the norm of"
        const bar = barOf(x);
        if (bar && x.t === 'mo') {
          const j = items.findIndex((y, k) => k > i && barOf(y) === bar);
          if (j > i) {
            parts.push(FENCE_READ[bar], rd({ t: 'row', items: items.slice(i + 1, j) }));
            i = j;
            continue;
          }
        }
        // function application: f(x), L(w, α), I[…] -> "f of x"
        const nx = items[i + 1];
        if (applies(x) && nx && nx.t === 'mo' && nx.role === 'open' && (nx.v === '(' || nx.v === '[')) {
          parts.push(rd(x), 'of');
          continue;
        }
        if (applies(x) && nx && nx.t === 'fenced' && nx.open === '(') {
          parts.push(rd(x), 'of', rd(nx.body));
          i++;
          continue;
        }
        parts.push(rd(x));
      }
      return parts.filter(Boolean).join(' ');
    }
    case 'mi': return node.word ? node.v : letterRead(node.v);
    case 'mn': return node.v;
    case 'text': {
      const t = node.v.trim();
      return TEXT_READ[t.toLowerCase()] ?? t;
    }
    case 'space': return '';
    case 'mo': return node.read || '';
    case 'func': return FUNC_READ[node.v] || node.v;
    case 'frac': {
      const n = rd(node.num);
      const d = rd(node.den);
      if (node.noline) return `${n} choose ${d}`;
      if (NUM_FRAC[`${n}/${d}`]) return NUM_FRAC[`${n}/${d}`];
      if (isSimple(node.num) && isSimple(node.den)) return `${n} over ${d}`;
      return `${n} over ${d}`;
    }
    case 'sqrt': return node.index ? `the ${rd(node.index)} root of ${rd(node.body)}` : `the square root of ${rd(node.body)}`;
    case 'accent': {
      const r = ACCENT_READ[node.acc];
      return [rd(node.base), r].filter(Boolean).join(' ');
    }
    case 'over': case 'under': return rd(node.base);
    case 'scripts': {
      const b = node.base;
      if (b.t === 'mo' && b.v === '∇' && node.sub) return `the gradient with respect to ${rd(node.sub)} of`;
      if ((b.t === 'mo' && b.role === 'big') || (b.t === 'func' && b.limits)) {
        const name = b.t === 'mo' ? b.read : FUNC_READ[b.v] || `the ${b.v}`;
        if (node.sub && node.sup) return `${name} from ${rd(node.sub)} to ${rd(node.sup)} of`;
        if (node.sub) return `${name} over ${rd(node.sub)} of`;
        return `${name} of`;
      }
      const parts = [rd(b)];
      if (node.sub) {
        // x_{test} reads "x test", x_{ij} reads "x i j"
        const s = node.sub;
        const letters = s.t === 'row' && s.items.length >= 3 && s.items.every((x) => x.t === 'mi' && /^[A-Za-z]$/.test(x.v));
        parts.push(letters ? s.items.map((x) => x.v).join('') : rd(s));
      }
      if (node.sup) parts.push(supRead(node.sup));
      return parts.filter(Boolean).join(' ');
    }
    case 'fenced': {
      const inner = rd(node.body);
      if (node.open === '|' && node.close === '|') return `the absolute value of ${inner}`;
      if (node.open === '‖' && node.close === '‖') return `the norm of ${inner}`;
      return inner;
    }
    case 'table': return node.rows.map((r) => r.map(rd).filter(Boolean).join(' ')).join(', ');
    default: return '';
  }
}

function supRead(sup) {
  const items = sup.t === 'row' ? sup.items : [sup];
  const words = [];
  for (const x of items) {
    if (x.t === 'mn' && x.v === '2' && items.length === 1) words.push('squared');
    else if (x.t === 'mn' && x.v === '3' && items.length === 1) words.push('cubed');
    else if (x.t === 'mo' && x.v === '⊤') words.push('transpose');
    else if (x.t === 'mi' && x.v === 'T' && items.length === 1) words.push('transpose');
    else if (x.t === 'mo' && x.v === '∗') words.push('star');
    else if (x.t === 'mo' && x.v === '′') words.push('prime');
    else if (x.t === 'mo' && x.v === '−' && items.length === 2 && items[1].t === 'mn' && items[1].v === '1') { words.push('inverse'); break; }
    else words.push(rd(x));
  }
  const plain = words.every((w) => ['squared', 'cubed', 'transpose', 'star', 'prime', 'inverse'].includes(w));
  return plain ? words.join(' ') : `to the ${words.filter(Boolean).join(' ')}`;
}

// English reading of a formula: '\frac{1}{\|w\|_2}' -> 'one over the norm of w 2'
// (digits stay digits; the script tokenizer reads them as number words).
export function readTex(tex) {
  try {
    const { ast } = parseTex(tex);
    return rd(ast).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}
