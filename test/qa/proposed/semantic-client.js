// Browser side of the semantic layer. Watches the follower and, while the
// speaker is off script, asks the server (Jev) what is going on; also asks
// whether freshly skipped passages mattered.

import { textOfPhrases } from '../../../public/lib/script.js';

export class SemanticClient {
  constructor(doc, follower, { onJudgment, onSkipReminder, enabled = true, base = '', now = () => Date.now() } = {}) {
    this.doc = doc;
    this.base = base; // server origin when not running in the page (tests)
    this.now = now;
    this.f = follower;
    this.onJudgment = onJudgment || (() => {});
    this.onSkipReminder = onSkipReminder || (() => {});
    this.enabled = enabled;
    this.inflight = false;
    this.lastQueryAt = 0;
    this.lastQueryText = '';
    this.knownSkipped = new Set();
    this.skipTimer = null;
    this.stats = { queries: 0, ms: 0, errors: 0 };
  }

  // Call after each follower update.
  check(now = this.now()) {
    if (!this.enabled) return;
    const f = this.f;
    // Ask only once enough off-script speech has accumulated to judge.
    const minRun = this.doc.lang === 'zh' ? 8 : 5;
    if (f.status === 'offscript' && f.run >= minRun && !this.inflight && now - this.lastQueryAt >= 1500) {
      const off = f.offScriptSpeech();
      if (off !== this.lastQueryText) this._query(off, now);
    }
    // newly skipped phrases -> importance check (debounced)
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
    const lo = Math.max(0, cur - 8);
    const hi = Math.min(doc.phrases.length, cur + 30);
    for (let i = lo; i < hi; i++) cands.push({ id: `P${i}`, text: doc.phrases[i].text });
    // later paragraph openings, so far jumps can be located too
    for (const para of doc.paras) {
      const first = doc.sents[para.sentStart]?.phStart;
      if (first !== undefined && first >= hi && cands.length < 60) cands.push({ id: `P${first}`, text: doc.phrases[first].text });
    }
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
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.status);
      this.stats.queries++;
      this.stats.ms = Math.round(performance.now() - t0);
      const action = this.f.applySemantic({ ...j, requestPos }, this.now());
      this.onJudgment({ ...j, action, offScript: off });
    } catch (err) {
      this.stats.errors++;
      this.onJudgment({ error: String(err.message || err) });
    } finally {
      this.inflight = false;
    }
  }

  async _checkSkips(phrases) {
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
      // whole sentences touched by the skipped phrases
      const sentIds = [...new Set(g.map((p) => doc.phrases[p].sent))];
      const sentences = sentIds.map((si) => doc.sents[si].text);
      const context = textOfPhrases(doc, g[0] - 3, g[g.length - 1] + 4);
      try {
        const res = await fetch(`${this.base}/api/jev/skipped`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sentences, context, spoken: f.recentSpeech(80), lang: doc.lang }),
        });
        const j = await res.json();
        if (!res.ok || !j.sentences) continue;
        let best = null;
        j.sentences.forEach((r, k) => {
          const si = sentIds[k];
          if ((r.covered ?? 0) >= 0.5) {
            // said in other words: not an omission
            f.coveredSents.add(si);
            for (let p = doc.sents[si].phStart; p < doc.sents[si].phEnd; p++) f.skipped.delete(p);
          } else if ((r.important ?? 0) >= 0.5 && (!best || r.important > best.p)) {
            best = { si, p: r.important, text: doc.sents[si].text };
          }
        });
        if (best) {
          this.onSkipReminder({ phrases: g, sent: best.si, tokStart: doc.sents[best.si].tokStart, text: best.text, p: best.p });
        }
        f._emit('semantic');
      } catch {
        // offline: no reminder
      }
    }
  }
}
