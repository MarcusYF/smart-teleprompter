// Mixed-language scripts: Chinese with English terms, numbers and
// percentages, rendered by the recognizer differently from the script.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './tracker-harness.mjs';

const SEEDS = [1, 2, 3, 4];

const ZH_MIXED = `# 对齐方法

我们用 PPO 和 DPO 来优化 reward model。在2026年的实验里，DPO 的训练速度是 PPO 的3.5倍，成本降低了20%。

另外，RLHF 需要大量的人类标注数据。我们一共收集了12,000条偏好对，其中大约百分之十五是噪声。

最后，我们用 GPT-4 做自动评估，胜率从45%提高到了62%。`;

const EN_MIXED = `# Alignment methods

We optimize the policy with PPO and DPO against a reward model. In our 2026 experiments, DPO trained 3.5 times faster than PPO, and the cost dropped by 20%.

RLHF also needs a lot of human labels. We collected 12,000 preference pairs, and about fifteen percent of them were noise.

Finally, we used GPT-4 as an automatic judge, and the win rate went from 45% to 62%.`;

function readWith(doc, subs, seeds = SEEDS, opts = {}) {
  const rows = seeds.map((seed) => {
    const r = H.runRec(doc, [{ read: [0, doc.phrases.length - 1], subs }], { seed, errRate: 0.02, ...opts });
    return {
      acc: H.phraseAccuracy(doc, r.sim, r.trace).acc,
      backs: r.f.events.filter((e) => e.how === 'back').map((e) => `${e.from}->${e.to}`),
      skipped: [...r.f.skipped].map((p) => doc.phrases[p].text),
      end: doc.tokens.length - r.f.pos,
      off: r.trace.filter((s) => s.status === 'offscript').length / r.trace.length,
    };
  });
  return {
    acc: Math.min(...rows.map((x) => x.acc)),
    backs: [...new Set(rows.flatMap((x) => x.backs))],
    skipped: [...new Set(rows.flatMap((x) => x.skipped))],
    endErr: Math.max(...rows.map((x) => x.end)),
    offShare: +Math.max(...rows.map((x) => x.off)).toFixed(2),
  };
}

// Substitution helper that works whether the parser keeps digits or has
// expanded them (the lang.js number reading changed during this QA pass).
function subAny(doc, forms, say, after = 0) {
  for (const f of forms) {
    try {
      return H.sub(doc, f, say, after);
    } catch {
      // try next form
    }
  }
  throw new Error(`none of ${forms.join(' / ')} found`);
}

test('zh+en: verbatim read of a mixed script (recognizer prints the script)', () => {
  const doc = H.parseScript(ZH_MIXED);
  const w = readWith(doc, []);
  H.note('zh mixed verbatim', w);
  assert.ok(w.acc >= 0.97, `acc ${w.acc}`);
  assert.equal(w.endErr, 0);
});

test('zh+en: recognizer writes numbers in the other form (2026 <-> 二零二六, 45% <-> 百分之四十五, ...)', () => {
  const doc = H.parseScript(ZH_MIXED);
  let a = 0;
  const S = (forms, say) => {
    const s = subAny(doc, forms, say, a);
    a = s.to;
    return s;
  };
  const subs = [
    S(['2026', '二零二六'], '二零二六'),
    S(['3.5', '三点五'], '三点五'),
    S(['20%', '百分之二十'], '百分之二十'),
    S(['百分之十五'], '15%'),
    S(['45%', '百分之四十五'], '百分之四十五'),
    S(['62%', '百分之六十二'], '百分之六十二'),
  ];
  const w = readWith(doc, subs);
  H.note('zh mixed numbers rendered differently', w);
  assert.deepEqual(w.backs, [], `wrong back jumps ${w.backs.join(' ')}`);
  assert.equal(w.endErr, 0, `display ended ${w.endErr} tokens short`);
  assert.ok(w.acc >= 0.95, `acc ${w.acc}`);
});

test('zh: script with numbers in characters, recognizer prints digits (Chrome zh-CN style)', () => {
  const text = `# 实验结果

在二零二六年的实验里，新方法的速度提高了三点五倍，成本降低了百分之二十。

我们一共收集了一万两千条偏好数据，其中大约百分之十五是噪声，百分之八十五是可靠的。

最后，胜率从百分之四十五提高到了百分之六十二，这是一个很大的进步。`;
  const doc = H.parseScript(text);
  let a = 0;
  const subs = [['二零二六', '2026'], ['三点五', '3.5'], ['百分之二十', '20%'], ['一万两千', '12000'], ['百分之十五', '15%'], ['百分之八十五', '85%'], ['百分之四十五', '45%'], ['百分之六十二', '62%']]
    .map(([c, d]) => {
      const s = H.sub(doc, c, d, a);
      a = s.to;
      return s;
    });
  const w = readWith(doc, subs);
  H.note('zh chars script, digit recognizer', w);
  assert.ok(w.acc >= 0.97, `acc ${w.acc}`);
  assert.deepEqual(w.skipped, []);
});

test('zh+en: English acronyms spelled out or split by the recognizer', () => {
  const doc = H.parseScript(ZH_MIXED);
  const subs = [
    H.sub(doc, 'ppo', 'P P O'), H.sub(doc, 'dpo', 'D P O'), H.sub(doc, 'rlhf', 'R L H F'),
  ];
  const w = readWith(doc, subs);
  H.note('zh mixed acronyms spelled', w);
  assert.ok(w.acc >= 0.9, `acc ${w.acc}`);
  assert.deepEqual(w.skipped, []);
});

test('en: acronyms spelled out, numbers as words (twenty twenty-six, forty-five percent)', () => {
  const doc = H.parseScript(EN_MIXED);
  const S = (t, s, a) => H.sub(doc, t, s, a);
  const spelled = readWith(doc, [S('ppo', 'P P O'), S('dpo', 'D P O'), S('dpo', 'D P O', 13), S('ppo', 'P P O', 20), S('rlhf', 'R L H F'), S('gpt four', 'G P T 4')]);
  const words = readWith(doc, [S('twenty twenty six', 'twenty twenty-six'), S('three point five', 'three point five'), S('twenty percent', 'twenty percent'), S('fifteen percent', '15%'), S('forty five percent', 'forty-five percent')]);
  H.note('en acronyms spelled', spelled);
  H.note('en numbers as words', words);
  assert.ok(spelled.acc >= 0.9 && words.acc >= 0.97);
  assert.deepEqual(spelled.skipped, []);
  assert.equal(words.endErr, 0);
});

test('zh: zh-TW recognizer (traditional characters) on a simplified script', () => {
  const S2T = { 从: '從', 类: '類', 馈: '饋', 学: '學', 习: '習', 讲: '講', 欢: '歡', 来: '來', 时: '時', 语: '語', 这: '這', 样: '樣', 们: '們', 奖: '獎', 励: '勵', 惩: '懲', 罚: '罰', 绝: '絕', 为: '為', 断: '斷', 变: '變', 种: '種', 优: '優', 训: '訓', 练: '練', 号: '號', 题: '題', 声: '聲', 经: '經', 给: '給', 当: '當', 惯: '慣', 标: '標', 个: '個', 决: '決', 问: '問', 读: '讀', 输: '輸', 数: '數', 让: '讓', 过: '過', 错: '錯', 谓: '謂', 实: '實', 践: '踐', 约: '約', 离: '離', 远: '遠', 总: '總', 结: '結', 赖: '賴', 质: '質', 据: '據', 谨: '謹', 谢: '謝', 场: '場', 险: '險', 与: '與', 会: '會', 对: '對', 说: '說', 还: '還', 后: '後', 于: '於', 应: '應' };
  const doc = H.ZH;
  const subs = [];
  doc.tokens.forEach((t, i) => { if (S2T[t.n]) subs.push({ from: i, to: i + 1, say: S2T[t.n] }); });
  const w = readWith(doc, subs);
  H.note('zh-TW on simplified', { ...w, tradChars: subs.length });
  assert.ok(w.acc >= 0.97);
});

// The app's own simulator (demo panel, SimEngine) glues consecutive English
// words together in Chinese scripts: "reward model" -> "rewardmodel".
test('simulate.js: zh read keeps a space between consecutive English words', () => {
  const doc = H.parseScript('我们用 reward model 和 policy gradient 来训练语言模型，这个方法很常见。');
  const sim = H.simulateLib(doc, [{ read: [0, doc.phrases.length - 1] }], { seed: 1, errRate: 0, revRate: 0, finalEvery: [40, 40] });
  const final = sim.events.filter((e) => e.kind === 'final').map((e) => e.text).join('');
  H.note('simulate zh join', { final });
  assert.ok(/reward model/i.test(final) && /policy gradient/i.test(final), `final text: ${final}`);
});

test("simulate.js: zh 'say' keeps English words and decimals intact", () => {
  const doc = H.ZH;
  const sim = H.simulateLib(doc, [{ say: '我们用 PPO 训练了3.5个小时' }], { seed: 1, errRate: 0, revRate: 0 });
  const final = sim.events.filter((e) => e.kind === 'final').map((e) => e.text).join('');
  const units = sim.truth.length;
  H.note('simulate zh say', { final, units });
  assert.ok(final.includes('3.5'), `decimal lost: ${final}`);
  assert.ok(units <= 12, `${units} recognizer units for 11 spoken units (letters of PPO counted separately)`);
});

test.after(() => H.printNotes('tracker-mixed'));
