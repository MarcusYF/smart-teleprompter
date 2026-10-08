import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../public/lib/script.js';
import { outlineItems, heuristicAnalysis } from '../public/lib/outline.js';
import { manualAlignment } from '../public/lib/alignment.js';
import { Renderer } from '../public/lib/render.js';

test('required paragraphs remain complete at every summary level in English and Chinese', () => {
  for (const [lang, text] of [['en', '# Talk\nOptional introduction.\n\n[must]\nSubmit all three required sections by Friday. Include your name and student ID.'], ['zh', '# 演讲\n开场介绍。\n\n[必讲]\n请在周五前提交全部三个部分。记得填写姓名和学号。']]) {
    const doc = parseScript(text, { lang }), analysis = heuristicAnalysis(doc);
    const must = doc.paras.find(p => p.must);
    assert.ok(must); assert.ok(!doc.tokens.some(t => t.n === 'must'));
    for (const level of [1, 2, 3, 4]) {
      const group = outlineItems(doc, analysis, level, 0).find(i => i.type === 'group' && i.para === must.idx);
      assert.equal(group.children.length, must.sentEnd - must.sentStart);
      assert.ok(group.children.every(i => i.type === 'full'));
    }
  }
});

const doc = parseScript('First topic begins here.\n\nSecond topic begins here.\n\nThird topic begins here.', { lang: 'en' });
test('manual mapping validates numbers and script order; picture slides may be omitted', () => {
  const mapping = manualAlignment(doc, '1=1\n3=2\n4=3', 4);
  assert.deepEqual(mapping.map(m => m.n), [1, 3, 4]);
  assert.deepEqual(mapping.map(m => m.tokStart), doc.paras.map(p => p.tokStart));
  for (const invalid of ['', 'x=y', '0=1', '1=0', '1=4', '5=1', '1=1\n1=2', '1=2\n2=1', '1=1\n2=1']) {
    assert.throws(() => manualAlignment(doc, invalid, 4), undefined, invalid);
  }
});

test('actual renderer preserves full required sentences at all five levels', t => {
  class Node {
    constructor(text = '') { this.text = text; this.childNodes = []; this.dataset = {}; this.classList = { add() {} }; }
    appendChild(n) { this.childNodes.push(n); return n; }
    set textContent(s) { this.text = s; this.childNodes = []; }
    get textContent() { return this.text + this.childNodes.map(n => n.textContent).join(''); }
    set innerHTML(_s) { this.text = ''; this.childNodes = []; }
  }
  const old = globalThis.document;
  t.after(() => { globalThis.document = old; });
  globalThis.document = { createElement: () => new Node(), createTextNode: s => new Node(s) };
  const d = parseScript('# Talk\nOptional greeting.\n\n[must]\nSubmit all three sections by Friday. Include your student ID.', { lang: 'en' });
  const r = Object.create(Renderer.prototype);
  Object.assign(r, { doc: d, content: new Node(), analysis: heuristicAnalysis(d), detail: 0, lastApplied: new Map(), relayout() {} });
  for (const level of [0, 1, 2, 3, 4]) {
    r.level = level; r.build();
    assert.match(r.content.textContent, /Submit all three sections by Friday/);
    assert.match(r.content.textContent, /Include your student ID/);
  }
});
