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
  verifyMs: 1600,   // wait this long (after the send completed) for the slide to change
  maxExtra: 6,      // extra clicks to finish a slide whose builds outnumber the markers
  blipMs: 1500,     // a show that "stops" and plays again on the same slide this fast never stopped
  farSlides: 60,    // how far to look for the next slide that has text
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
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.O = { ...BUILD_DEFAULTS, ...(opts.options || {}) };
    this.send = opts.send || (async () => {});
    this.range = opts.range || (() => null);
    this.markersOf = opts.markers || (() => []);
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
    const r = n != null ? this.range(n) : null;
    // one entry per click: a "[click x2]" marker is two clicks at one place;
    // a marker at the very end of the slide's text is the slide's turn
    this.marks = [];
    if (n != null) {
      for (const m of this.markersOf(n)) {
        for (let k = 0; k < Math.max(1, m.count || 1); k++) {
          this.marks.push({ idx: m.idx, tok: m.tok, rearm: false, trailing: !!r && m.tok >= r.tokEnd });
        }
      }
    }
    // clicks of this slide already shown (a hand click that came right after
    // our advance landed on this slide)
    this.done = Math.min(carry, this.marks.length);
    this.manualSlide = how === 'back'; // the speaker took this slide over
    this.pendingAdvance = null;
    this.advanced = carry > this.marks.length;
    this.handTurnAt = null;
    this.enteredAt = this.now();
    this.startPos = null;     // first speech position on this slide
    this.lastPos = null;
    this.extra = 0;
    this.resync = false;
    this.stoppedAt = null;
    this.queue = this.queue.filter((q) => q.slide === n);
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
    const back = this.slide != null && n < this.slide;
    this._enter(n, back ? 'back' : 'forward', !back && pend && pend.from === this.slide ? pend.carry || 0 : 0);
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
      this._cancelQueued();
      if (this.done > 0) {
        this.done--;
        // shown again only if the speaker reads up to it again
        this.marks[this.done].rearm = true;
      }
      this.lastManualAt = now;
    } else if (kind === 'prev-slide' || kind === 'next-slide' || kind === 'jump') {
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
          this.pendingAdvance = { from: this.slide, at: null, handled: false };
          this._queue('advance', m.idx);
        } else {
          this._queue('build', m.idx);
        }
      }
    }
    // the end of this slide's text turns the slide (never past the last one)
    if (this.advance && !this.advanced && this.done >= this.marks.length &&
        r.tokEnd < this.doc.tokens.length && r.tokEnd - r.tokStart >= 2 &&
        !(this.total != null && this.slide >= this.total) &&
        pos >= r.tokEnd - 1 && pos > this.startPos) {
      this.advanced = true;
      this.pendingAdvance = { from: this.slide, at: null, handled: false };
      this._queue('advance');
    }
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
      if (!this.pendingAdvance && r && this.lastPos != null && this.lastPos < r.tokEnd - 1) this.advanced = false;
    }
    const p = this.pendingAdvance;
    if (!p || p.at == null || !this.playing || p.handled || this.manualSlide) return;
    if (this.slide !== p.from) return;
    if (now - p.at < this.O.verifyMs || this.queue.length || this.sending) return;
    if (!listening || this.extra >= this.O.maxExtra) {
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

  _queue(kind, idx) {
    this.queue.push({ kind, idx, count: idx != null ? 1 : 0, slide: this.slide, generation: this.generation });
    this.onChange();
    this._pump();
  }

  async _pump() {
    if (this.sending) return;
    while (this.queue.length && !this.disposed) {
      if (!this.listening || this.error || !this.playing) { this._cancelQueued(); break; }
      const wait = this.lastSentAt + this.O.gapMs - this.now();
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
