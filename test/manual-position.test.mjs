// A manual position ("I am here": a click on the script) overrides the
// automatic one: nothing before it is missed, and the show catches up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../public/lib/script.js';
import { BuildController, slideIndex } from '../public/lib/builds.js';
import { Follower } from '../public/lib/follower.js';

const SCRIPT = `[slide 1: Intro]
We start with the picture on the left side of the slide.
[click] The first bullet says that distance matters a lot.
[click] The second bullet adds up the violated distances.
[click] The third bullet turns them into a loss function.
And that is all we need to say about this slide today.

[slide 2: Pictures]
// picture only

[slide 3: Next]
Here the third slide begins with its own words for us.
[click] Its first build shows the hinge loss on the board.
[click x2] Both formulas appear together right here.
And the third slide ends with these closing words today.

[slide 4: Last]
The last slide has a few closing words for everyone here.
`;

function harness(clicks = {}, options = {}) {
  const doc = parseScript(SCRIPT, { lang: 'en' });
  const idx = slideIndex(doc);
  let clock = 1000;
  const sent = [];
  const logs = [];
  let ctl;
  const show = { slide: 1, built: 0 };
  const deck = { 1: 3, 2: 0, 3: 3, 4: 0, ...clicks };
  const ctlOpts = {
    send: async () => {
      // a simulated Keynote that knows its builds
      sent.push(show.slide);
      if (show.built < (deck[show.slide] ?? 0)) show.built++;
      else { show.slide++; show.built = 0; }
    },
    range: idx.range,
    markers: idx.markers,
    clicks: (n) => deck[n] ?? null,
    log: (e, d) => logs.push({ e, ...d }),
    now: () => clock,
    options: { gapMs: 0, catchUpGapMs: 0, verifyMs: 1000, ...options },
  };
  ctl = new BuildController(doc, ctlOpts);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  // the watcher reports the show's slide
  const report = () => ctl.slideState({ playing: true, slide: show.slide, total: 4 });
  return { doc, idx, ctl, sent, logs, show, flush, report, advance: (ms) => { clock += ms; } };
}
const view = (pos, status = 'tracking') => ({ pos, status });
const wordAt = (doc, slide, re) => {
  const r = slideIndex(doc).range(slide);
  for (let t = r.tokStart; t < r.tokEnd; t++) if (re.test(doc.tokens[t].n)) return t;
  throw new Error(`no ${re} on slide ${slide}`);
};

test('a click later on the slide shows every build marked before it, at once', async () => {
  const h = harness();
  h.report();
  h.ctl.view(view(h.idx.range(1).tokStart + 1), true);
  const target = wordAt(h.doc, 1, /^third$/);
  assert.equal(h.ctl.seek(target), true);
  await h.flush();
  assert.equal(h.show.built, 3, 'three builds shown');
  assert.equal(h.show.slide, 1, 'the slide stays');
  assert.equal(h.ctl.status().done, 3);
  // speech from the clicked place does not turn the slide at once
  h.ctl.view(view(target + 1), true);
  await h.flush();
  assert.equal(h.show.slide, 1);
  // ... but reaching the end of the slide does
  h.ctl.view(view(h.idx.range(1).tokEnd - 1), true);
  await h.flush();
  assert.equal(h.show.slide, 2);
});

test('a click on a later slide turns the slides in between and shows its builds', async () => {
  const h = harness();
  h.report();
  h.ctl.view(view(h.idx.range(1).tokStart + 1), true);
  const target = wordAt(h.doc, 3, /^both$/); // after the [click] and the [click x2]
  assert.equal(h.ctl.seek(target), true);
  await h.flush();
  assert.deepEqual([h.show.slide, h.show.built], [2, 0], 'slide 1: three builds and the turn');
  // the speech meanwhile does not drive the show
  h.ctl.view(view(target + 2), true);
  h.report(); // slide 2 (a picture)
  await h.flush();
  assert.deepEqual([h.show.slide, h.show.built], [3, 0], 'the picture slide is turned too');
  h.report(); // slide 3
  await h.flush();
  assert.deepEqual([h.show.slide, h.show.built], [3, 3], 'the [click] and the [click x2] before the clicked word');
  assert.equal(h.ctl.seekTarget, null, 'arrived');
  assert.ok(h.logs.some((l) => l.e === 'seek' && l.into === 'later-slide'));
});

test('unmarked builds are clicked through before a turn when the deck says so', async () => {
  const h = harness({ 1: 5 }); // two builds more than the script marks
  h.report();
  h.ctl.view(view(h.idx.range(1).tokStart + 1), true);
  h.ctl.seek(h.idx.range(3).tokStart + 1);
  await h.flush();
  assert.equal(h.show.slide, 2);
  assert.equal(h.sent.filter((s) => s === 1).length, 6, 'five builds and the turn');
});

test('no catch-up when not listening, for an earlier slide, or after a hand turn back', async () => {
  const h = harness();
  h.report();
  h.ctl.setListening(false);
  assert.equal(h.ctl.seek(h.idx.range(3).tokStart), false);
  h.ctl.setListening(true);
  h.show.slide = 3;
  h.report();
  assert.equal(h.ctl.seek(h.idx.range(1).tokStart + 3), false, 'behind the current slide: text only');
  await h.flush();
  assert.equal(h.sent.length, 0);
  // a hand turn back stops a catch-up in progress
  const g = harness();
  g.report();
  g.ctl.view(view(1), true);
  g.ctl.seek(g.idx.range(3).tokStart + 1);
  g.ctl.manual('prev-slide');
  assert.equal(g.ctl.seekTarget, null);
});

test('a slide the speaker took over by going back is driven again after a click', async () => {
  const h = harness();
  h.show.slide = 3;
  h.report();
  h.show.slide = 1;
  h.report(); // back: the speaker's slide
  assert.equal(h.ctl.status().manual, true);
  h.ctl.view(view(h.idx.range(1).tokStart + 1), true);
  h.ctl.seek(wordAt(h.doc, 1, /^second$/));
  await h.flush();
  assert.equal(h.show.built, 2);
  assert.equal(h.ctl.status().manual, false);
});

test('the catch-up clicks are faster than speech-driven ones', async () => {
  const doc = parseScript(SCRIPT, { lang: 'en' });
  const idx = slideIndex(doc);
  const times = [];
  const ctl = new BuildController(doc, {
    send: async () => { times.push(Date.now()); },
    range: idx.range, markers: idx.markers,
    options: { gapMs: 450, catchUpGapMs: 30 },
  });
  ctl.slideState({ playing: true, slide: 1, total: 4 });
  ctl.view(view(idx.range(1).tokStart + 1), true);
  ctl.seek(wordAt(doc, 1, /^third$/));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(times.length, 3);
  assert.ok(times[2] - times[0] < 250, `${times[2] - times[0]} ms for three clicks`);
});

test('the follower: nothing before a forward manual position is missed', () => {
  const doc = parseScript(SCRIPT, { lang: 'en' });
  const f = new Follower(doc);
  // two phrases on slide 1 were marked skipped
  f.skipped.add(1);
  f.skipped.add(2);
  const rev = f.revision;
  const target = slideIndex(doc).range(3).tokStart;
  f.overrideTo(target);
  assert.equal(f.pos, target);
  assert.equal(f.skipped.size, 0, 'no misses before the new position');
  assert.ok(f.revision > rev, 'pending skip checks are stale');
  // a later automatic move over the same text does not mark it again
  f._markSkips(0, target);
  assert.equal(f.skipped.size, 0);
  // going back by hand re-opens the text after it
  f.overrideTo(2);
  assert.equal(f.skipFloor, 2);
});
