// Follower: turns tracker output into what the prompter shows.
// Owns the displayed position (with hysteresis), speaking pace, pause and
// off-script detection, skipped-phrase marks, and applies semantic
// judgments (from Jev) and slide changes.

import { Tracker } from './tracker.js';
import { speechTokens } from './lang.js';

const docPara = (doc, tok) => doc.paras[doc.phrases[doc.tokens[tok]?.phrase]?.para];

export const FOLLOW_DEFAULTS = {
  localForward: 30,      // tokens the display may advance without extra evidence
  farMargin: 1.6,        // score margin needed for a far jump
  backMargin: 1.2,       // score margin needed to move back
  offMin: { zh: 6, en: 4 },
  pauseMs: 1400,
  resumeHits: 1.5,       // decayed match count needed to leave off-script
  // QA proto (F1b): re-anchoring after off-script speech somewhere other
  // than where the speaker left needs a streak of consecutive in-order
  // matches (tracker res.streak): scattered shared vocabulary in an ad-lib
  // or a Q&A answer rarely produces more than 2 in a row.
  resumeStreak: { zh: 6, en: 3 }, // within localForward
  farStreak: { zh: 7, en: 5 },    // beyond localForward (plus farMargin)
  offStick: { zh: 7, en: 6 },     // run that starts a sticky off-script episode
  backStreak: { zh: 6, en: 2 },   // streak for a back move inside an off-script episode
  backStreakOn: { zh: 5, en: 1 }, // ... and otherwise: a common zh term (强化学习) inside an
                                  // ad-lib or slip is not a return; en re-reads stay quick
  nearSkip: { zh: 0, en: 1 },     // script tokens a plain resume may skip
  longSkip: { zh: 8, en: 5 },     // unread tokens that make a forward move a "skip"...
  longStreak: { zh: 7, en: 4 },   // ...which, right after non-script words, needs this streak
  afterOffMs: 2500,               // "right after": non-script words this recently
  slideGraceMs: 4000,             // after a slide change, returning needs a longer streak
  gateAll: false,                 // (evaluated, rejected) streak gate on every skip move
  // switches for A/B evaluation of each proposed fix (all on = proposal)
  qa: { retracted: true, moveSeq: true, reread: true, firstMove: true, keepWithdrawn: true, countRule: true, reattribute: true },
  latencySec: 0.35,      // recognizer lag compensated by the highlight lead
  lookaheadSec: 2.6,     // look-ahead band length at the current pace
  defaultRate: { zh: 4.2, en: 2.4 }, // tokens per second before we have data
};

export class Follower {
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.lang = doc.lang;
    this.O = { ...FOLLOW_DEFAULTS, ...opts };
    this.tracker = new Tracker(doc, opts.tracker);
    this.listeners = new Set();
    this.reset(0);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(reason) {
    const v = this.view();
    v.reason = reason;
    for (const fn of this.listeners) fn(v);
  }

  reset(pos = 0) {
    this.revision = (this.revision || 0) + 1;
    this.tracker.reset(pos);
    this.pos = pos;
    this.maxPos = pos;
    this.status = 'idle';
    this.semantic = null;
    this.skipped = new Set();
    this.coveredSents = new Set(); // sentences Jev judged as paraphrased
    this.spokenTok = new Uint8Array(this.doc.tokens.length);
    for (let k = 0; k < pos; k++) this.spokenTok[k] = 1;
    this.recent = [];        // recent committed spoken tokens {n, kind, ..., t, seq}
    this.seq = 0;            // sequence number of the next committed token
    this.moveSeq = -1;       // stream position when the display last moved
    this.semSeq = -1;        // stream position of the last semantic move
    this.progress = [];      // [{t, pos}] for pace
    this.speechTimes = [];   // timestamps of speech activity
    this.lastSpeechAt = 0;
    this.lastMoveAt = 0;
    this.voiceActive = false;
    this.run = 0;
    this.offSince = 0;
    this.lastResult = null;
    this.events = [];
    this.interimText = '';
    this.lastInterimCount = 0;
    this.offEpisode = false; // QA proto (F1a): off script until the display re-anchors
    this.firstAnchor = 0;    // QA proto (F9): where speech first anchored the display
    this.moveLog = [];       // QA proto (F4): [{seq, from, to}] recent display moves
  }

  // ------------------------------------------------------------- inputs

  // kind: 'interim' | 'final'
  onSpeech(kind, text, now = Date.now()) {
    // QA proto (F2b): an interim hypothesis emptied without a final (engine
    // restart, Apple volatile range reset) is kept as if it were final, so
    // the tracker does not fall back behind words the display already used.
    if (kind === 'interim' && this.O.qa.keepWithdrawn && !(text || '').trim() && (this.lastInterimCount || 0) >= 2) {
      this.onSpeech('final', this.interimText, now);
    }
    const res = kind === 'final' ? this.tracker.commit(text) : this.tracker.interim(text);
    // A final that only confirms the words of the last interim is not new
    // speech; it must not wake the display out of a pause.
    const n = res.nTokens ?? 0;
    const confirming = kind === 'final' && n > 0 && n <= (this.lastInterimCount || 0);
    // QA proto (F2): the engine withdrew words ('' or a shorter hypothesis
    // or final). That is not evidence that the speaker went back.
    const retracted = this.O.qa.retracted && n < (this.lastInterimCount || 0);
    this.lastInterimCount = kind === 'final' ? 0 : n;
    if (!confirming) {
      this.lastSpeechAt = now;
      this.speechTimes.push(now);
      if (this.speechTimes.length > 400) this.speechTimes.splice(0, 200);
    }
    if (kind === 'final') {
      this._pushRecent(text, now);
      this.interimText = '';
    } else {
      this.interimText = text;
    }
    this._applyResult(res, now, confirming, retracted);
    this._emit('speech');
    return res;
  }

  // Audio level based voice activity (optional; improves pause detection).
  onVoice(active, now = Date.now()) {
    if (active) this.lastVoiceAt = now;
    if (active !== this.voiceActive) {
      this.voiceActive = active;
    }
  }

  // Listening started: wait for the first words before judging pauses.
  armListening(now = Date.now()) {
    this.status = 'waiting';
    this.lastSpeechAt = now;
    this._emit('listen');
  }

  // Periodic update (pause detection). Returns true if the view changed.
  tick(now = Date.now()) {
    const quiet = now - this.lastSpeechAt > this.O.pauseMs && !(this.voiceActive && now - (this.lastVoiceAt || 0) < 400);
    if (this.status !== 'idle' && this.status !== 'waiting' && quiet && this.status !== 'paused') {
      this.status = 'paused';
      this._emit('pause');
      return true;
    }
    return false;
  }

  _pushRecent(text, now) {
    for (const t of speechTokens(text, this.lang)) this.recent.push({ ...t, t: now, seq: this.seq++ });
    if (this.recent.length > 160) this.recent.splice(0, this.recent.length - 160);
  }

  // Committed + interim spoken tokens, each with a stream sequence number.
  _stream() {
    const out = this.recent.slice();
    speechTokens(this.interimText, this.lang).forEach((t, i) => out.push({ ...t, seq: this.seq + i }));
    return out;
  }

  // Spoken tokens for context: committed recent + current interim.
  recentSpeech(maxTokens = 40) {
    const toks = [...this.recent.map((t) => t.n), ...speechTokens(this.interimText, this.lang).map((t) => t.n)];
    const sep = this.lang === 'zh' ? '' : ' ';
    return toks.slice(-maxTokens).join(sep);
  }

  // What was said since the speaker left the script, with a minimum window
  // so a judgment never sees only a fragment (paraphrases re-match a few
  // words and reset the run).
  offScriptSpeech() {
    return this.offScriptParts().text;
  }

  // The same window split into `lead` (script words read just before leaving
  // the script, context only) and `speech` (the words said since). Never
  // reaches back past the last semantic move: that speech is decided.
  offScriptParts() {
    const toks = this._stream().filter((t) => t.seq > this.semSeq).map((t) => t.n);
    const sep = this.lang === 'zh' ? '' : ' ';
    const minWin = this.lang === 'zh' ? 14 : 9;
    const n = Math.min(toks.length, 48, Math.max(this.run, minWin));
    const win = toks.slice(toks.length - n);
    const k = Math.min(Math.max(this.run, 0), n);
    return { text: win.join(sep), lead: win.slice(0, n - k).join(sep), speech: win.slice(n - k).join(sep) };
  }

  _streamEnd() {
    return this.seq + speechTokens(this.interimText, this.lang).length - 1;
  }

  _applyResult(res, now, confirming = false, retracted = false) {
    this.lastResult = res;
    if (res.run >= 2) this.lastOffAt = now; // the speaker just said words that are not in the script
    const O = this.O;
    const d = this.pos;
    let moved = false;
    // Coming back from off-script speech needs two recent matches, so a
    // single coincidental word does not move the highlight.
    // QA proto (F1a): the episode lasts until the display re-anchors; a
    // pause in between (status 'paused') does not end it.
    const off = this.offEpisode;
    const N = this.doc.tokens.length;
    const settled = !off || res.hits >= O.resumeHits || (res.pos === N && res.run === 0 && res.pos - d <= 2);
    const streak = res.streak ?? 99;
    if (res.pos > d && res.run <= 2 && settled) {
      const dist = res.pos - d;
      // resuming where the speaker left needs only `settled`; anywhere else
      // needs a streak of in-order matches (en 3 / zh 6; far: en 5 / zh 7)
      const skipped = dist - streak;
      let need = dist > O.localForward ? O.farStreak?.[this.lang] ?? 5 : O.resumeStreak?.[this.lang] ?? 3;
      // Skipping over unread text right after non-script words needs more
      // in-order evidence, even before an off-script episode starts: "by the
      // way, the reward model is..." must not jump to the next "The reward
      // model..." sentence. Clean skip-ahead reading stays ungated.
      const afterOff = now - (this.lastOffAt || -1e9) < O.afterOffMs;
      const gated = afterOff && skipped >= (O.longSkip?.[this.lang] ?? 5);
      if (gated) need = Math.max(need, O.longStreak?.[this.lang] ?? 4);
      const strongEnough = (!off && !O.gateAll && !gated) || skipped <= (O.nearSkip?.[this.lang] ?? 1) || streak >= need;
      if (strongEnough && (dist <= O.localForward || res.margin >= O.farMargin)) {
        this._moveTo(res.pos, now, dist > O.localForward ? 'jump' : 'advance');
        moved = true;
      }
    } else if (res.pos < d && settled && !retracted &&
        streak >= (now - (this.slideAt || 0) < O.slideGraceMs ? (this.lang === 'zh' ? 7 : 4)
          : off ? O.backStreak?.[this.lang] ?? 3 : O.backStreakOn?.[this.lang] ?? 3)) {
      const dist = d - res.pos;
      if (dist >= 2 && res.margin >= O.backMargin && res.run === 0) {
        this._moveTo(res.pos, now, 'back');
        moved = true;
      }
    }
    this.run = res.run;
    const offMin = O.offMin[this.lang] || 5;
    if (res.run >= offMin && !moved) {
      if (this.status !== 'offscript') {
        this.status = 'offscript';
        this.offSince = now;
      }
      if (res.run >= (O.offStick?.[this.lang] ?? offMin)) this.offEpisode = true;
    } else if (this.offEpisode && !moved) {
      // QA proto (F1a): a match that did not move the display (a stray
      // content word) does not end the off-script episode.
      if (!(confirming && this.status === 'paused')) this.status = 'offscript';
    } else {
      // Back on the script (a word matched): the off-script episode is over.
      if (res.run === 0 && this.semantic) {
        this.lastSemantic = this.semantic;
        this.semantic = null;
      }
      if (!(confirming && this.status === 'paused' && !moved)) this.status = 'tracking';
    }
  }

  _moveTo(pos, now, how) {
    const from = this.pos;
    // QA proto (F9): the first move of a session (the speaker started
    // somewhere other than the top) does not mark the lines above skipped.
    const first = this.O.qa.firstMove && !this.events.length && from === 0;
    if (first) {
      // the phrase where the speaker began (the current streak started there)
      const began = Math.max(0, pos - (this.lastResult?.streak ?? 0) - 1);
      const ph = this.doc.tokens[began] ? this.doc.phrases[this.doc.tokens[began].phrase] : null;
      this.firstAnchor = ph ? ph.tokStart : 0;
    }
    if (how === 'jump' && this.O.qa.reattribute) this._reattribute(from, pos);
    else if (how === 'advance' || how === 'jump') this._markSkips(from, pos, !first);
    if (pos < from) {
      // going back: phrases re-entered are no longer "skipped"
      // QA proto (F3): neither are skipped phrases the speaker has just
      // re-read on the way back (the back move lands after them).
      // (the most recent words: a small forward move in between may
      // have reset moveSeq)
      const spoken = this.O.qa.reread ? this._stream().slice(-24) : [];
      if (spoken.length) this._cover(Math.max(0, pos - spoken.length - 4), pos, spoken);
      for (const ph of [...this.skipped]) {
        const p = this.doc.phrases[ph];
        if (p && (p.tokEnd > pos || this._coverage(p) >= 0.34)) this.skipped.delete(ph);
      }
    }
    this.offEpisode = false;
    this.pendingJump = null;
    this.pos = pos;
    if (pos > this.maxPos) this.maxPos = pos;
    this.lastMoveAt = now;
    // QA proto (F5): the trailing unmatched words (res.run) were not
    // consumed by this move; they may still cover script tokens later
    // (an interim rewrite can turn "To in" into "To with").
    const run = this.O.qa.moveSeq ? Math.min(this.lastResult ? this.lastResult.run : 0, 2) : 0;
    this.moveSeq = this.seq + speechTokens(this.interimText, this.lang).length - 1 - run;
    this.moveLog.push({ seq: this.moveSeq, from, to: pos, streak: this.lastResult ? this.lastResult.streak ?? 0 : 0 });
    if (this.moveLog.length > 40) this.moveLog.shift();
    this.progress.push({ t: now, pos });
    if (this.progress.length > 300) this.progress.splice(0, 150);
    this.events.push({ t: now, how, from, to: pos });
    if (this.events.length > 100) this.events.shift();
  }

  // Phrases passed over without being spoken are marked as skipped. Script
  // tokens covered by recent speech are remembered in spokenTok, so a
  // phrase skipped across two display moves is still recognized.
  _markSkips(from, to, mark = true) {
    const span = to - from;
    if (span <= 0) return;
    const flags = this.spokenTok;
    if (span <= 3) {
      for (let k = from; k < to; k++) flags[k] = 1;
    } else {
      // Only words spoken since the display reached `from` can cover [from, to).
      const since = this.moveSeq;
      let spoken = this._stream().filter((t) => t.seq > since);
      if (!spoken.length) spoken = this._stream().slice(-Math.min(span, 8));
      spoken = spoken.slice(-(span + 20));
      // QA proto (F6): m recent words can only cover the script just before
      // `to`; aligning them against the whole span of a far jump cost
      // O(span x m) tokenSim calls (~70 ms after a long Q&A).
      this._cover(Math.max(from, to - (spoken.length + 24)), to, spoken);
    }
    if (!mark) return;
    const doc = this.doc;
    const firstPh = doc.tokens[from] ? doc.tokens[from].phrase : 0;
    const lastPh = doc.tokens[to - 1] ? doc.tokens[to - 1].phrase : firstPh;
    for (let ph = firstPh; ph <= lastPh; ph++) {
      const p = doc.phrases[ph];
      if (p.tokEnd > to || p.tokEnd - p.tokStart < 2) continue; // not finished yet
      if (this.coveredSents.has(p.sent)) {
        this.skipped.delete(ph); // said in other words
        continue;
      }
      // phrases above the first anchor of the session are not "skipped"
      // (the speaker chose to start there)
      if (p.tokEnd <= this.firstAnchor) continue;
      if (this._isSkipped(p)) this.skipped.add(ph);
      else if (this._coverage(p) >= 0.34) this.skipped.delete(ph); // read now, even if skipped before
    }
  }

  // QA proto (F5b): weighted coverage alone marks "To deal with this," as
  // skipped when only "deal" was left out. A phrase counts as skipped only
  // if its content is mostly missing AND at least two of its tokens (and at
  // least half of them) were not said.
  _isSkipped(p) {
    if (this._coverage(p) >= 0.34) return false;
    if (!this.O.qa.countRule) return true;
    const n = p.tokEnd - p.tokStart;
    let said = 0;
    for (let k = p.tokStart; k < p.tokEnd; k++) said += this.spokenTok[k];
    return n - said >= 2 && said / n < 0.5;
  }

  // QA proto (F4): a far jump re-explains the words of the last few display
  // moves. With parallel items ("The second / third lesson is about ..."),
  // the opening words of item 3 first advance the display into item 2; when
  // the jump to item 3 follows, those words belong to item 3, and item 2 is
  // the one that was skipped.
  _reattribute(from, to) {
    // re-explain everything since the last move made while reading with
    // confidence (a streak of en 4 / zh 6 in-order matches), at most 40 words
    const end = this.seq + speechTokens(this.interimText, this.lang).length - 1;
    const sure = this.lang === 'zh' ? 6 : 4;
    let anchor = null;
    for (let i = this.moveLog.length - 1; i >= 0; i--) {
      const m = this.moveLog[i];
      if (m.seq < end - 40) break;
      if (m.streak >= sure && m.to <= from) {
        anchor = m;
        break;
      }
    }
    const a = anchor ? anchor.to : from;
    const since = anchor ? anchor.seq : this.moveSeq;
    let spoken = this._stream().filter((t) => t.seq > since).slice(-40);
    if (a < from) {
      for (let k = a; k < from; k++) this.spokenTok[k] = 0;
      for (const ph of [...this.skipped]) if (this.doc.phrases[ph].tokEnd > a) this.skipped.delete(ph);
    }
    let prefixStart = a;
    const anchorPara = docPara(this.doc, a);
    if (anchorPara && anchorPara.tokEnd <= from && anchorPara.tokEnd > a) {
      // Finish the paragraph we confidently heard before explaining a far
      // jump. Otherwise a repeated refrain in an omitted paragraph can steal
      // the preceding paragraph's words ("before we optimize" in a list).
      const prefix = [];
      for (let k = a; k < anchorPara.tokEnd; k++) prefix.push(k);
      const used = this._coverIdx(prefix, spoken.slice(0, prefix.length + 2));
      spoken = spoken.filter((_, i) => !used.has(i));
      prefixStart = anchorPara.tokEnd;
    }
    const lo = Math.max(from, to - (spoken.length + 24));
    // align over [a, from) ++ [lo, to): the words land where they fit best
    const idx = [];
    for (let k = prefixStart; k < from; k++) idx.push(k);
    for (let k = lo; k < to; k++) idx.push(k);
    this._coverIdx(idx, spoken);
    const doc = this.doc;
    const firstPh = doc.tokens[a] ? doc.tokens[a].phrase : 0;
    const lastPh = doc.tokens[to - 1] ? doc.tokens[to - 1].phrase : firstPh;
    for (let ph = firstPh; ph <= lastPh; ph++) {
      const p = doc.phrases[ph];
      if (p.tokEnd > to || p.tokEnd - p.tokStart < 2) continue;
      if (this.coveredSents.has(p.sent) || p.tokEnd <= this.firstAnchor) continue;
      if (this._isSkipped(p)) this.skipped.add(ph);
    }
  }

  _cover(lo, hi, spoken) {
    const idx = [];
    for (let k = lo; k < hi; k++) idx.push(k);
    this._coverIdx(idx, spoken);
  }

  // Align spoken tokens (in order) to script tokens [lo, hi) and flag the
  // covered ones in spokenTok. Similarities come from the tracker's
  // per-word cache (one row per spoken word, indexed by vocabulary id).
  _coverIdx(idx, spoken) {
    const doc = this.doc;
    const n = idx.length;
    const m = spoken.length;
    const used = new Set();
    if (n <= 0 || !m) return used;
    const flags = this.spokenTok;
    const rows = spoken.map((t) => this.tracker._sims(t));
    const vid = new Int32Array(n);
    const stop = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      vid[i] = doc.tokens[idx[i]].vid;
      stop[i] = doc.tokens[idx[i]].stop ? 1 : 0;
    }
    // a script token counts as spoken on a clear match, or a looser
    // match of a content word; stray function words do not count
    const ok = (i, j) => {
      const v = rows[j][vid[i]];
      return v >= 0.8 || (v >= 0.5 && !stop[i]);
    };
    const W = m + 1;
    const dp = new Uint16Array((n + 1) * W);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i * W + j] = ok(i - 1, j - 1) ? dp[(i - 1) * W + j - 1] + 1 : Math.max(dp[(i - 1) * W + j], dp[i * W + j - 1]);
      }
    }
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      if (ok(i - 1, j - 1) && dp[i * W + j] === dp[(i - 1) * W + j - 1] + 1) {
        flags[idx[i - 1]] = 1;
        used.add(j - 1);
        i--;
        j--;
      } else if (dp[(i - 1) * W + j] >= dp[i * W + j - 1]) i--;
      else j--;
    }
    return used;
  }

  // informativeness-weighted coverage of a phrase
  _coverage(p) {
    const doc = this.doc;
    let hit = 0;
    let all = 0;
    for (let k = p.tokStart; k < p.tokEnd; k++) {
      const w = doc.tokens[k].w;
      all += w;
      if (this.spokenTok[k]) hit += w;
    }
    return all ? hit / all : 1;
  }

  // ------------------------------------------------------------- control

  // Manual jump (click on a phrase, keyboard nudges).
  jumpTo(tok, now = Date.now()) {
    this.revision++;
    const pos = Math.max(0, Math.min(this.doc.tokens.length, tok));
    this.tracker.setPosition(pos);
    for (const ph of [...this.skipped]) {
      const p = this.doc.phrases[ph];
      if (p && p.tokEnd > pos) this.skipped.delete(ph);
    }
    // everything from here on counts as unread again (rehearsal, restart)
    this.spokenTok.fill(0, pos);
    for (const si of [...this.coveredSents]) if (this.doc.sents[si].tokEnd > pos) this.coveredSents.delete(si);
    this.maxPos = pos;
    this.moveSeq = this._streamEnd();
    this.semSeq = this._streamEnd();
    this.pos = pos;
    this.lastMoveAt = now;
    this.semantic = null;
    this.offEpisode = false;
    this.status = this.status === 'idle' ? 'idle' : 'tracking';
    this._emit('manual');
  }

  // A slide change: bring the slide's section into play.
  slideChanged(tokStart, tokEnd, now = Date.now()) {
    this.revision++;
    if (this.pos >= tokStart && this.pos < tokEnd) return false;
    this.tracker.setPosition(tokStart);
    this.slideAt = now;
    this.pendingJump = null;
    this.pos = tokStart;
    this.moveSeq = this._streamEnd();
    this.semSeq = this._streamEnd();
    this.lastMoveAt = now;
    this.semantic = null;
    this.offEpisode = false;
    this.events.push({ t: now, how: 'slide', to: tokStart });
    this._emit('slide');
    return true;
  }

  // Semantic judgment from the server (Jev). j = {relation, where, onScript,
  // covered, requestPos, requestRun}. Returns the action taken.
  applySemantic(j, now = Date.now()) {
    const doc = this.doc;
    // Freshness: if we are back on script, or moved since, the judgment is stale.
    // QA proto (F1c): a stray match inside an off-script episode resets
    // run to 0 without ending the episode; the judgment is still fresh.
    if ((this.run === 0 && !this.offEpisode) || Math.abs(this.pos - j.requestPos) > 3) return 'stale';
    const rel = j.relation || {};
    const label = rel.choice;
    this.semantic = { label, conf: rel.confidence ?? 0, at: now, where: j.where?.choice };
    let action = 'hold';
    const whereIdx = j.where && /^P\d+$/.test(j.where.choice || '') ? parseInt(j.where.choice.slice(1), 10) : -1;
    const whereP = j.where && j.where.probabilities ? j.where.probabilities[j.where.choice] || 0 : 0;
    const curPh = this.currentPhrase();
    // Paraphrasing or noisy reading of the sentence we are in: stay put
    // rather than stepping back to the sentence start.
    const backInSentence = whereIdx >= 0 && whereIdx < curPh && doc.phrases[whereIdx] &&
      ((doc.phrases[whereIdx].sent === doc.phrases[curPh].sent && (label === 'paraphrase' || label === 'reading_current')) ||
       // returning into a sentence already judged as said in other words
       (label === 'went_back' && this.coveredSents.has(doc.phrases[whereIdx].sent)));
    // Guards against the wrong moves seen in QA: the label and the line must
    // agree on the direction; the phrase just before the current one is what
    // the speaker had just read, so returning there is left to the lexical
    // tracker; and a jump needs a reasonably certain relation (a slip that
    // contains words from elsewhere starts out at p ~0.3-0.6).
    const relP = rel.probabilities ? rel.probabilities[label] ?? 0 : 0;
    const wrongWay = whereIdx >= 0 && ((label === 'went_back' && whereIdx > curPh) || (label === 'jumped_ahead' && whereIdx < curPh));
    const justRead = whereIdx >= 0 && whereIdx === curPh - 1;
    const eligible = (label === 'jumped_ahead' || label === 'went_back' || label === 'paraphrase' || label === 'reading_current') &&
        whereIdx >= 0 && whereP >= 0.4 && (j.onScript ?? 1) >= 0.5 && whereIdx !== curPh && !backInSentence &&
        !wrongWay && !justRead && relP >= 0.6;
    // A jump to another part of the script is a big move: unless Jev is
    // very sure, wait for a second judgment that agrees (an ad-lib that
    // opens with upcoming script words looks like a jump at first).
    let confirmed = true;
    if (eligible && (label === 'jumped_ahead' || label === 'went_back') && relP < 0.9) {
      const pj = this.pendingJump;
      confirmed = !!(pj && pj.label === label && Math.abs(pj.where - whereIdx) <= 2 && now - pj.at < 6000);
      this.pendingJump = confirmed ? null : { label, where: whereIdx, at: now };
    }
    if (eligible && confirmed) {
      const ph = doc.phrases[whereIdx];
      if (ph) {
        // Re-anchor at the phrase; let the lexical tracker refine inside it.
        this.tracker.setPosition(ph.tokStart);
        this.tracker.boost(ph.tokStart, ph.tokEnd, 2.5);
        if (ph.tokStart > this.pos) this._markSkips(this.pos, ph.tokStart);
        const from = this.pos;
        this.pos = ph.tokStart;
        this.lastMoveAt = now;
        this.semSeq = this._streamEnd();
        this.moveSeq = this.semSeq;
        this.offEpisode = false;
        this.events.push({ t: now, how: 'semantic', from, to: ph.tokStart, label });
        action = whereIdx > curPh ? 'jump-forward' : 'jump-back';
      }
    } else if (label === 'paraphrase' && (j.covered ?? 0) >= 0.6 && relP >= 0.6 && (j.onScript ?? 1) >= 0.5 &&
        (whereIdx < 0 || doc.phrases[whereIdx]?.sent === doc.phrases[curPh].sent)) {
      const sent = doc.sents[doc.phrases[curPh].sent];
      this.coveredSents.add(sent.idx);
      const next = doc.sents[sent.idx + 1];
      if (next) {
        this.tracker.setPosition(next.tokStart);
        const from = this.pos;
        this.pos = next.tokStart;
        this.lastMoveAt = now;
        this.semSeq = this._streamEnd();
        this.moveSeq = this.semSeq;
        this.offEpisode = false;
        this.events.push({ t: now, how: 'semantic', from, to: next.tokStart, label });
        action = 'advance-sentence';
      }
    }
    if (action === 'hold' && this.pendingJump && this.pendingJump.at === now) action = 'pending';
    this.semantic.action = action;
    this._emit('semantic');
    return action;
  }

  // ------------------------------------------------------------- outputs

  // Speaking pace in tokens per second: recognized words over the last
  // ~15 s of active speech (pauses excluded). Script jumps and ad-libs do not
  // distort it the way script progress would.
  rate(now = Date.now()) {
    const win = 15000;
    const def = this.O.defaultRate[this.lang] || 3;
    const times = this.speechTimes.filter((t) => now - t <= win);
    let active = 0;
    for (let i = 1; i < times.length; i++) active += Math.min(times[i] - times[i - 1], 1000);
    let n = 0;
    for (const t of this.recent) if (now - t.t <= win) n++;
    n += speechTokens(this.interimText, this.lang).length;
    if (active < 2500 || n < 4) return this.paceEma || def;
    const r = Math.max(def * 0.4, Math.min(def * 2.2, n / (active / 1000)));
    // smooth so the look-ahead band and time estimate do not jump around
    this.paceEma = this.paceEma ? this.paceEma + (r - this.paceEma) * 0.15 : r;
    return this.paceEma;
  }

  currentPhrase(now = Date.now()) {
    const doc = this.doc;
    if (!doc.tokens.length) return 0;
    let hp = this.pos;
    if (this.status === 'tracking' && now - this.lastSpeechAt < 800) {
      hp += Math.round(this.rate(now) * this.O.latencySec);
    }
    hp = Math.min(hp, doc.tokens.length - 1);
    if (hp < 0) hp = 0;
    // If the current phrase is fully read, the next phrase is current.
    return doc.tokens[hp].phrase;
  }

  view(now = Date.now()) {
    const doc = this.doc;
    const cur = this.currentPhrase(now);
    const rate = this.rate(now);
    const aheadTok = Math.min(doc.tokens.length, (doc.phrases[cur]?.tokEnd ?? 0) + Math.round(rate * this.O.lookaheadSec));
    let aheadPh = aheadTok >= doc.tokens.length ? doc.phrases.length - 1 : doc.tokens[Math.max(0, aheadTok - 1)]?.phrase ?? cur;
    if (aheadPh < cur) aheadPh = cur;
    return {
      pos: this.pos,
      phrase: cur,
      aheadPhrase: aheadPh,
      status: this.status,
      semantic: this.semantic,
      run: this.run,
      rate,
      skipped: this.skipped,
      maxPos: this.maxPos,
      progress: doc.tokens.length ? this.pos / doc.tokens.length : 0,
      margin: this.lastResult ? this.lastResult.margin : 0,
    };
  }
}
