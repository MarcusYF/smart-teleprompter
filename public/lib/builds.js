// Speech-driven slide builds and slide advances.
//
// A script marks where a click belongs with [click] (also [[click]], [next],
// [build], [点击], [动画], [下一步], ▶; "[click x2]" for two clicks). When the
// speaker's position reaches a marker on the slide that the show is
// displaying, the controller asks the slide app for one "next" (Keynote: show
// next = one build or the next slide). After the slide's last marker,
// reaching the end of the slide's text advances to the next slide; if the
// slide does not change (the deck has more builds than the script has
// markers), it clicks again, a few times at most. A marker at the very end of
// a slide's text is that slide's turn: it is sent once, as the advance.
//
// A speaker who stops a few words short of a slide's end (the recognizer
// missed them, or they were left out) and pauses also turns the slide.
//
// When the deck's build count per slide is known (read from the saved .key
// file), markers beyond it are ignored (the extra click would turn the slide
// before the speaker gets there), a hand click is known to be a build or the
// turn, and an advance may click through every build the script does not mark.
//
// A click on the script is the speaker saying "I am here" (seek()): the show
// catches up at once, every build marked up to that point and the turns of
// the slides in between, quickly one after another.
//
// Manual control keeps working: the native shell reports clicker, keyboard
// and mouse input during the show (manual()), which consumes or restores
// markers so speech and hand never click the same build twice. Going back to
// an earlier slide hands that slide to the speaker: no automatic clicks on it
// until the show moves forward again.
//
// Pure logic: the app supplies the doc, the slide ranges and send().

export const BUILD_DEFAULTS = {
  lead: 1,          // fire when all but this many tokens before the marker are read
  gapMs: 450,       // between two clicks we send
  catchUpGapMs: 150, // between the clicks that catch up with a manual jump
  verifyMs: 1600,   // wait this long (after the send completed) for the slide to change
  maxExtra: 6,      // extra clicks to finish a slide whose builds outnumber the markers
  blipMs: 1500,     // a show that "stops" and plays again on the same slide this fast never stopped
  farSlides: 60,    // how far to look for the next slide that has text
  nearEnd: { en: 3, zh: 6 }, // tokens short of a slide's end that a pause still turns
};

// Slide geometry shared by the app and the tests: where each slide's text is
// and which markers belong to it. Slides come from [slide N] sections, or
// from a Jev alignment (slideMap: [{n, tokStart}]) for scripts without them.
export function slideIndex(doc, slideMap = null) {
  let memo;
  const starts = () => {
    if (memo !== undefined) return memo;
    let st = null;
    if (doc.slides.length) st = doc.slides.map((s) => ({ n: s.n, tokStart: s.tokStart }));
    else if (slideMap) st = slideMap.map((m) => ({ n: m.n, tokStart: m.tokStart }));
    memo = st ? st.sort((a, b) => a.tokStart - b.tokStart) : null;
    return memo;
  };
  const range = (n) => {
    const st = starts();
    if (!st) return null;
    const i = st.findIndex((s) => s.n === n);
    if (i < 0) return null;
    return { n, tokStart: st[i].tokStart, tokEnd: i + 1 < st.length ? st[i + 1].tokStart : doc.tokens.length };
  };
  // The slide a marker belongs to. With [slide] sections the parser knows;
  // otherwise a marker that opens a phrase goes with the text after it, and
  // one that closes a phrase (or stands alone) with the text before it.
  const slideOf = (b) => {
    if (!b) return null;
    if (b.slide != null || doc.slides.length) return b.slide;
    const st = starts();
    if (!st) return null;
    const ph = b.phrase != null ? doc.phrases[b.phrase] : null;
    const opens = ph && b.tok === ph.tokStart && b.tok < ph.tokEnd;
    let n = null;
    for (const s of st) {
      if (opens ? s.tokStart <= b.tok : s.tokStart < b.tok) n = s.n;
      else break;
    }
    return n ?? st[0]?.n ?? null;
  };
  const markers = (n) => doc.builds.filter((b) => slideOf(b) === n);
  return { range, slideOf, markers };
}

export class BuildController {
  // opts.send(action) -> Promise; opts.range(n) -> {tokStart, tokEnd} | null
  // opts.markers(n) -> [{idx, tok, count}] on slide n (script order)
  // opts.clicks(n) -> the deck's build count on slide n, or null if unknown
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.O = { ...BUILD_DEFAULTS, ...(opts.options || {}) };
    this.send = opts.send || (async () => {});
    this.range = opts.range || (() => null);
    this.markersOf = opts.markers || (() => []);
    this.clicksOf = opts.clicks || (() => null);
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.onChange = opts.onChange || (() => {});
    this._builds = true;   // fire [click] markers
    this._advance = true;  // advance at the end of a slide's text
    this.queue = [];
    this.sending = false;
    this.lastSentAt = -1e9;
    this.slide = null;
    this.playing = false;
    this.total = null;
    this.listening = false;
    this.disposed = false;
    this.seekTarget = null; // a manual jump the show is catching up with
    this.generation = 0;
    this.inFlight = null;
    this.error = null;
    this._enter(null);
  }

  // Turning automatic control back on does not replay what the speech passed
  // while it was off (the speaker chose to show or skip those by hand).
  get builds() { return this._builds; }
  set builds(on) {
    if (on && !this._builds) this.resync = true;
    this._builds = !!on;
    if (!on) this._cancelQueued();
  }
  get advance() { return this._advance; }
  set advance(on) {
    if (on && !this._advance) this.resync = true;
    this._advance = !!on;
    if (!on) {
      this._cancelQueued((q) => q.kind === 'advance');
      this.pendingAdvance = null;
    }
  }

  setListening(on) {
    if (!on && this.queue.length) this.resync = true;
    this.listening = !!on;
    if (!on) {
      this._cancelQueued();
      this.pendingAdvance = null;
      this.seekTarget = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.setListening(false);
    this.generation++;
    this.onChange = () => {};
  }

  clearError() {
    this.error = null;
    this.resync = true;
    this.onChange();
  }

  // ------------------------------------------------------------- state

  _enter(n, how = 'forward', carry = 0) {
    this.generation++;
    this.error = null;
    this.queue = [];
    this.slide = n;
    this._loadMarks(n);
    // clicks of this slide already shown (a hand click that came right after
    // our advance landed on this slide)
    this.done = Math.min(carry, this.marks.length);
    this.handBuilds = this.known != null ? Math.max(0, Math.min(carry, this.known) - this.marks.length) : 0;
    this.manualSlide = how === 'back'; // the speaker took this slide over
    this.pendingAdvance = null;
    this.advanced = carry > (this.known ?? this.marks.length);
    this.handTurnAt = null;
    this.enteredAt = this.now();
    this.startPos = null;     // first speech position on this slide
    this.lastPos = null;
    this.lastStatus = null;
    this.extra = 0;
    this.resync = false;
    this.stoppedAt = null;
    this.queue = this.queue.filter((q) => q.slide === n);
    this.onChange();
  }

  // This slide's clicks: one entry per click (a "[click x2]" marker is two
  // clicks at one place); a marker at the very end of the slide's text is
  // the slide's turn. With the deck's build count known, markers past it are
  // dropped: their click would turn the slide early (the end of the text
  // turns it instead).
  _loadMarks(n) {
    const r = n != null ? this.range(n) : null;
    this.marks = [];
    if (n != null) {
      for (const m of this.markersOf(n)) {
        for (let k = 0; k < Math.max(1, m.count || 1); k++) {
          this.marks.push({ idx: m.idx, tok: m.tok, rearm: false, trailing: !!r && m.tok >= r.tokEnd });
        }
      }
    }
    const known = n != null ? this.clicksOf(n) : null;
    this.known = Number.isInteger(known) && known >= 0 ? known : null;
    this.capped = 0;
    if (this.known != null && this.marks.length > this.known) {
      this.capped = this.marks.length - this.known;
      this.marks.length = this.known;
    }
  }

  // The deck's build counts arrived or changed: apply them to this slide
  // without forgetting what it has shown.
  refreshDeck() {
    if (this.slide == null) return;
    const old = this.marks;
    const shown = this.done + this.handBuilds;
    this._loadMarks(this.slide);
    this.marks.forEach((m, i) => { if (old[i] && old[i].idx === m.idx) m.rearm = old[i].rearm; });
    this.done = Math.min(this.done, this.marks.length);
    this.handBuilds = this.known != null ? Math.max(0, Math.min(shown, this.known) - this.done) : 0;
    this.onChange();
  }

  // The show's state from the slide watcher: {slide, total, playing, error}.
  slideState(st) {
    const playing = !!(st && st.playing);
    const n = st && st.slide != null ? st.slide : null;
    // A failed poll ({error}) or a moment without a slide number while the
    // show plays is a watcher hiccup, not a change.
    if (this.playing && st && (st.error || (playing && n == null))) return;
    if (st && st.total != null) this.total = st.total;
    if (!playing) {
      if (this.playing) {
        // stopped, perhaps only for a moment: keep this slide's count
        this.playing = false;
        this.stoppedAt = this.now();
        this.stoppedSlide = this.slide;
        this._cancelQueued();
        this.pendingAdvance = null;
        this.seekTarget = null;
        this.onChange();
      } else if (n != null && n !== this.slide) {
        this._enter(n);
      }
      return;
    }
    if (!this.playing) {
      this.playing = true;
      if (this.stoppedAt != null && n === this.stoppedSlide && this.now() - this.stoppedAt < this.O.blipMs) {
        this.stoppedAt = null; // it never really stopped
        this.onChange();
        return;
      }
      // a show (re)starts: the current slide begins without its builds
      this._enter(n);
      return;
    }
    if (n === this.slide) return;
    const pend = this.pendingAdvance;
    if (pend) this.log('advance-ok', { from: pend.from, to: n, extra: this.extra, carry: pend.carry || 0 });
    else if (this.listening && this.slide != null) {
      // diagnosis of a turn the speech did not make: where the speech was
      // on the slide, and what drove the show (no words are logged)
      const r = this.range(this.slide);
      this.log('slide-change', {
        from: this.slide, to: n,
        by: this.lastManualAt != null && this.now() - this.lastManualAt < 4000 ? 'hand' : 'other',
        left: r && this.lastPos != null ? r.tokEnd - this.lastPos : null,
        len: r ? r.tokEnd - r.tokStart : null,
        status: this.lastStatus, shown: this.done, marks: this.marks.length,
        deck: this.known, manualSlide: this.manualSlide, advanced: this.advanced,
      });
    }
    const back = this.slide != null && n < this.slide;
    if (back) this.seekTarget = null;
    this._enter(n, back ? 'back' : 'forward', !back && pend && pend.from === this.slide ? pend.carry || 0 : 0);
    // catching up with a manual jump: on to the next slide's builds
    if (this.seekTarget != null) this._seekStep();
  }

  // After a page reload in the middle of a show: what had been shown.
  restore(slide, done) {
    if (slide !== this.slide || !this.playing) return false;
    this.done = Math.max(0, Math.min(done, this.marks.length));
    this.onChange();
    return true;
  }

  // Hand input during the show, reported by the native shell:
  // 'next' (build or slide), 'prev-build', 'prev-slide', 'next-slide', 'jump'.
  manual(kind) {
    const now = this.now();
    const pend = this.pendingAdvance;
    if (kind === 'next') {
      if (this.queue.length) {
        // our own queued click for the same build is no longer needed
        this.queue.shift();
        this.log('manual-replaces-auto', { slide: this.slide });
      } else if (pend && pend.sent && this.slide === pend.from) {
        // our advance went out and the watcher has not reported yet: this
        // click lands on the next slide
        pend.carry = (pend.carry || 0) + 1;
      } else if (this.done < this.marks.length) {
        this.done++;
      } else if (this.known != null && this.done + this.handBuilds < this.known) {
        // a build the script has no marker for
        this.handBuilds++;
      } else {
        // every marked build is out: this click turns the slide (or shows a
        // build the script has no marker for; tick() checks which)
        this.advanced = true;
        this.handTurnAt = now;
      }
      // a hand click while an unverified advance waits: the speaker is driving
      if (pend) pend.handled = true;
      this.lastManualAt = now;
    } else if (kind === 'prev-build') {
      this.seekTarget = null;
      this._cancelQueued();
      if (this.handBuilds > 0) {
        this.handBuilds--;
      } else if (this.done > 0) {
        this.done--;
        // shown again only if the speaker reads up to it again
        this.marks[this.done].rearm = true;
      }
      this.lastManualAt = now;
    } else if (kind === 'prev-slide' || kind === 'next-slide' || kind === 'jump') {
      this.seekTarget = null;
      this._cancelQueued();
      this.lastManualAt = now;
    }
    this.onChange();
  }

  // Drop our clicks that have not gone out: builds were counted when queued.
  _cancelQueued(predicate = () => true) {
    const keep = [];
    for (const q of this.queue) {
      if (!predicate(q)) { keep.push(q); continue; }
      if (q.slide === this.slide && q.count && this.done > 0) this.done--;
      if (q.kind === 'advance') {
        this.advanced = false;
        this.pendingAdvance = null;
      }
    }
    this.queue = keep;
  }

  // ------------------------------------------------------------- speech

  // The next slide that has text: speech beyond it is too far ahead to drive
  // the show (a far jump), whatever picture slides lie in between.
  _farLimit(n) {
    for (let m = n + 1; m <= n + this.O.farSlides; m++) {
      const r = this.range(m);
      if (r && r.tokEnd > r.tokStart) return r.tokEnd;
    }
    return Infinity;
  }

  // Follower view: fire markers the speech has reached, then the advance.
  view(v, listening) {
    this.setListening(listening);
    if (this.disposed || this.error || !listening || !this.playing || this.slide == null || this.manualSlide) return;
    if (v.status !== 'tracking' && v.status !== 'paused') return;
    const r = this.range(this.slide);
    if (!r) return;
    const pos = v.pos;
    // Speech behind this slide (the hand advanced early) or more than one
    // slide ahead (a far jump) does not drive the show.
    if (pos < r.tokStart || pos >= this._farLimit(this.slide)) return;
    if (this.startPos == null) this.startPos = pos;
    this.lastPos = pos;
    this.lastStatus = v.status;
    if (this.seekTarget != null) return; // a manual jump is being caught up
    if (this.resync) {
      // back on after a pause: what was passed in the meantime stays as is
      this.resync = false;
      while (this.done < this.marks.length && pos >= this.marks[this.done].tok - this.O.lead) this.done++;
      this.startPos = pos;
      this.onChange();
      return;
    }
    if (this.builds) {
      while (this.done < this.marks.length) {
        const m = this.marks[this.done];
        const reached = pos >= m.tok - this.O.lead;
        if (m.rearm) {
          if (!reached) m.rearm = false; // the speaker went back before it
          break;
        }
        if (!reached) break;
        this.done++;
        if (m.trailing && this.done >= this.marks.length && this.advance && !this.advanced) {
          // the slide's last marker ends its text: it is the turn
          this.advanced = true;
          this.pendingAdvance = { from: this.slide, at: null, handled: false, budget: this._turnBudget() };
          this._queue('advance', m.idx);
        } else {
          this._queue('build', m.idx);
        }
      }
    }
    // the end of this slide's text turns the slide (never past the last
    // one); so does a pause a few words short of it
    const len = r.tokEnd - r.tokStart;
    const near = Math.min(this.O.nearEnd?.[this.doc.lang] ?? 3, Math.floor(len / 4));
    const atEnd = pos >= r.tokEnd - 1 || (v.status === 'paused' && pos >= r.tokEnd - Math.max(1, near));
    if (this.advance && !this.advanced && this.done >= this.marks.length &&
        r.tokEnd < this.doc.tokens.length && len >= 2 &&
        !(this.total != null && this.slide >= this.total) &&
        atEnd && pos > this.startPos) {
      this.advanced = true;
      this.pendingAdvance = { from: this.slide, at: null, handled: false, budget: this._turnBudget() };
      if (pos < r.tokEnd - 1) this.log('advance-near-end', { slide: this.slide, left: r.tokEnd - pos });
      this._queue('advance');
    }
  }

  // ------------------------------------------------------------- manual jump

  // The speaker set the script position by hand (a click on the text). The
  // show catches up: every build marked up to `target` and, when it lies on
  // a later slide, the rest of this slide and the turns in between. A
  // position behind the current slide only moves the text. Returns whether
  // the show will be driven.
  seek(target) {
    if (this.disposed || this.error || !this.listening || !this.playing || this.slide == null) return false;
    const r = this.range(this.slide);
    if (!r || target < r.tokStart) return false;
    this.seekTarget = target;
    this.resync = false;
    this.handTurnAt = null;
    this.log('seek', { slide: this.slide, into: target >= r.tokEnd ? 'later-slide' : 'this-slide' });
    this._seekStep();
    return true;
  }

  _seekStep() {
    const target = this.seekTarget;
    if (target == null || this.slide == null || !this.playing) return;
    const r = this.range(this.slide);
    if (!r || target < r.tokStart) {
      this.seekTarget = null;
      return;
    }
    // the hand chose this place: the slide is no longer the speaker's own
    this.manualSlide = false;
    const last = r.tokEnd >= this.doc.tokens.length || (this.total != null && this.slide >= this.total);
    const beyond = target >= r.tokEnd && !last;
    while (this.done < this.marks.length) {
      const m = this.marks[this.done];
      if (m.trailing || (!beyond && target < m.tok)) break;
      m.rearm = false;
      this.done++;
      if (this.builds) this._queue('build', m.idx, true);
    }
    if (!beyond || !this.advance) {
      // arrived: speech drives the show from here
      this.seekTarget = null;
      this.startPos = this.lastPos = Math.min(target, r.tokEnd);
      this.onChange();
      return;
    }
    if (this.pendingAdvance && this.pendingAdvance.from === this.slide) return; // a turn is on its way
    // the rest of this slide: builds without markers (when the deck says how
    // many), then the turn
    this.done = this.marks.length;
    const unmarked = this.known != null ? Math.max(0, this.known - this.done - this.handBuilds) : 0;
    for (let k = 0; k < unmarked; k++) {
      this.handBuilds++;
      this._queue('build', null, true);
    }
    this.advanced = true;
    this.pendingAdvance = { from: this.slide, at: null, handled: false, budget: this._turnBudget() };
    this._queue('advance', null, true);
  }

  // Extra clicks an advance may need: with the deck's build count known,
  // one per build the script does not mark (and one spare).
  _turnBudget() {
    const unmarked = this.known != null ? Math.max(0, this.known - this.done - this.handBuilds) : 0;
    return Math.max(this.O.maxExtra, unmarked + 1);
  }

  // Periodic: confirm that an advance changed the slide; click again if not.
  tick(listening) {
    this.setListening(listening);
    if (this.disposed || this.error || !this.advance) return;
    const now = this.now();
    // A hand click after the last marker that did not turn the slide showed
    // a build without a marker: the end of the text may still turn it. (At
    // the end of the text the click was the turn itself; a slow watcher must
    // not make us turn again.)
    if (this.handTurnAt != null && now - this.handTurnAt >= this.O.verifyMs && this.playing) {
      this.handTurnAt = null;
      const r = this.slide != null ? this.range(this.slide) : null;
      // (no speech on this slide yet: it was a build too)
      if (!this.pendingAdvance && r && (this.lastPos == null || this.lastPos < r.tokEnd - 1)) this.advanced = false;
    }
    const p = this.pendingAdvance;
    if (!p || p.at == null || !this.playing || p.handled || this.manualSlide) return;
    if (this.slide !== p.from) return;
    if (now - p.at < this.O.verifyMs || this.queue.length || this.sending) return;
    if (!listening || this.extra >= (p.budget ?? this.O.maxExtra)) {
      this.log('advance-gave-up', { slide: p.from, extra: this.extra });
      this.pendingAdvance = null;
      return;
    }
    this.extra++;
    p.at = null;
    this.log('advance-extra-click', { slide: p.from, extra: this.extra });
    this._queue('advance');
  }

  // ------------------------------------------------------------- output

  _queue(kind, idx, fast = false) {
    this.queue.push({ kind, idx, count: idx != null ? 1 : 0, slide: this.slide, generation: this.generation, fast });
    this.onChange();
    this._pump();
  }

  async _pump() {
    if (this.sending) return;
    while (this.queue.length && !this.disposed) {
      if (!this.listening || this.error || !this.playing) { this._cancelQueued(); break; }
      const wait = this.lastSentAt + (this.queue[0].fast ? this.O.catchUpGapMs : this.O.gapMs) - this.now();
      if (wait > 0) {
        this.sending = true;
        await new Promise((res) => setTimeout(res, wait));
        this.sending = false;
        continue;
      }
      const q = this.queue.shift();
      if (q.slide !== this.slide || q.generation !== this.generation) continue;
      if (!(q.kind === 'build' ? this.builds : this.advance)) continue;
      this.sending = true;
      this.inFlight = q;
      this.lastSentAt = this.now();
      if (q.kind === 'advance' && this.pendingAdvance && this.pendingAdvance.from === q.slide) this.pendingAdvance.sent = true;
      this.log(q.kind === 'advance' ? 'auto-advance' : 'auto-build', { slide: q.slide, marker: q.idx });
      try {
        const ok = await this.send('next', { slide: q.slide });
        if (ok === false) throw new Error('Slide application did not accept the click');
      } catch (err) {
        this.log('send-failed', { error: String(err && err.message || err) });
        if (q.generation === this.generation && !this.disposed) {
          this._cancelQueued();
          if (q.count && this.done > 0) this.done--;
          this.pendingAdvance = null;
          this.advanced = false;
          this.seekTarget = null;
          this.error = String(err && err.message || err);
        }
      }
      this.inFlight = null;
      this.sending = false;
      // the check for the slide change starts once Keynote has the click
      const p = this.pendingAdvance;
      if (q.kind === 'advance' && p && p.from === q.slide) p.at = this.now();
      this.onChange();
    }
  }

  // ------------------------------------------------------------- display

  // Marker idx -> 'done' | 'next' | 'todo' for the chips in the script.
  markerState(idx, slideOfMarker) {
    if (this.slide == null || slideOfMarker == null) return 'todo';
    if (slideOfMarker < this.slide) return 'done';
    if (slideOfMarker > this.slide) return 'todo';
    const i = this.marks.findIndex((m) => m.idx === idx);
    if (i < 0) return 'todo';
    // a [click x2] marker is done when both of its clicks are
    let last = i;
    while (last + 1 < this.marks.length && this.marks[last + 1].idx === idx) last++;
    if (last < this.status().done) return 'done';
    return i <= this.done ? 'next' : 'todo';
  }

  status() {
    return {
      slide: this.slide,
      total: this.marks.length,
      done: Math.max(0, Math.min(this.done - this.queue.filter((q) => q.slide === this.slide && q.count).length -
        (this.inFlight?.slide === this.slide && this.inFlight.generation === this.generation ? this.inFlight.count : 0), this.marks.length)),
      pending: this.queue.length + (this.inFlight ? 1 : 0),
      error: this.error,
      manual: this.manualSlide,
      on: this.builds || this.advance,
      playing: this.playing,
    };
  }
}
