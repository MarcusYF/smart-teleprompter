// Slide-show integration. Watches Keynote or PowerPoint through Apple
// Events (osascript), imports Keynote slide titles and presenter notes,
// sends next/previous, and accepts slide state from any other tool over
// HTTP (POST /api/slides/state).

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readKeynoteBuilds } from './keynote-file.mjs';
import { placeClicks } from '../public/lib/autoclick.js';
import { markedClicks } from '../public/lib/script.js';

// A deck's identity: its file. Keynote's document id lasts one Keynote
// session only, so a script tied to it lost its deck when Keynote restarted.
// An unsaved document falls back to that id ("session:").
export const DECK_KEY_JS = String.raw`
function deckKey(d) {
  try { const f = d.file(); if (f) return 'file:' + f.toString(); } catch (e) {}
  try { return 'session:' + String(d.id()); } catch (e) { return null; }
}
`;

const KEYNOTE_WATCH = String.raw`
ObjC.import('Foundation');
${DECK_KEY_JS}
function out(o) {
  const s = $(JSON.stringify(o) + "\n");
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
}
// Keynote ships under two bundle ids (Keynote and Keynote Creator Studio).
function keynote() {
  for (const id of ['com.apple.Keynote', 'com.apple.iWork.Keynote']) {
    const a = Application(id);
    if (a.running()) return a;
  }
  return null;
}
let last = '';
while (true) {
  const st = { app: 'keynote', running: false };
  try {
    const kn = keynote();
    st.running = !!kn;
    if (kn) {
      st.playing = kn.playing();
      if (kn.documents.length > 0) {
        const doc = kn.documents[0];
        st.doc = doc.name();
        st.docId = deckKey(doc);
        try { st.sessionId = String(doc.id()); } catch (e) {}
        st.total = doc.slides.length;
        try { st.slide = doc.currentSlide().slideNumber(); } catch (e) {}
      }
    }
  } catch (e) { st.error = String(e).slice(0, 200); }
  const s = JSON.stringify(st);
  if (s !== last) { out(st); last = s; }
  delay(0.25);
}
`;

const KEYNOTE_IMPORT = String.raw`
${DECK_KEY_JS}
(() => {
  let kn = null;
  for (const id of ['com.apple.Keynote', 'com.apple.iWork.Keynote']) {
    const a = Application(id);
    if (a.running()) { kn = a; break; }
  }
  if (!kn || kn.documents.length === 0) return JSON.stringify({ error: 'Keynote has no open presentation.' });
  const doc = kn.documents[0];
  const slides = doc.slides().map((s) => {
    let title = '';
    let body = '';
    try { title = String(s.defaultTitleItem().objectText() || ''); } catch (e) {}
    try { body = String(s.defaultBodyItem().objectText() || ''); } catch (e) {}
    if (!body) {
      try { body = s.textItems().map((t) => String(t.objectText() || '')).filter((t) => t && t !== title).join('\n'); } catch (e) {}
    }
    let notes = '';
    try { notes = String(s.presenterNotes() || ''); } catch (e) {}
    let skipped = false;
    try { skipped = s.skipped(); } catch (e) {}
    return { n: s.slideNumber(), title, body, notes, skipped };
  });
  const docId = deckKey(doc);
  // the saved file holds the builds (AppleScript cannot see them)
  let file = null;
  try { const f = doc.file(); if (f) file = f.toString(); } catch (e) {}
  let modified = false;
  try { modified = !!doc.modified(); } catch (e) {}
  return JSON.stringify({ doc: doc.name(), docId, file, modified, slides });
})()
`;

// The front document's file, for its build counts.
const KEYNOTE_FILE = String.raw`
${DECK_KEY_JS}
(() => {
  for (const id of ['com.apple.Keynote', 'com.apple.iWork.Keynote']) {
    const a = Application(id);
    if (!a.running() || a.documents.length === 0) continue;
    const doc = a.documents[0];
    const docId = deckKey(doc);
    let file = null;
    try { const f = doc.file(); if (f) file = f.toString(); } catch (e) {}
    let modified = false;
    try { modified = !!doc.modified(); } catch (e) {}
    return JSON.stringify({ doc: doc.name(), docId, file, modified, total: doc.slides.length });
  }
  return JSON.stringify({ error: 'Keynote has no open presentation.' });
})()
`;

const PPT_POLL = `
if application "Microsoft PowerPoint" is running then
  tell application "Microsoft PowerPoint"
    try
      if (count of slide show windows) > 0 then
        set n to slide index of slide of slide show view of slide show window 1
        set total to count of slides of active presentation
        return "playing|" & n & "|" & total
      end if
      set n to slide index of slide of view of active window
      set total to count of slides of active presentation
      return "editing|" & n & "|" & total
    on error errMsg
      return "error|" & errMsg
    end try
  end tell
else
  return "notrunning"
end if
`;

function osa(args, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const p = execFile('/usr/bin/osascript', args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 400)));
      else resolve(stdout.trim());
    });
    if (input) p.stdin.end(input);
  });
}

export class Slides extends EventEmitter {
  constructor() {
    super();
    this.source = 'none';
    this.state = { source: 'none', slide: null, total: null, playing: false };
    this.proc = null;
    this.pollTimer = null;
  }

  _update(patch) {
    const next = { ...this.state, ...patch, source: this.source, at: Date.now() };
    const changed = next.slide !== this.state.slide || next.playing !== this.state.playing ||
      next.total !== this.state.total || next.error !== this.state.error || next.running !== this.state.running ||
      next.doc !== this.state.doc || next.docId !== this.state.docId || next.sessionId !== this.state.sessionId ||
      next.title !== this.state.title || next.source !== this.state.source;
    this.state = next;
    if (changed) this.emit('state', this.state);
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = null;
  }

  watch(source) {
    this.stop();
    this.source = source;
    this.state = { source, slide: null, total: null, playing: false };
    if (source === 'keynote') this._watchKeynote();
    else if (source === 'powerpoint') this._watchPowerPoint();
    this.emit('state', this.state);
    return this.state;
  }

  _watchKeynote() {
    const p = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', KEYNOTE_WATCH], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    // Recycle the JXA loop every 15 minutes so a long talk never depends on
    // one osascript process; the replacement starts before the old one ends.
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = setTimeout(() => {
      if (this.source !== 'keynote' || this.proc !== p) return;
      this._watchKeynote();
      p.kill();
    }, 15 * 60 * 1000);
    this.recycleTimer.unref?.();
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      if (this.proc !== p) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const st = JSON.parse(line);
          this._update({ slide: st.slide ?? null, total: st.total ?? null, playing: !!st.playing, running: st.running, doc: st.doc, docId: st.docId, sessionId: st.sessionId ?? null, error: st.error || null });
        } catch {
          // ignore partial lines
        }
      }
    });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { if (this.proc === p) this._update({ error: e.message }); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this._update({ error: `Keynote watcher stopped (${code}): ${err.trim().slice(0, 200)}` });
      // restart after a moment unless stopped (e.g. Automation permission denied)
      setTimeout(() => { if (this.source === 'keynote' && !this.proc) this._watchKeynote(); }, 3000);
    });
  }

  _watchPowerPoint() {
    const generation = this.source;
    const poll = async () => {
      try {
        const out = await osa(['-e', PPT_POLL], null, 4000);
        if (this.source !== generation) return;
        const [mode, n, total] = out.split('|');
        if (mode === 'notrunning') this._update({ running: false, playing: false, error: null });
        else if (mode === 'error') this._update({ running: true, error: n });
        else this._update({ running: true, playing: mode === 'playing', slide: parseInt(n, 10), total: parseInt(total, 10), error: null });
      } catch (e) {
        this._update({ error: e.message });
      }
    };
    poll();
    this.pollTimer = setInterval(poll, 500);
  }

  // External tools (browser decks, clickers, scripts) push state here.
  external(patch) {
    if (this.source !== 'external' && this.source !== 'none') return this.state;
    this.source = 'external';
    const total = Number.isFinite(+patch.total) && +patch.total > 0 ? Math.round(+patch.total) : this.state.total;
    let slide = Number.isFinite(+patch.slide) ? Math.round(+patch.slide) : this.state.slide;
    if (slide != null) slide = Math.max(1, total ? Math.min(total, slide) : slide);
    this._update({ slide, total, playing: patch.playing ?? true, title: patch.title, running: true });
    return this.state;
  }

  async importKeynote() {
    const out = await osa(['-l', 'JavaScript', '-e', KEYNOTE_IMPORT], null, 60000);
    const data = JSON.parse(out);
    if (!data.error) data.builds = this._readBuilds(data.file, data.slides.length);
    delete data.file;
    return data;
  }

  // Clicks per slide of the front Keynote document (from its saved file):
  // {doc, docId, unsaved, slides: [{n, clicks}] | null}.
  async keynoteBuilds() {
    const info = JSON.parse(await osa(['-l', 'JavaScript', '-e', KEYNOTE_FILE], null, 8000));
    if (info.error) return info;
    const builds = this._readBuilds(info.file, info.total);
    return { doc: info.doc, docId: info.docId, unsaved: !!info.modified, slides: builds ? builds.map((b) => ({ n: b.n, clicks: b.clicks })) : null };
  }

  // Builds read from the file, cached until it is saved again; null if the
  // file is unreadable or does not have the open document's slides.
  _readBuilds(file, total) {
    if (!file) return null;
    let key;
    try {
      // a package document changes inside, not its folder
      const inner = [join(file, 'Index.zip'), join(file, 'Index', 'Document.iwa')].find((p) => existsSync(p));
      const st = statSync(statSync(file).isDirectory() && inner ? inner : file);
      key = `${file}|${st.mtimeMs}|${st.size}`;
    } catch {
      return null;
    }
    if (this.buildsCache?.key !== key) this.buildsCache = { key, builds: readKeynoteBuilds(file) };
    const b = this.buildsCache.builds;
    return b && b.length === total ? b : null;
  }

  async control(action, expected = null) {
    if (!['next', 'prev'].includes(action)) throw Object.assign(new Error('Invalid slide action'), { status: 400 });
    if (expected && (expected.source !== this.source || expected.slide !== this.state.slide ||
        expected.doc !== this.state.doc || expected.docId !== this.state.docId || !this.state.playing || this.state.error)) {
      throw Object.assign(new Error('Presentation changed or its state is unavailable'), { status: 409 });
    }
    if (this.source === 'keynote') {
      const cmd = action === 'next' ? 'showNext' : 'showPrevious';
      // Recheck inside the same Apple Event task that sends the click.
      // (the current slide is briefly null while Keynote starts recording)
      const guard = expected ? `const d = a.documents[0]; const c = d ? d.currentSlide() : null; if (!d || !c || d.name() !== ${JSON.stringify(expected.doc)} || ${expected.docId ? `deckKey(d) !== ${JSON.stringify(expected.docId)} || ` : ''} c.slideNumber() !== ${JSON.stringify(expected.slide)}) return 'stale';` : '';
      const out = await osa(['-l', 'JavaScript', '-e', `${DECK_KEY_JS}\n(() => { for (const id of ['com.apple.Keynote', 'com.apple.iWork.Keynote']) { const a = Application(id); if (a.running() && a.playing()) { ${guard} a.${cmd}(); return 'ok'; } } return 'not playing'; })()`], null, 4000);
      if (out !== 'ok') throw Object.assign(new Error(out === 'stale' ? 'Presentation changed before the click' : 'Keynote is not playing'), { status: 409 });
      return true;
    }
    if (this.source === 'powerpoint') {
      const cmd = action === 'next' ? 'go to next slide slide show view of slide show window 1' : 'go to previous slide slide show view of slide show window 1';
      const guard = expected ? `if (slide index of slide of slide show view of slide show window 1) is not ${Number(expected.slide)} then error "Slide changed before the click"` : '';
      await osa(['-e', `tell application "Microsoft PowerPoint"\n${guard}\n${cmd}\nend tell`], null, 4000);
      return true;
    }
    return false;
  }
}

// Keynote uses U+FFFC for inline equations and images.
export function cleanSlideText(t) {
  return String(t || '').replace(/\uFFFC/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

const REFS_RE = /^\s*(\[\s*(sources?|references?|参考(资料|文献)?|来源)\s*\]|(sources?|references?|参考(资料|文献)?|来源)\s*[:：])\s*$/i;

// Build a script from imported slides: one section per slide, notes as text.
// A slide without notes shows its own text as a (not spoken) cue.
// Slides with build information ({steps}: what each click reveals) get
// [click] markers where their notes have none; a slide whose markers do not
// match its builds gets a warning cue. stats (optional) counts both.
export function scriptFromSlides(slides, stats = null) {
  const out = [];
  for (const s of slides) {
    if (s.skipped) continue;
    const title = cleanSlideText(s.title).replace(/\s+/g, ' ');
    out.push(`[slide ${s.n}${title ? `: ${title}` : ''}]`);
    const notes = cleanSlideText(s.notes);
    if (notes) {
      // Reference blocks ("[Sources]", "Sources:", "References") are shown
      // as cues, not as text to follow.
      const lines = notes.split('\n');
      let cut = lines.findIndex((line) => REFS_RE.test(line));
      if (cut < 0) cut = lines.length;
      let spoken = lines.slice(0, cut).join('\n');
      const steps = Array.isArray(s.steps) ? s.steps : null;
      if (steps && steps.length) {
        const marked = markedClicks(spoken);
        if (!marked.length) {
          const r = placeClicks(spoken, steps);
          spoken = r.text;
          if (stats && r.placed) { stats.placed += r.placed; stats.slides++; }
        } else {
          // the click after the last build turns the slide: one more marker
          // than builds is the author's turn
          const n = marked.filter((m) => !m.trailing).reduce((a, m) => a + m.count, 0);
          if (n < steps.length || n > steps.length + 1) {
            out.push(`// ⚠ Keynote has ${steps.length} build${steps.length > 1 ? 's' : ''} on this slide; these notes mark ${n} click${n === 1 ? '' : 's'}`);
            if (stats) stats.mismatch.push(s.n);
          }
        }
      }
      out.push(...spoken.split('\n'));
      for (const line of lines.slice(cut)) out.push(line.trim() ? `// ${line.trim()}` : line);
    } else {
      const body = cleanSlideText(s.body).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
      out.push(...(body.length ? body.map((l) => `// ${l}`) : [`// (slide ${s.n}: no presenter notes)`]));
    }
    out.push('');
  }
  return out.join('\n');
}
