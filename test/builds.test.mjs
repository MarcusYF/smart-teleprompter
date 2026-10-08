// Click markers in scripts and the speech-driven build controller (offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, buildCue } from '../public/lib/script.js';
import { BuildController } from '../public/lib/builds.js';

const SCRIPT = `[slide 1: Intro]
We start with the picture on the left.
[click]
The first bullet says that distance matters a lot.

[click] The second bullet adds up the violated distances.
That is all for this slide, so let us move on.

[slide 2: Next]
Here the second slide begins with its own words.
[click x2] Both formulas appear together now.
And this slide ends right here today.

[slide 3: Last]
The last slide has a few closing words for everyone.
`;

// The app's helpers, over a parsed doc.
function harness(text = SCRIPT, options = {}) {
  const doc = parseScript(text, { lang: 'en' });
  const starts = doc.slides.map((s) => ({ n: s.n, tokStart: s.tokStart })).sort((a, b) => a.tokStart - b.tokStart);
  const range = (n) => {
    const i = starts.findIndex((s) => s.n === n);
    if (i < 0) return null;
    return { tokStart: starts[i].tokStart, tokEnd: i + 1 < starts.length ? starts[i + 1].tokStart : doc.tokens.length };
  };
  const nextRange = (n) => {
    const i = starts.findIndex((s) => s.n === n);
    return i >= 0 && i + 1 < starts.length ? range(starts[i + 1].n) : null;
  };
  let clock = 1000;
  const sent = [];
  const logs = [];
  const ctl = new BuildController(doc, {
    send: async (a) => { sent.push(a); },
    range, nextRange,
    markers: (n) => doc.builds.filter((b) => b.slide === n),
    log: (e, d) => logs.push({ e, ...d }),
    now: () => clock,
    options: { gapMs: 0, verifyMs: 1000, ...options },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { doc, ctl, sent, logs, range, flush, advance: (ms) => { clock += ms; } };
}

const view = (pos, status = 'tracking') => ({ pos, status });

test('markers: forms, counts, positions and slides', () => {
  assert.deepEqual(buildCue('click'), { count: 1 });
  assert.deepEqual(buildCue('点击 x2'), { count: 2 });
  assert.equal(buildCue('pause'), null);
  const { doc } = harness();
  assert.equal(doc.builds.length, 3);
  const [a, b, c] = doc.builds;
  assert.equal(doc.tokens[a.tok].n, 'the'); // before "The first bullet"
  assert.equal(doc.tokens[a.tok - 1].n, 'left');
  assert.equal(doc.tokens[b.tok].n, 'the');
  assert.equal(doc.tokens[b.tok - 1].n, 'lot');
  assert.deepEqual([a.slide, b.slide, c.slide], [1, 1, 2]);
  assert.equal(c.count, 2);
  // markers never become spoken text
  assert.ok(!doc.phrases.some((p) => /click/.test(p.text)));
  assert.ok(!doc.sents.some((s) => s.tokStart === s.tokEnd), 'no empty sentences');
});

test('markers: math brackets, sources and stage directions are not clicks', () => {
  const doc = parseScript('[slide 1]\nThe interval [0, 1] is closed. [Sources] here.\n// [click] only a note\nDone now.\n', { lang: 'en' });
  assert.equal(doc.builds.length, 0);
  const zh = parseScript('[slide 1]\n先看这张图。【点击】再看公式[点击]。\n▶ 最后是结论。\n', { lang: 'zh' });
  assert.equal(zh.builds.length, 3);
});

test('a marker at the end of a slide stays on that slide', () => {
  const doc = parseScript('[slide 1]\nFirst slide words here.\n\n[click]\n\n[slide 2]\nSecond slide words.\n', { lang: 'en' });
  assert.equal(doc.builds.length, 1);
  assert.equal(doc.builds[0].slide, 1);
  assert.ok(doc.blocks.some((b) => b.type === 'build'));
});

test('speech reaching a marker plays one build; the end of the slide advances', async () => {
  const { doc, ctl, sent, flush, range } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  const [a, b] = doc.builds;
  ctl.view(view(0), true);
  ctl.view(view(a.tok - 3), true);
  await flush();
  assert.equal(sent.length, 0, 'not yet');
  ctl.view(view(a.tok - 1), true); // saying the last word before the marker
  await flush();
  assert.equal(sent.length, 1);
  ctl.view(view(a.tok + 4), true);
  await flush();
  assert.equal(sent.length, 1, 'once per marker');
  ctl.view(view(b.tok), true);
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(ctl.status().done, 2);
  ctl.view(view(range(1).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 3, 'advance');
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  assert.equal(ctl.status().slide, 2);
  assert.equal(ctl.status().done, 0);
});

test('nothing fires unless listening, playing and enabled', async () => {
  const { doc, ctl, sent, flush } = harness();
  const a = doc.builds[0];
  ctl.slideState({ playing: false, slide: 1, total: 3 });
  ctl.view(view(a.tok + 2), true);
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(a.tok + 2), false);
  ctl.builds = false;
  ctl.view(view(a.tok + 2), true);
  ctl.view(view(a.tok + 2, 'offscript'), true);
  await flush();
  assert.equal(sent.length, 0);
  // back on: what was passed while off is not replayed; the next marker plays
  ctl.builds = true;
  ctl.view(view(a.tok + 2), true);
  await flush();
  assert.equal(sent.length, 0);
  ctl.view(view(doc.builds[1].tok), true);
  await flush();
  assert.equal(sent.length, 1);
});

test('skipping ahead inside the slide catches up on the builds in between', async () => {
  const { doc, ctl, sent, flush } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  ctl.view(view(doc.builds[1].tok + 2), true);
  await flush();
  assert.equal(sent.length, 2);
});

test('speech two slides ahead does not drive the show', async () => {
  const { ctl, sent, flush, range } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  ctl.view(view(range(3).tokStart + 2), true);
  await flush();
  assert.equal(sent.length, 0);
});

test('a hand click consumes the next marker; speech then does not click it again', async () => {
  const { doc, ctl, sent, flush } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  ctl.manual('next');
  assert.equal(ctl.status().done, 1);
  ctl.view(view(doc.builds[0].tok + 1), true);
  await flush();
  assert.equal(sent.length, 0);
  ctl.view(view(doc.builds[1].tok + 1), true);
  await flush();
  assert.equal(sent.length, 1, 'the second marker still plays');
});

test('a hand click replaces our queued click for the same build', async () => {
  const { doc, ctl, sent, flush } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  // queue without letting the pump run, then the hand clicks
  ctl.sending = true;
  ctl.view(view(doc.builds[0].tok), true);
  ctl.manual('next');
  ctl.sending = false;
  ctl._pump();
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(ctl.status().done, 1);
});

test('previous build re-arms the marker until the speech crosses it again', async () => {
  const { doc, ctl, sent, flush } = harness();
  const a = doc.builds[0];
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  ctl.view(view(a.tok + 1), true);
  await flush();
  assert.equal(sent.length, 1);
  ctl.manual('prev-build');
  assert.equal(ctl.status().done, 0);
  ctl.view(view(a.tok + 3), true);
  await flush();
  assert.equal(sent.length, 1, 'not re-shown while the speech stays past it');
  ctl.view(view(a.tok - 4), true); // the speaker re-reads from before it
  ctl.view(view(a.tok), true);
  await flush();
  assert.equal(sent.length, 2);
});

test('going back to an earlier slide hands it to the speaker', async () => {
  const { ctl, sent, flush, range } = harness();
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  assert.equal(ctl.status().manual, true);
  ctl.view(view(range(1).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 0);
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  assert.equal(ctl.status().manual, false);
});

test('an advance that does not change the slide clicks again, then gives up', async () => {
  const { ctl, sent, flush, range, advance, logs } = harness(undefined, { maxExtra: 2 });
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.manual('next');
  ctl.manual('next'); // both builds by hand
  ctl.view(view(range(1).tokStart + 1), true);
  ctl.view(view(range(1).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 1);
  advance(1200);
  ctl.tick(true);
  await flush();
  assert.equal(sent.length, 2, 'one more click');
  advance(1200);
  ctl.tick(true);
  await flush();
  advance(1200);
  ctl.tick(true);
  await flush();
  assert.equal(sent.length, 3, 'at most maxExtra extra clicks');
  assert.ok(logs.some((l) => l.e === 'advance-gave-up'));
});

test('no advance from the last slide, nor from a slide with no text', async () => {
  const { ctl, sent, flush, range } = harness();
  ctl.slideState({ playing: true, slide: 3, total: 3 });
  ctl.view(view(range(3).tokStart + 1), true);
  ctl.view(view(range(3).tokEnd), true);
  await flush();
  assert.equal(sent.length, 0);
  const h = harness('[slide 1]\n// picture only\n\n[slide 2]\nWords on the second slide.\n');
  h.ctl.slideState({ playing: true, slide: 1, total: 2 });
  h.ctl.view(view(0), true);
  h.ctl.view(view(1), true);
  await h.flush();
  assert.equal(h.sent.length, 0);
});

test('a hand click that turns the slide is not followed by our advance', async () => {
  const { ctl, sent, flush, range } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.manual('next');
  ctl.manual('next');
  ctl.manual('next'); // past the builds: the slide turns by hand
  ctl.view(view(range(1).tokStart + 1), true);
  ctl.view(view(range(1).tokEnd - 1), true);
  await flush();
  assert.equal(sent.length, 0);
});

test('marker states for the chips', async () => {
  const { doc, ctl, flush } = harness();
  ctl.slideState({ playing: true, slide: 1, total: 3 });
  ctl.view(view(1), true);
  ctl.view(view(doc.builds[0].tok), true);
  await flush();
  assert.equal(ctl.markerState(0, 1), 'done');
  assert.equal(ctl.markerState(1, 1), 'next');
  assert.equal(ctl.markerState(2, 2), 'todo');
  ctl.slideState({ playing: true, slide: 2, total: 3 });
  assert.equal(ctl.markerState(0, 1), 'done');
  ctl.manual('next');
  assert.equal(ctl.markerState(2, 2), 'next', 'one of two clicks done');
  ctl.manual('next');
  assert.equal(ctl.markerState(2, 2), 'done');
});
