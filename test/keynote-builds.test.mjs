// Builds read from .key files, [click] markers placed from them, and the
// controller's use of the deck's build counts (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKeynoteBuilds } from '../server/keynote-file.mjs';
import { scriptFromSlides } from '../server/slides.mjs';
import { placeClicks } from '../public/lib/autoclick.js';
import { parseScript, markedClicks } from '../public/lib/script.js';
import { BuildController, slideIndex } from '../public/lib/builds.js';

// ------------------------------------------------ a synthetic .key file

const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const tag = (f, w) => varint((f << 3) | w);
const num = (f, v) => Buffer.concat([tag(f, 0), varint(v)]);
const msg = (f, ...parts) => {
  const b = Buffer.concat(parts);
  return Buffer.concat([tag(f, 2), varint(b.length), b]);
};
const str = (f, s) => msg(f, Buffer.from(s, 'utf8'));
const ref = (f, id) => msg(f, num(1, id));
// TSP.ArchiveInfo {1: id, 2: MessageInfo {1: type, 3: length}} + payload
const archive = (id, type, ...payload) => {
  const p = Buffer.concat(payload);
  const info = Buffer.concat([num(1, id), msg(2, num(1, type), num(3, p.length))]);
  return Buffer.concat([varint(info.length), info, p]);
};
// one snappy chunk of literals
function iwaFile(...archives) {
  const data = Buffer.concat(archives);
  const parts = [varint(data.length)];
  for (let i = 0; i < data.length; i += 60) {
    const c = data.subarray(i, i + 60);
    parts.push(Buffer.from([(c.length - 1) << 2]), c);
  }
  const z = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0, z.length & 0xff, (z.length >> 8) & 0xff, z.length >> 16]), z]);
}
// a stored (uncompressed) zip
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Slide 1: no builds. Slide 2: a text box built by paragraph (two clicks),
// then a picture that follows the second click automatically. Slide 3: a
// build that starts by itself, then one click. Slides are stored out of
// order: the show's slide list decides.
function sampleDeck() {
  return zip({
    'Index/Document.iwa': iwaFile(
      archive(1, 2, msg(3, ref(2, 10), ref(2, 11), ref(2, 12))),
      archive(10, 4, ref(2, 100)),
      archive(11, 4, ref(2, 200)),
      archive(12, 4, ref(2, 300)),
    ),
    'Index/Slide-9.iwa': iwaFile(
      archive(200, 5, ref(43, 210), ref(43, 211), ref(43, 212)),
      archive(210, 153, ref(1, 220)),
      archive(211, 153, ref(1, 220)),
      archive(212, 153, ref(1, 221), num(5, 1)),
      archive(220, 8, ref(1, 230), str(2, 'By Paragraph'), num(5, 2)),
      archive(221, 8, ref(1, 231), str(2, 'All at Once')),
      archive(230, 7, msg(1, msg(2, ref(1, 240)))),
      archive(240, 2001, str(3, 'Distance matters \uFFFC here\nMinimize the violated distance')),
      archive(231, 3005, num(1, 1)),
    ),
    'Index/Slide-2.iwa': iwaFile(archive(100, 5, num(1, 1))),
    'Index/Slide-5.iwa': iwaFile(
      archive(300, 5, ref(43, 310), ref(43, 311)),
      archive(310, 153, ref(1, 320), num(5, 1)),
      archive(311, 153, ref(1, 321)),
      archive(320, 8, ref(1, 330), str(2, 'All at Once')),
      archive(321, 8, ref(1, 331), str(2, 'All at Once')),
      archive(330, 3005, num(1, 1)),
      archive(331, 2011, msg(9, ref(4, 341))),
      archive(341, 2001, str(3, 'The hinge loss')),
    ),
  });
}

test('builds per slide from a .key file, in show order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-key-'));
  try {
    const path = join(dir, 'deck.key');
    writeFileSync(path, sampleDeck());
    assert.deepEqual(readKeynoteBuilds(path), [
      { n: 1, clicks: 0, autoStart: false, steps: [] },
      { n: 2, clicks: 2, autoStart: false, steps: ['Distance matters here', 'Minimize the violated distance'] },
      { n: 3, clicks: 1, autoStart: true, steps: ['The hinge loss'] },
    ]);
    writeFileSync(path, Buffer.from('not a keynote file'));
    assert.equal(readKeynoteBuilds(path), null);
    assert.equal(readKeynoteBuilds(join(dir, 'missing.key')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------ placing [click] markers

const at = (text) => [...text.matchAll(/\[click(?: x\d+)?\] ([^[]{0,12})/g)].map((m) => m[1]);

test('each click goes before the sentence that talks about what it shows', () => {
  const notes = 'This slide is about margins. The first idea is the distance to the boundary. ' +
    'Then we minimize the total violated distance. Finally the hinge loss appears.';
  const r = placeClicks(notes, ['Distance to the boundary', 'Minimize the total violated distance', 'Hinge loss']);
  assert.equal(r.placed, 3);
  assert.deepEqual(at(r.text), ['The first id', 'Then we mini', 'Finally the ']);
  assert.ok(r.text.startsWith('This slide is about margins.'), 'the opening stays before the first click');
  // abbreviations on the slide match the words in the notes
  const d = placeClicks('Here is the schedule. The exam is on Wednesday, October 28. The project is due in December.',
    ['Project due Dec', 'Exam · Wed Oct 28']);
  assert.ok(d.at[0] <= d.at[1], 'monotone: a click never goes before an earlier one');
  const e = placeClicks('Here is the schedule. The exam is on Wednesday, October 28. The project is due in December.',
    ['Exam · Wed Oct 28', 'Project due Dec']);
  assert.deepEqual(at(e.text), ['The exam is ', 'The project ']);
});

test('pictures spread evenly, prefer paragraph starts, and never take the turn', () => {
  const notes = 'Here is the plan.\nFirst we look at one picture. It shows the data.\nThen a second picture. It shows the fit.\nThat is the whole story.';
  const r = placeClicks(notes, ['', '']);
  assert.deepEqual(at(r.text), ['First we loo', 'Then a secon']);
  // never after the last sentence: the end of the text is the slide's turn
  for (const k of [1, 3, 5]) {
    const t = placeClicks('One. Two. Three.', new Array(k).fill(''));
    assert.ok(!/\[click[^\]]*\]\s*$/.test(t.text), `${k} clicks`);
    assert.equal(markedClicks(t.text).reduce((a, m) => a + m.count, 0), k);
  }
  // too few sentences: clauses, then several clicks at one place
  assert.deepEqual(at(placeClicks('We start here, then go there.', ['', '']).text), ['We start her', 'then go ther']);
  assert.match(placeClicks('Just one thing', ['', '']).text, /^\[click x2\] Just one thing$/);
});

test('formulas, stage directions and Chinese notes', () => {
  const r = placeClicks('// about 2 min\nWe write $w.x + b = 0$ for the plane. Next comes the margin.', ['the plane', 'the margin']);
  assert.match(r.text, /^\/\/ about 2 min\n/);
  assert.match(r.text, /\$w\.x \+ b = 0\$ for the plane\. \[click\] Next/);
  const zh = placeClicks('这一页讲间隔。首先看点到超平面的距离。然后最小化违反的距离。最后是合页损失。', ['点到超平面的距离', '最小化违反距离', '合页损失']);
  assert.deepEqual(at(zh.text).map((s) => s.slice(0, 2)), ['首先', '然后', '最后']);
  assert.deepEqual(placeClicks('', ['x']), { text: '', placed: 0, at: [] });
});

test('marked clicks: counts, and the turn at the very end', () => {
  assert.deepEqual(markedClicks('[click] a b. [click x2] c. 【点击】 d [click]'), [
    { count: 1, trailing: false }, { count: 2, trailing: false }, { count: 1, trailing: false }, { count: 1, trailing: true },
  ]);
  assert.deepEqual(markedClicks('words [click]\n// a stage note'), [{ count: 1, trailing: true }]);
  assert.deepEqual(markedClicks('the interval [0, 1] is closed'), []);
});

test('imported notes get markers from the builds; mismatches get a warning', () => {
  const slides = [
    { n: 1, title: 'Intro', body: '', notes: 'Welcome. Today is about margins.', skipped: false, steps: [] },
    { n: 2, title: 'Margin', body: '', skipped: false, steps: ['distance to the boundary', 'violated distance'],
      notes: 'Look at the picture. The distance to the boundary matters. We minimize the violated distance.\n[Sources]\nBishop, Pattern Recognition, Section 7.1.' },
    { n: 3, title: 'Loss', body: '', skipped: false, steps: ['hinge', 'subgradient', 'step'],
      notes: 'The hinge loss. [click] It has a kink.' },
    { n: 4, title: 'End', body: '', skipped: false, notes: 'Thanks.' },
  ];
  const stats = { placed: 0, slides: 0, mismatch: [] };
  const text = scriptFromSlides(slides, stats);
  assert.deepEqual(stats, { placed: 2, slides: 1, mismatch: [3] });
  assert.match(text, /Look at the picture\. \[click\] The distance to the boundary matters\. \[click\] We minimize/);
  assert.match(text, /\/\/ \[Sources\]\n\/\/ Bishop/, 'references stay cues, without clicks');
  assert.match(text, /\[slide 3: Loss\]\n\/\/ ⚠ Keynote has 3 builds on this slide; these notes mark 1 click\n/);
  const doc = parseScript(text, { lang: 'en' });
  const idx = slideIndex(doc);
  assert.deepEqual([1, 2, 3, 4].map((n) => idx.markers(n).length), [0, 2, 1, 0]);
  // a turn marker (one more than the builds) is the author's choice
  const ok = scriptFromSlides([{ n: 1, title: '', body: '', skipped: false, steps: ['a'], notes: 'One [click] two. [click] Next slide.' }]);
  assert.doesNotMatch(ok, /⚠/);
});

// ------------------------------------------------ the controller

const SCRIPT = `[slide 1: Intro]
We start with the picture on the left side.
[click] The first bullet says that distance matters.
[click] The second bullet adds the violated distances.
[click] A third marker the deck has no build for.
[click] And a fourth one before the end of this slide.

[slide 2: Plain]
This slide has no markers but the deck builds two things here.
And it ends with these closing words right here.

[slide 3: Last]
The last slide has a few closing words for everyone.
`;

function harness(clicks = {}, options = {}) {
  const doc = parseScript(SCRIPT, { lang: 'en' });
  const idx = slideIndex(doc);
  let clock = 1000;
  const sent = [];
  const logs = [];
  const deck = { ...clicks };
  const ctl = new BuildController(doc, {
    send: async (a) => { sent.push(a); },
    range: idx.range,
    markers: idx.markers,
    clicks: (n) => deck[n] ?? null,
    log: (e, d) => logs.push({ e, ...d }),
    now: () => clock,
    options: { gapMs: 0, verifyMs: 1000, ...options },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { doc, ctl, sent, logs, deck, range: idx.range, flush, advance: (ms) => { clock += ms; } };
}
const view = (pos, status = 'tracking') => ({ pos, status });

test('a pause a few words short of the end turns the slide', async () => {
  const { ctl, sent, flush, range, logs } = harness();
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  const r = range(2);
  ctl.view(view(r.tokStart + 2), true);
  ctl.view(view(r.tokEnd - 3), true);
  await flush();
  assert.equal(sent.length, 0, 'still speaking: no turn yet');
  ctl.view(view(r.tokEnd - 6, 'paused'), true);
  await flush();
  assert.equal(sent.length, 0, 'a pause further from the end is not the end');
  ctl.view(view(r.tokEnd - 3, 'paused'), true);
  await flush();
  assert.equal(sent.length, 1);
  assert.ok(logs.some((l) => l.e === 'advance-near-end' && l.left === 3));
});

test('markers beyond the deck\'s builds do not turn the slide early', async () => {
  const { doc, ctl, sent, flush, range } = harness({ 1: 2 });
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  assert.equal(ctl.status().total, 2);
  ctl.view(view(1), true);
  for (const b of doc.builds) ctl.view(view(b.tok), true);
  await flush();
  assert.equal(sent.length, 2, 'only the deck\'s two builds');
  ctl.view(view(range(1).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 3, 'the end of the text turns the slide');
  // counts that arrive later apply to the slide on screen
  const h = harness();
  h.ctl.slideState({ playing: true, slide: 1, total: 3 });
  assert.equal(h.ctl.status().total, 4);
  h.deck[1] = 3;
  h.ctl.refreshDeck();
  assert.equal(h.ctl.status().total, 3);
});

test('with the build count known, hand clicks are builds until the last one', async () => {
  const { ctl, sent, flush, range } = harness({ 2: 2 });
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  ctl.manual('next');
  ctl.manual('next'); // the two unmarked builds by hand
  ctl.view(view(range(2).tokStart + 1), true);
  ctl.view(view(range(2).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 1, 'the end of the text still turns the slide');
  const h = harness({ 2: 2 });
  h.ctl.slideState({ playing: true, slide: 2, total: 3 });
  h.ctl.manual('next');
  h.ctl.manual('next');
  h.ctl.manual('next'); // past the builds: the turn
  h.ctl.view(view(range(2).tokStart + 1), true);
  h.ctl.view(view(range(2).tokEnd - 1), true);
  await h.flush();
  assert.equal(h.sent.length, 0);
});

test('an advance clicks through every unmarked build the deck has', async () => {
  const { ctl, sent, flush, range, advance, logs } = harness({ 2: 8 }, { maxExtra: 2 });
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  ctl.view(view(range(2).tokStart + 1), true);
  ctl.view(view(range(2).tokEnd - 1), true);
  await flush();
  for (let i = 0; i < 12; i++) {
    advance(1200);
    ctl.tick(true);
    await flush();
  }
  assert.equal(sent.length, 10, 'eight builds, the turn, and one spare');
  assert.ok(logs.some((l) => l.e === 'advance-gave-up'));
});

test('a hand click before any speech on the slide does not block the turn', async () => {
  const { ctl, sent, flush, range, advance } = harness();
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  ctl.manual('next'); // a build the script does not mark, before speaking
  advance(1200);
  ctl.tick(true);
  ctl.view(view(range(2).tokStart + 1), true);
  ctl.view(view(range(2).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 1);
});

test('a turn the speech did not make is logged with where the speech was', () => {
  const { ctl, logs, range } = harness({ 2: 2 });
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  ctl.view(view(range(2).tokStart + 4), true);
  ctl.manual('next-slide');
  ctl.slideState({ playing: true, slide: 3, total: 3 });
  const l = logs.find((x) => x.e === 'slide-change');
  assert.ok(l);
  assert.deepEqual({ from: l.from, to: l.to, by: l.by, status: l.status, deck: l.deck, marks: l.marks },
    { from: 2, to: 3, by: 'hand', status: 'tracking', deck: 2, marks: 0 });
  assert.equal(l.left, range(2).tokEnd - range(2).tokStart - 4);
  assert.ok(!JSON.stringify(l).match(/closing|words/), 'no script text in the log');
});
