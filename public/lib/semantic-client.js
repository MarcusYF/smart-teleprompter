// Browser side of the semantic layer. Watches the follower and, while the
// speaker is off script, asks the server (Jev) what is going on; also asks
// whether freshly skipped passages mattered.

import { textOfPhrases } from './script.js';

export class SemanticClient {
  constructor(doc, follower, { onJudgment, onSkipReminder, enabled = true, base = '', now = () => Date.now() } = {}) {
    this.doc = doc;
    this.base = base; // server origin when not running in the page (tests)
    this.now = now;
    this.f = follower;
    this.onJudgment = onJudgment || (() => {});
    this.onSkipReminder = onSkipReminder || (() => {});
    this.epoch = 0;
    this.requests = new Set();
    this.disposed = false;
    this.suspended = false;
    this.enabled = enabled;
    this.inflight = false;
    this.lastQueryAt = 0;
    this.lastQueryText = '';
    this.knownSkipped = new Set();
    this.skipTimer = null;
    this.stats = { queries: 0, ms: 0, errors: 0 };
  }

  get enabled() { return this._enabled; }
  set enabled(on) {
    this._enabled = !!on;
    if (!on) this.invalidate();
  }

  invalidate() {
    this.epoch++;
    clearTimeout(this.skipTimer);
    this.pendingSkips = [];
    this.knownSkipped?.clear();
    this.lastQueryText = '';
    this.inflight = false;
    for (const ctrl of this.requests) ctrl.abort();
    this.requests.clear();
  }

  suspend() { this.suspended = true; this.invalidate(); }
  resume() { this.suspended = false; }
  dispose() { this.disposed = true; this.suspend(); }

  _fresh(epoch, revision) {
    return this.enabled && !this.suspended && !this.disposed && this.epoch === epoch && this.f.revision === revision;
  }

  // Call after each follower update.
  check(now = this.now()) {
    if (!this.enabled || this.suspended || this.disposed) return;
    const f = this.f;
    // Ask only once enough off-script speech has accumulated to judge.
    const minRun = this.doc.lang === 'zh' ? 8 : 5;
    const afterSlide = now - (f.slideAt || 0) < 3000; // finishing the previous slide's sentence
    if (f.status === 'offscript' && f.run >= minRun && !afterSlide && !this.inflight && now - this.lastQueryAt >= 1500) {
      const off = f.offScriptSpeech();
      if (off !== this.lastQueryText) this._query(off, now);
    }
    // newly skipped phrases -> importance check (debounced). A phrase that
    // was unmarked since (restart, re-read) is fresh again when re-marked.
    for (const p of [...this.knownSkipped]) if (!f.skipped.has(p)) this.knownSkipped.delete(p);
    const fresh = [...f.skipped].filter((p) => !this.knownSkipped.has(p));
    if (fresh.length) {
      for (const p of fresh) this.knownSkipped.add(p);
      clearTimeout(this.skipTimer);
      const batch = (this.pendingSkips = [...(this.pendingSkips || []), ...fresh]);
      this.skipTimer = setTimeout(() => {
        this.pendingSkips = [];
        this._checkSkips(batch.sort((a, b) => a - b));
      }, 600);
    }
  }

  _payload(off) {
    const doc = this.doc;
    const f = this.f;
    const cur = f.currentPhrase();
    const ph = doc.phrases[cur];
    const cands = [];
    const lo = Math.max(0, cur - 12);
    const hi = Math.min(doc.phrases.length, cur + 30);
    for (let i = lo; i < hi; i++) cands.push({ id: `P${i}`, text: doc.phrases[i].text });
    // paragraph openings outside the window, so far jumps (and far returns)
    // can be located too; later ones first, then the nearest earlier ones
    for (const para of doc.paras) {
      const first = doc.sents[para.sentStart]?.phStart;
      if (first !== undefined && first >= hi && cands.length < 52) cands.push({ id: `P${first}`, text: doc.phrases[first].text });
    }
    const earlier = [];
    for (const para of doc.paras) {
      const first = doc.sents[para.sentStart]?.phStart;
      if (first !== undefined && first < lo) earlier.push({ id: `P${first}`, text: doc.phrases[first].text });
    }
    cands.unshift(...earlier.slice(-Math.max(0, 60 - cands.length)));
    // the padded window split into the words said since leaving the script
    // and the script words read just before them (context for Jev)
    const parts = f.offScriptParts ? f.offScriptParts() : { lead: '', speech: off };
    return {
      lang: doc.lang,
      before: textOfPhrases(doc, cur - 2, cur),
      current: ph ? ph.text : '',
      sentence: ph ? doc.sents[ph.sent].text : '',
      after: textOfPhrases(doc, cur + 1, cur + 4),
      offScript: off,
      speech: parts.speech,
      leadIn: parts.lead,
      curId: `P${cur}`,
      recent: f.recentSpeech(30),
      candidates: cands,
    };
  }

  async _query(off, now) {
    if (!this.enabled || this.suspended || this.disposed) return;
    const epoch = this.epoch, revision = this.f.revision;
    const ctrl = new AbortController();
    this.requests.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), 11000);
    this.inflight = true;
    this.lastQueryAt = now;
    this.lastQueryText = off;
    const requestPos = this.f.pos;
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.base}/api/jev/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._payload(off)),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      if (!this._fresh(epoch, revision)) return;
      this.stats.queries++;
      this.stats.ms = Math.round(performance.now() - t0);
      const action = this.f.applySemantic({ ...j, requestPos }, this.now());
      this.onJudgment({ ...j, action, offScript: off });
    } catch (err) {
      if (!this._fresh(epoch, revision) || err.name === 'AbortError') return;
      this.stats.errors++;
      this.onJudgment({ error: String(err.message || err) });
    } finally {
      clearTimeout(timer);
      this.requests.delete(ctrl);
      if (this.epoch === epoch) this.inflight = false;
    }
  }

  async _checkSkips(phrases) {
    const epoch = this.epoch, revision = this.f.revision;
    if (!this._fresh(epoch, revision)) return;
    phrases = [...new Set(phrases)].filter((p) => this.f.skipped.has(p)).sort((a, b) => a - b);
    // group contiguous phrases into passages
    const groups = [];
    for (const p of phrases) {
      const g = groups[groups.length - 1];
      if (g && p === g[g.length - 1] + 1) g.push(p);
      else groups.push([p]);
    }
    const doc = this.doc;
    const f = this.f;
    for (const g of groups) {
      if (!this._fresh(epoch, revision)) return;
      // the skipped part of each sentence (a sentence may be half read)
      const bySent = new Map();
      for (const p of g) {
        const si = doc.phrases[p].sent;
        if (!bySent.has(si)) bySent.set(si, []);
        bySent.get(si).push(p);
      }
      const sentIds = [...bySent.keys()];
      const parts = sentIds.map((si) => {
        const ps = bySent.get(si);
        return textOfPhrases(doc, ps[0], ps[ps.length - 1] + 1);
      });
      const context = textOfPhrases(doc, g[0] - 3, g[g.length - 1] + 4);
      const ctrl = new AbortController();
      this.requests.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), 11000);
      try {
        const res = await fetch(`${this.base}/api/jev/skipped`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentences: parts, context, spoken: f.recentSpeech(80), lang: doc.lang }),
          signal: ctrl.signal,
        });
        const j = await res.json();
        if (!this._fresh(epoch, revision)) return;
        if (!res.ok || !Array.isArray(j.sentences)) continue;
        let best = null;
        j.sentences.forEach((r, k) => {
          const si = sentIds[k];
          const ps = bySent.get(si);
          if (!ps || !ps.every((p) => f.skipped.has(p))) return;
          if ((r.covered ?? 0) >= 0.5) {
            // said in other words: not an omission
            for (const p of ps) f.skipped.delete(p);
            if (ps.length === doc.sents[si].phEnd - doc.sents[si].phStart) f.coveredSents.add(si);
          } else if ((r.important ?? 0) >= 0.5 && (!best || r.important > best.p)) {
            best = { si, p: r.important, text: parts[k], tokStart: doc.phrases[ps[0]].tokStart };
          }
        });
        if (best) this.onSkipReminder({ phrases: g, sent: best.si, tokStart: best.tokStart, text: best.text, p: best.p });
        f._emit('semantic');
      } catch {
        // offline: no reminder
      } finally {
        clearTimeout(timer);
        this.requests.delete(ctrl);
      }
    }
  }
}
