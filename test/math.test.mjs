// Formulas in scripts: LaTeX -> MathML, readings for the tracker, parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMathML, readTex, parseTex } from '../public/lib/math.js';
import { parseScript } from '../public/lib/script.js';
import { pieces, speechTokens } from '../public/lib/lang.js';

test('MathML for the notation used in lectures', () => {
  const frac = toMathML('\\frac{1}{\\|w\\|_2}');
  assert.match(frac, /^<math>/);
  assert.match(frac, /<mfrac>/);
  assert.match(frac, /<msub><mo[^>]*>‖<\/mo><mn>2<\/mn><\/msub>/);
  assert.match(toMathML('w^\\top x + b = 0'), /<msup><mi>w<\/mi><mo[^>]*>⊤<\/mo><\/msup>/);
  assert.match(toMathML('\\alpha_i^*'), /<msubsup><mi>α<\/mi><mi>i<\/mi><mo[^>]*>∗<\/mo><\/msubsup>/);
  assert.match(toMathML('\\mathbb{I}[\\hat{y}\\le 0]'), /𝕀/);
  assert.match(toMathML('\\hat{y}'), /<mover accent="true"><mi>y<\/mi><mo stretchy="false">ˆ<\/mo><\/mover>/);
  assert.match(toMathML('\\log\\left(1+e^{-x}\\right)'), /stretchy="true"/);
  assert.match(toMathML('\\sum_{i=1}^N x_i'), /<munderover><mo largeop="true" movablelimits="true">∑<\/mo>/);
  assert.match(toMathML('\\arg\\min_w L'), /<munder><mo movablelimits="true"[^>]*>arg min<\/mo>/);
  assert.match(toMathML('\\begin{cases} 0 & x \\ge 1 \\\\ -x & x < 1 \\end{cases}'), /<mtable>.*<mtr>.*<\/mtr><mtr>/);
  assert.match(toMathML('\\frac12'), /<mfrac><mn>1<\/mn><mn>2<\/mn><\/mfrac>/, 'one-character arguments like TeX');
  assert.match(toMathML('\\text{s.t. } x'), /<mtext>s\.t\. <\/mtext>/);
  assert.match(toMathML('x', { display: true }), /^<math display="block">/);
});

test('bad input never throws: unknown commands show as source, broken input falls back', () => {
  assert.doesNotThrow(() => toMathML('\\foo{x}'));
  assert.match(toMathML('\\foo{x}'), /tex-unknown/);
  assert.match(toMathML('}}}{{{'), /^<code class="tex">/);
  assert.match(toMathML(''), /^<code class="tex">/);
  assert.equal(parseTex('\\[ x \\]').errors, 0, 'display delimiters inside a source are ignored');
});

test('readings follow how the formulas are said', () => {
  assert.equal(readTex('\\frac{1}{\\|w\\|_2}'), '1 over the norm of w'); // digits become number words when tokenized
  assert.equal(readTex('w^\\top x + b = 0'), 'w transpose x plus b equals 0');
  assert.equal(readTex('\\tfrac12 w^\\top w'), 'one half w transpose w');
  assert.equal(readTex('f(x_{test})'), 'f of x test');
  assert.equal(readTex('y_i(w^\\top x_i + b) \\ge 1'), 'y i w transpose x i plus b greater than or equal to 1', 'a product, not f(x)');
  assert.equal(readTex('|w^\\top x_n| = 1'), 'the absolute value of w transpose x n equals 1');
  assert.equal(readTex('\\nabla_w l_i'), 'the gradient with respect to w of l i');
  assert.equal(readTex('\\alpha_i^* > 0 \\Rightarrow y_i = 1'), 'alpha i star is greater than 0 implies y i equals 1');
  assert.equal(readTex('\\sum_{i=1}^N \\alpha_i'), 'the sum from i equals 1 to N of alpha i');
  assert.equal(readTex('x^2 + y^{-1}'), 'x squared plus y inverse');
});

test('script formulas: an explicit {reading} is what the tracker follows', () => {
  const doc = parseScript('[slide 1]\nSo the margin is $\\frac{1}{\\|w\\|_2}${one over the norm of w}. Done here.\n', { lang: 'en' });
  const ph = doc.phrases.find((p) => p.pieces.some((x) => x.kind === 'math'));
  const m = ph.pieces.find((x) => x.kind === 'math');
  assert.equal(m.tex, '\\frac{1}{\\|w\\|_2}');
  assert.equal(m.t, 'one over the norm of w');
  assert.deepEqual(doc.tokens.slice(m.tok, m.tokEnd).map((t) => t.n), ['one', 'over', 'the', 'norm', 'of', 'w']);
  assert.match(ph.text, /one over the norm of w/, 'the semantic layer sees words, not LaTeX');
});

test('script formulas: readings are generated in English, display-only in Chinese', () => {
  const en = parseScript('[slide 1]\nWe write $w^\\top x = 0$ on the board.\n', { lang: 'en' });
  assert.deepEqual(en.tokens.map((t) => t.n).slice(2, 7), ['w', 'transpose', 'x', 'equals', 'zero']);
  const zh = parseScript('[slide 1]\n我们先写出 $w^\\top x = 0$ 这个式子。\n', { lang: 'zh' });
  const m = zh.phrases.flatMap((p) => p.pieces).find((x) => x.kind === 'math');
  assert.equal(m.tok, undefined, 'no reading, no tokens: shown only');
  assert.ok(!zh.tokens.some((t) => /[a-z]/.test(t.n)));
  const zh2 = parseScript('[slide 1]\n间隔是 $\\frac{1}{\\|w\\|}${w 的范数分之一}。\n', { lang: 'zh' });
  assert.ok(zh2.tokens.some((t) => t.n === '范'));
});

test('dollar signs that are not math stay text; a $$ line is a display block', () => {
  const doc = parseScript('[slide 1]\nIt costs $5 and $10 today.\n$$\\min_w \\tfrac12 w^\\top w$$\nThe end of it.\n', { lang: 'en' });
  assert.ok(!doc.phrases.some((p) => p.pieces.some((x) => x.kind === 'math')));
  const blk = doc.blocks.find((b) => b.type === 'math');
  assert.equal(blk.tex, '\\min_w \\tfrac12 w^\\top w');
  assert.ok(!doc.tokens.some((t) => t.n === 'transpose'), 'display blocks are not spoken');
  const cue = parseScript('[slide 1]\n// Board: $\\nabla_w L = 0$\nWords here.\n', { lang: 'en' });
  assert.match(cue.cues[0].text, /\$\\nabla_w L = 0\$/);
});

test('spelled-out letters are one token on both sides, as recognizers write them', () => {
  const ps = pieces('the score y i w transpose x i', 'en').filter((p) => p.toks);
  assert.deepEqual(ps.map((p) => p.toks.map((t) => t.n).join('|')), ['the', 'score', 'yiw', 'transpose', 'xi']);
  assert.deepEqual(ps.map((p) => p.t), ['the', 'score', 'y i w', 'transpose', 'x i'], 'the display keeps the spaces');
  assert.deepEqual(speechTokens('YIW transpose XI', 'en').map((t) => t.n), ['yiw', 'transpose', 'xi']);
  assert.deepEqual(speechTokens('y i w transpose x i', 'en').map((t) => t.n), ['yiw', 'transpose', 'xi']);
});
