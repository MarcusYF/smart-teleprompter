// Adversarial QA scenarios for speech-driven builds (from the review of
// 2026-10-01): a simulated Keynote counts builds per slide, and every
// scenario checks that speech, hand clicks and watcher reports keep the
// controller in step with the show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, buildCue } from '../public/lib/script.js';
import { BuildController, slideIndex } from '../public/lib/builds.js';

// A fake Keynote show. builds[n] = number of builds on slide n.
// next() = AppleScript "show next" / clicker: one build, else the next slide.
class FakeKeynote {
  constructor(builds, { slide = 1, total = null } = {}) {
    this.builds = builds;
    this.slide = slide;
    this.built = 0;
    this.total = total ?? Math.max(...Object.keys(builds).map(Number));
    this.history = [];
  }
  next(who = 'auto') {
    if (this.built < (this.builds[this.slide] || 0)) this.built++;
    else if (this.slide < this.total) {
      this.slide++;
      this.built = 0;
    }
    this.history.push({ who, slide: this.slide, built: this.built });
  }
  prevBuild(who = 'hand') {
    if (this.built > 0) this.built--;
    this.history.push({ who, slide: this.slide, built: this.built, prev: true });
  }
  state() {
    return { playing: true, slide: this.slide, total: this.total };
  }
}

function harness(text, { options = {}, lang = 'en', slideMap = null, send = null } = {}) {
  const doc = parseScript(text, { lang });
  const idx = slideIndex(doc, slideMap);
  const h = { doc, sent: [], logs: [], clock: 1000 };
  h.ctl = new BuildController(doc, {
    send: send ? (a) => send(a, h) : async (a) => { h.sent.push(a); },
    range: idx.range,
    markers: idx.markers,
    log: (e, d) => h.logs.push({ e, ...d }),
    now: () => h.clock,
    options: { gapMs: 0, verifyMs: 1000, ...options },
  });
  h.range = idx.range;
  h.markersFor = idx.markers;
  h.slideOf = idx.slideOf;
  h.flush = () => new Promise((r) => setTimeout(r, 0));
  h.wait = (ms) => new Promise((r) => setTimeout(r, ms));
  h.advance = (ms) => { h.clock += ms; };
  return h;
}

const view = (pos, status = 'tracking') => ({ pos, status });

// What app.js does on a watcher report: controller first, then the follower's
// slideChanged (pos moves to the slide start unless already inside it).
function report(h, st, pos) {
  h.ctl.slideState(st);
  const r = h.range(st.slide);
  if (r && !(pos >= r.tokStart && pos < r.tokEnd)) {
    pos = r.tokStart;
    h.ctl.view(view(pos), true); // the follower emits 'slide' only when it moved
  }
  return pos;
}


// ---------------------------------------------------------- b1-heading-markers
// B1: markers after a `#` heading inside a slide (and on slide 1 of a `---`
// deck) get slide: null, so markersFor(n) (b.slide === n) never returns them.

const TITLED_B1 = `[slide 3: Gradient descent]
## Intuition
We walk downhill [click] one step at a time.
## Update rule
The update subtracts the gradient [click] times the step size.

[slide 4]
Next slide words here.
`;

test('B1a: markers under a heading in a titled slide belong to that slide', () => {
  const { doc } = harness(TITLED_B1);
  assert.deepEqual(doc.builds.map((b) => b.slide), [3, 3], 'both markers are on slide 3');
});

test('B1b: speech reaching a marker under a heading clicks', async () => {
  const h = harness(TITLED_B1);
  h.ctl.slideState({ playing: true, slide: 3, total: 4 });
  h.ctl.view(view(0), true);
  h.ctl.view(view(h.doc.builds[0].tok), true);
  await h.flush();
  assert.equal(h.sent.length, 1, 'one build for the first marker');
  assert.equal(h.ctl.status().total, 2, 'slide 3 has two clicks');
});

test('B1c: slide 1 of a --- deck keeps its markers', () => {
  const { doc } = harness('Opening words for the first slide [click] and then more words here.\n---\nSecond slide words are here today.\n');
  assert.equal(doc.builds[0].slide, 1);
});

test('B1d: a mid-slide heading does not drop the marker after it', () => {
  const { doc } = harness('[slide 1: Intro]\nWe open with the overview of today.\n## Details\nHere are the details [click] and the formula shows up now.\n\n[slide 2: Next]\nThe next slide begins here with words.\n');
  assert.equal(doc.builds[0].slide, 1);
});

// ---------------------------------------------------------- b2-trailing-marker
// B2: a [click] at the end of a slide's notes (tok == the slide's tokEnd) is
// queued in the same view() call as the end-of-slide advance: two "show
// next" go out one gap apart. script.js documents [click] as "a build or the
// next slide"; when it is the next-slide click, the advance (sent before the
// watcher reports) skips a slide. When it is a build, the build is visible for
// one gap (450 ms) before the slide turns.

const SCRIPT_B2 = `[slide 1]
We finish the first slide with this sentence.
[click]

[slide 2]
The second slide has its own words to say.

[slide 3]
The third slide closes the talk for today.
`;

test('B2a: a trailing marker and the advance are not both fired at once', async () => {
  const h = harness(SCRIPT_B2);
  const r = h.range(1);
  assert.equal(h.doc.builds[0].tok, r.tokEnd, 'the marker sits at the very end of slide 1');
  h.ctl.slideState({ playing: true, slide: 1, total: 3 });
  h.ctl.view(view(r.tokStart), true);
  h.ctl.view(view(r.tokEnd - 1), true); // saying the last word of slide 1
  await h.flush();
  // observed: 2 sends (build + advance) from one view() call
  assert.equal(h.sent.length, 1, 'one click now; the advance must wait for the watcher / a dwell');
});

test('B2b: [click] meant as the next-slide click + auto advance skips slide 2 (watcher slower than the gap)', async () => {
  const kn = new FakeKeynote({ 1: 0, 2: 0, 3: 0 }); // slide 1 has no Keynote build
  // production-like timing scaled 1/10: gap 45 ms, watcher reports 60 ms after the change
  const h = harness(SCRIPT_B2, {
    options: { gapMs: 45 },
    send: async () => {
      const before = kn.slide;
      kn.next('auto');
      if (kn.slide !== before) setTimeout(() => report(h, kn.state(), h.pos), 60);
    },
  });
  h.ctl.now = () => Date.now(); // real clock so the gap is real
  h.pos = h.range(1).tokStart;
  h.ctl.slideState({ playing: true, slide: 1, total: 3 });
  h.ctl.view(view(h.pos), true);
  h.pos = h.range(1).tokEnd - 1;
  h.ctl.view(view(h.pos), true);
  await h.wait(250);
  assert.equal(kn.slide, 2, `Keynote should be on slide 2, history ${JSON.stringify(kn.history)}`);
});

// ---------------------------------------------------------- b3-hand-after-auto-advance
// B3: the speaker presses the clicker right after the speech-driven advance
// was sent but before the watcher reports the new slide. Keynote gets two
// clicks (slide 2 + its first build); the controller books the hand click on
// slide 1 (advanced = true / handled) and enters slide 2 with done = 0. Every
// build on slide 2 then comes one marker early and the last marker turns the
// slide in the middle of slide 2's text.

const SCRIPT_B3 = `[slide 1]
We close the first slide with a short sentence now.

[slide 2]
Here the second slide starts with a few words.
[click] The first formula appears on the screen.
[click] The second formula appears below it now.
And the slide still has this closing sentence to read.

[slide 3]
The third slide is the last one for today.
`;

test('B3: a hand click in the advance->watcher window is counted on the new slide', async () => {
  const kn = new FakeKeynote({ 1: 0, 2: 2, 3: 0 });
  const h = harness(SCRIPT_B3, { send: async () => kn.next('auto') });
  const [m1, m2] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.view(view(h.range(1).tokEnd - 1), true); // end of slide 1 -> advance
  await h.flush();
  assert.equal(kn.slide, 2);
  // the speaker also presses the clicker (habit) ~200 ms later, before the watcher reports
  kn.next('hand');
  h.ctl.manual('next');
  let pos = report(h, kn.state(), h.range(1).tokEnd - 1); // watcher: slide 2
  await h.flush();
  assert.equal(kn.built, 1, 'the hand click showed build 1 of slide 2');
  // speech reaches marker 1: nothing should be sent (build 1 is already out)
  pos = m1.tok;
  h.ctl.view(view(pos), true);
  await h.flush();
  pos = m2.tok;
  h.ctl.view(view(pos), true);
  await h.flush();
  // observed: Keynote has turned to slide 3 while the speaker is still in slide 2's text
  assert.equal(kn.slide, 2, `still on slide 2 before its last sentence; history ${JSON.stringify(kn.history)}`);
  assert.equal(kn.built, 2);
});

// ---------------------------------------------------------- b4-watcher-hiccup
// B4: a transient non-playing state from the watcher mid-slide resets the
// slide's click count; the next speech update re-clicks every marker already
// passed. server/slides.mjs turns any JXA error iteration into
// {playing: false, slide: null, error} (st.playing undefined -> !!undefined),
// followed by the normal state on the next poll.

const SCRIPT_B4 = `[slide 1]
We start with the picture on the left side.
[click] The first bullet says that distance matters a lot.
[click] The second bullet adds up the violated distances.
That is all for this slide so let us move on now.

[slide 2]
The second slide has words of its own today.
`;

test('B4a: an error/hiccup pair from the watcher does not re-click shown builds', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 0 });
  const h = harness(SCRIPT_B4, { send: async () => kn.next('auto') });
  const [m1] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.view(view(m1.tok + 1), true);
  await h.flush();
  assert.equal(kn.built, 1);
  // one failed JXA poll, then the normal state again (same slide, show still running)
  h.ctl.slideState({ playing: false, slide: null, total: null, error: 'Error: AppleEvent timed out. (-1712)' });
  h.ctl.slideState(kn.state());
  h.ctl.view(view(m1.tok + 2), true); // next word of speech
  await h.flush();
  // observed: built === 2 (marker 1 clicked a second time = marker 2's build shown early)
  assert.equal(kn.built, 1, `no extra click; history ${JSON.stringify(kn.history)}`);
});

test('B4b: same with a watcher report of playing:false on the same slide', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 0 });
  const h = harness(SCRIPT_B4, { send: async () => kn.next('auto') });
  const [m1] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.view(view(m1.tok + 1), true);
  await h.flush();
  h.ctl.slideState({ playing: false, slide: 1, total: 2 });
  h.ctl.slideState(kn.state());
  h.ctl.view(view(m1.tok + 2), true);
  await h.flush();
  assert.equal(kn.built, 1, `no extra click; history ${JSON.stringify(kn.history)}`);
});

// ---------------------------------------------------------- b5-far-guard-empty-next
// B5: "speech more than one slide ahead does not drive the show" is skipped
// when the next slide has no text (picture slide / slide without notes):
// the guard requires nr.tokEnd > nr.tokStart. Speech any number of slides
// ahead then fires the slide's markers and its advance.

const SCRIPT_B5 = `[slide 1]
We start with the first slide [click] and its single build.
That is all for the first slide today.

[slide 2]
// picture only

[slide 3]
The third slide has a paragraph of words to say.

[slide 4]
The fourth slide has another paragraph of words.

[slide 5]
The fifth slide is far away from the first one.
`;

test('B5: speech four slides ahead does not drive slide 1 (next slide is a picture)', async () => {
  const h = harness(SCRIPT_B5);
  h.ctl.slideState({ playing: true, slide: 1, total: 5 });
  h.ctl.view(view(1), true);
  h.ctl.view(view(h.range(5).tokStart + 3), true); // a far jump (Jev / tracker) into slide 5
  await h.flush();
  // observed: 2 sends (the marker and the advance)
  assert.equal(h.sent.length, 0);
});

// ---------------------------------------------------------- b6-slidemap-markers
// B6: scripts without [slide] markers use the Jev alignment (S.slideMap,
// slide starts at paragraph starts). app.js markersFor() assigns markers by
// b.tok > r.tokStart && b.tok <= r.tokEnd, so a [click] that opens the first
// paragraph of a slide (tok == that slide's tokStart) is booked on the
// previous slide; and the chips never change state because markerState() is
// called with doc.builds[idx].slide, which is null for every marker here.

const SCRIPT_B6 = `We start with the first paragraph about the topic at hand today.

[click] The second paragraph begins with a build on the new slide.
It continues for a while with more words to say here.

The third paragraph is on the last slide with words.
`;

const mapOf = (doc) => doc.paras.map((p, i) => ({ n: i + 1, para: i, tokStart: p.tokStart }));

test('B6a: a marker opening a slide\'s first paragraph belongs to that slide', () => {
  const doc = parseScript(SCRIPT_B6, { lang: 'en' });
  const h = harness(SCRIPT_B6, { slideMap: mapOf(doc) });
  assert.equal(h.doc.builds[0].tok, h.range(2).tokStart);
  assert.deepEqual(h.markersFor(2).map((b) => b.idx), [0], 'on slide 2');
  assert.deepEqual(h.markersFor(1).map((b) => b.idx), [], 'not on slide 1');
});

test('B6b: with a quick watcher the build of slide 2 is never shown at its marker', async () => {
  const doc = parseScript(SCRIPT_B6, { lang: 'en' });
  const kn = new FakeKeynote({ 1: 0, 2: 1, 3: 0 });
  let pos = 0;
  const h = harness(SCRIPT_B6, {
    slideMap: mapOf(doc),
    send: async () => {
      const before = kn.slide;
      kn.next('auto');
      if (kn.slide !== before) pos = report(h, kn.state(), pos); // watcher faster than the gap
    },
  });
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  pos = h.range(1).tokEnd - 1;
  h.ctl.view(view(pos), true); // end of slide 1
  await h.flush();
  assert.equal(kn.slide, 2);
  pos = h.doc.builds[0].tok + 3; // the speaker is into the marker's sentence on slide 2
  h.ctl.view(view(pos), true);
  await h.flush();
  assert.equal(kn.built, 1, `build 1 of slide 2 shown; history ${JSON.stringify(kn.history)}`);
});

test('B6c: chips of a slideMap script show progress', async () => {
  const doc = parseScript(SCRIPT_B6, { lang: 'en' });
  const h = harness(SCRIPT_B6, { slideMap: mapOf(doc) });
  const b = h.doc.builds[0];
  assert.equal(b.slide, null, 'no [slide] sections: the parser cannot know');
  assert.equal(h.slideOf(b), 2, 'the slide index places it on slide 2');
  h.ctl.slideState({ playing: true, slide: 1, total: 3 });
  h.ctl.view(view(0), true);
  assert.equal(h.ctl.markerState(0, h.slideOf(b)), 'todo');
  h.ctl.view(view(h.range(1).tokEnd - 1), true); // end of slide 1: advance
  await h.flush();
  assert.equal(h.sent.length, 1);
  h.ctl.slideState({ playing: true, slide: 2, total: 3 });
  assert.equal(h.ctl.markerState(0, h.slideOf(b)), 'next');
  h.ctl.view(view(b.tok + 2), true);
  await h.flush();
  assert.equal(h.ctl.markerState(0, h.slideOf(b)), 'done');
  assert.equal(h.ctl.markerState(0, b.slide), 'todo', 'with the raw (null) slide the chip would never move');
});

// ---------------------------------------------------------- b7-resume-catch-up
// B7: pausing automatic control (the build chip / tpShell.toggleBuilds ->
// builds = advance = false) and resuming later fires, in one burst, every
// marker the speech passed while paused and then the slide advance — the
// builds the speaker chose not to show, and a slide turn the moment the
// speaker resumes (e.g. after Q&A on the slide).

const SCRIPT_B7 = `[slide 1]
We start with the picture on the left side.
[click] The first bullet says that distance matters a lot.
[click] The second bullet adds up the violated distances.
That is all for this slide so let us move on now.

[slide 2]
The second slide has words of its own today.
`;

test('B7: resuming after a pause does not replay what was passed while paused', async () => {
  const h = harness(SCRIPT_B7);
  h.ctl.slideState({ playing: true, slide: 1, total: 2 });
  h.ctl.view(view(1), true);
  h.ctl.builds = false; // chip: paused
  h.ctl.advance = false;
  h.ctl.view(view(h.doc.builds[1].tok + 2), true); // talks through both markers, no clicks
  h.ctl.view(view(h.range(1).tokEnd - 1), true);
  await h.flush();
  assert.equal(h.sent.length, 0);
  h.ctl.builds = true; // chip: resumed (Q&A on this slide follows)
  h.ctl.advance = true;
  h.ctl.view(view(h.range(1).tokEnd - 1, 'paused'), true); // any follower emit
  await h.flush();
  // observed: 3 sends (both builds + the advance) at the moment of resuming
  assert.equal(h.sent.length, 0, `burst on resume: ${h.logs.map((l) => l.e).join(', ')}`);
});

// ---------------------------------------------------------- b8-prev-build-cancels-queued
// B8: 'prev-build' while one of our clicks is still queued (inside the gap,
// e.g. the second click of [click x2]) clears the queue but decrements done
// only once. done already counted the cancelled, never-sent click, so the
// controller ends one build ahead of Keynote.

const SCRIPT_B8 = `[slide 1]
We start with the picture on the left side here.
[click x2] Both formulas appear together on the slide now.
That is all for this slide so let us move on now.

[slide 2]
The second slide has words of its own today.
`;

test('B8: Shift-Left during the [click x2] gap leaves the count in step with Keynote', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 0 });
  const h = harness(SCRIPT_B8, { options: { gapMs: 50 }, send: async () => kn.next('auto') });
  const m = h.doc.builds[0];
  h.ctl.slideState(kn.state());
  h.ctl.view(view(1), true);
  h.ctl.view(view(m.tok), true); // first click goes out, the second waits for the gap
  await h.flush();
  assert.equal(kn.built, 1);
  assert.equal(h.ctl.queue.length, 1, 'second click queued');
  kn.prevBuild('hand'); // Shift-Left
  h.ctl.manual('prev-build');
  await h.wait(80);
  assert.equal(kn.built, 0, 'Keynote: no build shown');
  // observed: done === 1 although Keynote shows 0 builds
  assert.equal(h.ctl.status().done, kn.built, 'controller count matches Keynote');
});

// ---------------------------------------------------------- b9-verify-from-send-start
// B9: the advance verification window starts when the send STARTS
// (pendingAdvance.at = lastSentAt, set before await send). A slow osascript
// round trip (Keynote busy) eats the window, and tick() sends an extra click
// shortly after Keynote received the first one — before the watcher could
// report the new slide.

const SCRIPT_B9 = `[slide 1]
We close the first slide with a short sentence now.

[slide 2]
The second slide has its own words to say today.
`;

test('B9: no extra click 200 ms after a 1.5 s send completed', async () => {
  const h = harness(SCRIPT_B9, {
    options: { verifyMs: 1600 }, // production value
    send: async (a, hh) => { hh.sent.push(a); hh.clock += 1500; }, // osascript took 1.5 s
  });
  h.ctl.slideState({ playing: true, slide: 1, total: 2 });
  h.ctl.view(view(0), true);
  h.ctl.view(view(h.range(1).tokEnd - 1), true);
  await h.flush();
  assert.equal(h.sent.length, 1);
  h.advance(200); // the watcher normally needs 250-600 ms after Keynote acts
  h.ctl.tick(true);
  await h.flush();
  // observed: 2 (an extra "show next" 200 ms after the first one completed)
  assert.equal(h.sent.length, 1, `extra click too early: ${h.logs.map((l) => l.e).join(', ')}`);
});

// ---------------------------------------------------------- b10-startpos-far-ahead
// B10: startPos is captured before the range guards. If the first follower
// view on a new slide is far ahead (slideFollow off, or the SSE 'hello' path
// in onSlideState that skips follower.slideChanged), startPos sits beyond the
// next slide; the end-of-slide advance needs pos > startPos, which the far
// guard then never lets through: the slide never auto-advances.

const SCRIPT_B10 = `[slide 1]
We close the first slide with a short sentence now.

[slide 2]
The second slide has its own words to say today.

[slide 3]
The third slide has more words for the audience.
`;

test('B10: a far-ahead first view does not block the slide\'s advance', async () => {
  const h = harness(SCRIPT_B10);
  h.ctl.slideState({ playing: true, slide: 1, total: 3 });
  h.ctl.view(view(h.range(3).tokStart + 4), true); // stale far-ahead position at slide entry
  h.ctl.view(view(h.range(1).tokStart + 2), true); // the follower re-anchors on slide 1
  h.ctl.view(view(h.range(1).tokEnd - 1), true); // end of slide 1
  await h.flush();
  assert.equal(h.sent.length, 1, 'advance at the end of slide 1');
});

// ---------------------------------------------------------- b11-marker-forms
// B11 (minor parser): marker forms that are accepted in [[...]] but not in
// single brackets, full-width brackets from a Chinese IME, and bullet glyphs
// that become clicks.

test('B11a: ［点击］ (full-width brackets) is a marker, not spoken text', () => {
  const doc = parseScript('[slide 1]\n先看这张图。［点击］再看公式。\n', { lang: 'zh' });
  assert.equal(doc.builds.length, 1);
  assert.ok(!doc.phrases.some((p) => /点击/.test(p.text)), 'not in the spoken text');
});

test('B11b: [下一步] and [build] work like [[下一步]] / [[build]] (BUILD_CUE_RE accepts them)', () => {
  assert.ok(buildCue('下一步') && buildCue('build'));
  const doc = parseScript('[slide 1]\n先看这张图。[下一步]再看公式。\nThen [build] more.\n', { lang: 'zh' });
  assert.equal(doc.builds.length, 2);
});

test('B11c: a markdown-ish bullet glyph in notes is not a click', () => {
  const doc = parseScript('[slide 1]\nThree points today.\n► First point is short.\n► Second point is shorter.\n', { lang: 'en' });
  assert.equal(doc.builds.length, 0, 'bullet glyphs imported from notes');
});

test('B11d: [click] in a heading is either a marker or removed from the title', () => {
  const doc = parseScript('[slide 1]\nIntro words here today.\n## Step two [click]\nMore words follow here.\n', { lang: 'en' });
  const heading = doc.blocks.find((b) => b.type === 'heading');
  assert.ok(doc.builds.length === 1 || !/click/.test(heading.text), `heading text: ${heading.text}`);
});

// ---------------------------------------------------------- b12-hand-unmarked-build-stalls
// B12: the deck has one more build than the script has markers and the
// speaker clicks that build by hand mid-slide. manual('next') with all
// markers done assumes the click turned the slide (advanced = true) and never
// checks that the slide actually changed, so the end of the slide's text no
// longer advances: the show stalls on that slide.

const SCRIPT_B12 = `[slide 1]
We start with the picture on the left side here.
[click] The first bullet says that distance matters a lot.
Then I point at the extra figure on the right side.
And that is all for this slide so let us move on now.

[slide 2]
The second slide has words of its own today.
`;

test('B12: a hand click on an unmarked build does not cancel the end-of-slide advance', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 0 }); // 2 builds, 1 marker
  const h = harness(SCRIPT_B12, { send: async () => kn.next('auto') });
  const [m] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.view(view(m.tok + 2), true);
  await h.flush();
  assert.equal(kn.built, 1);
  // the speaker shows the extra figure by hand; Keynote stays on slide 1
  kn.next('hand');
  h.ctl.manual('next');
  assert.equal(kn.slide, 1);
  h.advance(3000); // no slide change is ever reported
  h.ctl.tick(true);
  h.ctl.view(view(h.range(1).tokEnd - 1), true); // end of slide 1's text
  await h.flush();
  h.advance(1200);
  h.ctl.tick(true);
  await h.flush();
  // observed: Keynote still on slide 1, nothing sent after the hand click
  assert.equal(kn.slide, 2, `history ${JSON.stringify(kn.history)}`);
});

// ---------------------------------------------------------- ok-sanity
// Scenarios checked and found fine (these should pass).

const SCRIPT_OK = `[slide 1]
We start with the picture on the left side.
[click] The first bullet says that distance matters a lot.
[click] The second bullet adds up the violated distances.
That is all for this slide so let us move on now.

[slide 2]
[click] The second slide opens with a build right away.
And then it has a few more words to say today.

[slide 4]
The fourth slide follows because slide three is skipped.
`;

test('ok: jitter around a marker and around the end never double-clicks', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 1, 3: 0, 4: 0 }, { total: 4 });
  const h = harness(SCRIPT_OK, { send: async () => kn.next('auto') });
  const [m1, m2] = h.doc.builds;
  h.ctl.slideState(kn.state());
  for (const p of [0, m1.tok - 1, m1.tok - 3, m1.tok - 1, m1.tok + 2, m1.tok - 2, m2.tok, m2.tok - 4, m2.tok + 1]) h.ctl.view(view(p), true);
  await h.flush();
  assert.equal(kn.built, 2);
  const e = h.range(1).tokEnd;
  for (const p of [e - 1, e - 3, e - 1, e]) h.ctl.view(view(p), true);
  await h.flush();
  assert.equal(kn.slide, 2);
  assert.equal(kn.history.length, 3, 'two builds and one advance');
});

test('ok: hand click just before / just after a marker keeps the count', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 1, 3: 0, 4: 0 }, { total: 4 });
  const h = harness(SCRIPT_OK, { send: async () => kn.next('auto') });
  const [m1, m2] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  kn.next('hand'); h.ctl.manual('next'); // just before marker 1
  h.ctl.view(view(m1.tok), true);
  await h.flush();
  assert.equal(kn.built, 1);
  h.ctl.view(view(m2.tok), true); // speech fires marker 2
  await h.flush();
  kn.next('hand'); h.ctl.manual('next'); // reflex click right after: turns the slide
  await h.flush();
  assert.equal(kn.slide, 2);
  h.ctl.view(view(h.range(1).tokEnd - 1), true);
  await h.flush();
  assert.equal(kn.slide, 2, 'no second turn');
});

test('ok: skipped slide (numbering 2 -> 4), start-of-slide marker, last slide', async () => {
  const kn = new FakeKeynote({ 1: 0, 2: 1, 3: 0, 4: 0 }, { total: 4 });
  kn.next = function (who) { // Keynote skips slide 3 during the show
    if (this.built < (this.builds[this.slide] || 0)) this.built++;
    else if (this.slide < this.total) { this.slide = this.slide === 2 ? 4 : this.slide + 1; this.built = 0; }
    this.history.push({ who, slide: this.slide, built: this.built });
  };
  const doc = parseScript(SCRIPT_OK, { lang: 'en' });
  const h = harness(SCRIPT_OK.replace(/\[click\] The first[\s\S]*?distances\.\n/, ''), { send: async () => kn.next('auto') });
  void doc;
  h.ctl.slideState({ playing: true, slide: 2, total: 4 });
  kn.slide = 2;
  let pos = report(h, kn.state(), 0); // the slide comes up: its opening marker fires at once
  await h.flush();
  assert.equal(kn.built, 1);
  pos = h.range(2).tokEnd - 1;
  h.ctl.view(view(pos), true);
  await h.flush();
  assert.equal(kn.slide, 4);
  pos = report(h, kn.state(), pos);
  h.ctl.view(view(h.range(4).tokEnd), true);
  await h.flush();
  assert.equal(kn.slide, 4, 'never past the last slide');
});

test('ok: listening off/on, transient null slide, restart from a later slide', async () => {
  const kn = new FakeKeynote({ 1: 2, 2: 1, 3: 0, 4: 0 }, { total: 4 });
  const h = harness(SCRIPT_OK, { send: async () => kn.next('auto') });
  const [m1, m2] = h.doc.builds;
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.view(view(m1.tok), true);
  await h.flush();
  h.ctl.view(view(m2.tok + 2), false); // listening off: nothing
  h.ctl.slideState({ playing: true, slide: null, total: 4 }); // watcher hiccup
  h.ctl.view(view(m2.tok + 2), true); // listening back on: catches up marker 2 once
  await h.flush();
  assert.equal(kn.built, 2);
  assert.equal(kn.history.length, 2);
  // show ends and restarts from slide 4
  h.ctl.slideState({ playing: false, slide: 4, total: 4 });
  kn.slide = 4; kn.built = 0;
  h.ctl.slideState({ playing: true, slide: 4, total: 4 });
  assert.equal(h.ctl.status().slide, 4);
  assert.equal(h.ctl.status().manual, false);
});

test('ok: hand click while our advance waits in the gap replaces it', async () => {
  const kn = new FakeKeynote({ 1: 0, 2: 1, 3: 0, 4: 0 }, { total: 4 });
  const h = harness('[slide 1]\nOne short sentence for the first slide here.\n\n[slide 2]\nThe second slide has words.\n', { send: async () => kn.next('auto') });
  h.ctl.slideState(kn.state());
  h.ctl.view(view(0), true);
  h.ctl.sending = true; // hold the pump
  h.ctl.view(view(h.range(1).tokEnd - 1), true);
  kn.next('hand'); h.ctl.manual('next');
  h.ctl.sending = false;
  h.ctl._pump();
  await h.flush();
  assert.equal(kn.slide, 2);
  assert.equal(kn.built, 0, 'one click in total');
});

// ---------------------------------------------------------- reload mid-show
test('R1: after a reload, restore() keeps an already shown build from being clicked again', async () => {
  const SCRIPT_R1 = `[slide 1]
We start with the picture on the left side.
[click] The first bullet says that distance matters a lot.
[click] The second bullet adds up the violated distances.
That is all for this slide so let us move on now.

[slide 2]
The second slide has words of its own today.
`;
  const kn = new FakeKeynote({ 1: 2, 2: 0 });
  kn.built = 1; // marker 1 was shown before the reload
  const h = harness(SCRIPT_R1, { send: async () => kn.next('auto') });
  const [m1, m2] = h.doc.builds;
  h.ctl.slideState(kn.state());
  assert.equal(h.ctl.restore(1, 1), true);
  h.ctl.view(view(h.range(1).tokStart), true);
  h.ctl.view(view(m1.tok + 3), true);
  await h.flush();
  assert.equal(kn.built, 1, `history ${JSON.stringify(kn.history)}`);
  h.ctl.view(view(m2.tok), true);
  await h.flush();
  assert.equal(kn.built, 2);
});

