// Teleprompter app controller: editor, prompter view, engines, Jev, slides.

import { parseScript, distinctiveTerms, textOfPhrases } from './lib/script.js';
import { Follower } from './lib/follower.js';
import { Renderer } from './lib/render.js';
import { WebSpeechEngine, NativeEngine, SimEngine, MicMeter, Vad } from './lib/engines.js';
import { SemanticClient } from './lib/semantic-client.js';
import { heuristicAnalysis, mergeAnalysis } from './lib/outline.js';
import { BuildController, slideIndex } from './lib/builds.js';
import { t, setUiLang, uiLang } from './lib/i18n.js';
import { manualAlignment } from './lib/alignment.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');

// Inside the native Mac shell (floating window over the slide show) the page
// reports its state, so the shell can float above Keynote while it plays.
const shell = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tp;
function postShell(msg) {
  if (!shell) return;
  try {
    shell.postMessage(msg);
  } catch {
    // shell gone
  }
}
// One status line for the floating window's title bar.
function shellTitle() {
  const v = S.follower ? S.follower.view() : null;
  const parts = [`${S.listening ? '●' : '○'} ${v ? t('status')[v.status] || v.status : ''}`];
  if (S.slide && S.slide.slide != null && S.slide.source !== 'none') parts.push(t('slideOf')(S.slide.slide, S.slide.total));
  const bt = buildChipText();
  if (bt) parts.push(bt);
  if (S.timerStart || S.timerAcc) parts.push(fmtTime(elapsed()));
  if (!S.listening) parts.push(t('shellHintListen'));
  return parts.join('  ·  ');
}

function shellState() {
  postShell({
    type: 'state',
    title: shellTitle(),
    view: app.dataset.view,
    listening: !!S.listening,
    playing: !!(S.slide && S.slide.playing && S.slide.source !== 'none' && S.slide.source !== 'external'),
    source: S.slide ? S.slide.source : 'none',
  });
}

// ------------------------------------------------------------- settings

const DEFAULTS = {
  uiLang: uiLang(), fontSize: 46, lineHeight: 1.55, readingLine: 0.38, lookahead: 2.6,
  theme: 'dark', mirror: false, flip: false, wordProgress: true, transcript: true, semantic: true,
  engine: 'auto', recLang: 'auto', slides: 'none', slideFollow: true, autoAdvance: true, autoBuilds: true, level: 0, detail: 0.5,
  mathDisplay: 'formula',
};

function lsGet(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // private mode etc.
  }
}

const settings = { ...DEFAULTS, ...lsGet('tp.settings', {}) };
const saveSettings = () => lsSet('tp.settings', settings);
// v2: speech drives builds ([click] markers) and slide advance by default
if ((settings.v || 1) < 2) {
  settings.v = 2;
  saveSettings();
}
// Chinese-first interface, whatever the system language, until the user
// picks one with the 中文/EN switch.
if (!settings.uiLangChosen) settings.uiLang = 'zh';
setUiLang(settings.uiLang);

// ---------------------------------------------------------------- state

const S = {
  health: null,
  doc: null,
  follower: null,
  renderer: null,
  engine: null,
  listening: false,
  semantic: null,
  analysis: null,
  jevAnalysis: null,
  slide: { source: 'none', slide: null, total: null },
  slideMap: null, // {n: tokStart} from Jev alignment
  timerStart: 0,
  timerAcc: 0,
  scriptId: lsGet('tp.scriptId', null),
  vad: new Vad(),
  meter: null,
  level: 0,
  builds: null, // BuildController: speech-driven builds and slide advance
  buildsPaused: false,
  inputAccess: null, // native shell: can it see clicker/keyboard input?
  events: null,
  eventsConnected: false,
  pageId: globalThis.crypto.randomUUID(),
  controlId: null,
  toastedLabels: new Set(), // semantic labels already shown this episode
};
window.tp = S; // handy for debugging and automated tests

// ------------------------------------------------------------------ i18n

function applyI18n() {
  document.documentElement.lang = uiLang() === 'zh' ? 'zh-CN' : 'en';
  document.title = t('appName');
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  for (const e of document.querySelectorAll('[data-th]')) e.innerHTML = t(e.dataset.th);
  $('#title').placeholder = t('title');
  $('#script').placeholder = t('placeholder');
  $('#btn-ui-lang').textContent = uiLang() === 'zh' ? 'EN' : '中文';
  $('#btn-back').title = t('back');
  $('#btn-mic').title = t('mic');
  $('#btn-settings').title = t('settings');
  $('#btn-demo').title = t('demo');
  $('#sim-say').placeholder = t('simSay');
  $('#sim-read').textContent = t('simReadAll');
  $('#sim-story').textContent = t('simStory');
  const eng = t('engines');
  for (const o of $('#set-engine').options) o.textContent = eng[o.value];
  $('#set-reclang').options[0].textContent = t('recLangAuto');
  const th = t('themes');
  for (const o of $('#set-theme').options) o.textContent = th[o.value];
  const mm = t('mathModes');
  for (const o of $('#set-math').options) o.textContent = mm[o.value];
  const ss = t('slideSources');
  for (const o of $('#set-slides').options) o.textContent = ss[o.value];
  buildLevelSeg();
  updateJevStatus();
  updateLinkButton();
  setListeningUi(!!S.listening);
  if (S.follower) updateHud(S.follower.view());
  updateBuildUi();
}

function setDetail(d) {
  settings.detail = Math.max(0, Math.min(1, Math.round(d * 20) / 20));
  saveSettings();
  $('#detail').value = settings.detail;
  if (S.renderer) S.renderer.setDetail(settings.detail);
}

function buildLevelSeg() {
  $('#detail-wrap').hidden = !(S.level === 1 || S.level === 2);
  const seg = $('#level-seg');
  seg.innerHTML = '';
  t('levels').forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.level = i;
    b.className = i === S.level ? 'on' : '';
    b.onclick = () => setLevel(i);
    seg.appendChild(b);
  });
}

// ---------------------------------------------------------------- health

async function loadHealth() {
  try {
    S.health = await (await fetch('/api/health')).json();
  } catch {
    S.health = null;
  }
  updateJevStatus();
}

function jevAvailable() {
  return !!(S.health && S.health.jev && S.health.jev.available);
}

function updateJevStatus() {
  const e = $('#jev-status');
  if (!S.health) {
    e.textContent = '';
    return;
  }
  e.textContent = jevAvailable() ? t('jevReady')(S.health.jev.source) : t('noJev');
}

// ---------------------------------------------------------------- editor

const scriptEl = $('#script');
const titleEl = $('#title');
const langEl = $('#script-lang');

function editorMsg(msg) {
  $('#editor-msg').textContent = msg || '';
}

function draft() {
  return { id: S.scriptId, title: titleEl.value.trim(), lang: langEl.value, text: scriptEl.value, dirty: isDirty(), deck: S.scriptDeck || null, deckId: S.scriptDeckId || null };
}

// Keynote names a document with or without ".key"
const deckName = (n) => String(n || '').replace(/\.key$/i, '').trim();
const deckKey = (st) => st?.docId || st?.doc || null;

// Text and metadata are both part of a saved script.
function isDirty() {
  return !!scriptEl.value.trim() && (scriptEl.value !== S.savedText || !!(S.savedMeta &&
    (titleEl.value.trim() !== S.savedMeta.title || langEl.value !== S.savedMeta.lang)));
}

function confirmDiscard() {
  if (!isDirty()) return true;
  return confirm(uiLang() === 'zh' ? '当前稿件有未保存的修改，确定要放弃吗？' : 'Discard unsaved changes to the current script?');
}

let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => lsSet('tp.draft', draft()), 400);
}

function loadIntoEditor(rec) {
  S.importedSlides = null;
  S.scriptId = rec.id || null;
  lsSet('tp.scriptId', S.scriptId);
  titleEl.value = rec.title || '';
  langEl.value = rec.lang || 'auto';
  scriptEl.value = rec.text || '';
  S.scriptDeck = rec.deck || null;
  S.scriptDeckId = rec.deckId || null;
  S.savedText = scriptEl.value;
  S.savedMeta = { title: titleEl.value.trim(), lang: langEl.value };
  editorMsg('');
  lsSet('tp.draft', draft());
  refreshList();
}

async function refreshList() {
  let list = [];
  try {
    const res = await fetch('/api/scripts');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  const box = $('#script-list');
  box.innerHTML = '';
  for (const s of list) {
    const it = document.createElement('div');
    it.className = `item${s.id === S.scriptId ? ' on' : ''}`;
    const name = document.createElement('span');
    name.textContent = s.title || '(untitled)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = uiLang() === 'zh' ? `${s.chars} 字` : `${s.chars} chars`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = uiLang() === 'zh' ? '删除' : 'Delete';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(uiLang() === 'zh' ? `删除“${s.title || '未命名'}”？` : `Delete "${s.title || 'untitled'}"?`)) return;
      try {
        const res = await fetch(`/api/scripts/${s.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        if (S.scriptId === s.id) {
          S.scriptId = null;
          lsSet('tp.scriptId', null);
          S.savedText = '';
        }
        refreshList();
      } catch (err) { editorMsg((uiLang() === 'zh' ? '删除失败：' : 'Delete failed: ') + err.message); }
    };
    it.append(name, meta, del);
    it.onclick = async () => {
      if (!confirmDiscard()) return;
      try {
        const res = await fetch(`/api/scripts/${s.id}`);
        const rec = await res.json();
        if (!res.ok) throw new Error(rec.error || `HTTP ${res.status}`);
        loadIntoEditor(rec);
      } catch (err) { editorMsg(err.message); }
    };
    box.appendChild(it);
  }
}

async function saveScript() {
  const d = draft();
  if (!d.text.trim()) return editorMsg(t('emptyScript'));
  if (!d.title) d.title = d.text.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 40);
  try {
    const res = await fetch('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
    const rec = await res.json();
    if (!res.ok || !rec.id) throw new Error(rec.error || `HTTP ${res.status}`);
    S.scriptId = rec.id;
    lsSet('tp.scriptId', rec.id);
    titleEl.value = rec.title;
    S.savedText = d.text;
    S.savedMeta = { title: rec.title, lang: rec.lang || d.lang };
    lsSet('tp.draft', draft());
    editorMsg(t('savedOk'));
    refreshList();
  } catch (err) {
    editorMsg((uiLang() === 'zh' ? '保存失败：' : 'Save failed: ') + err.message);
  }
}

async function loadSample(name, ask = true) {
  if (ask && !confirmDiscard()) return;
  const text = await (await fetch(`/samples/${name}`)).text();
  loadIntoEditor({ id: null, title: '', lang: 'auto', text });
}

async function importKeynote() {
  editorMsg(t('importing'));
  try {
    const j = await (await fetch('/api/slides/import')).json();
    if (j.error) throw new Error(j.error);
    if (scriptEl.value.trim() && !confirm(uiLang() === 'zh' ? '用 Keynote 备注替换当前稿件？' : 'Replace the current script with Keynote notes?')) return editorMsg('');
    loadIntoEditor({ id: null, title: deckName(j.doc), lang: 'auto', text: j.script, deck: deckName(j.doc), deckId: j.docId });
    S.importedSlides = j.slides;
    editorMsg(t('imported')(j.slides.length));
  } catch (err) {
    editorMsg(t('importFail') + err.message);
  }
}

// The show plays another deck than the script came from: take its notes
// and reopen the prompter on them (the show keeps playing).
async function importPlaying() {
  try {
    const j = await (await fetch('/api/slides/import')).json();
    if (j.error) throw new Error(j.error);
    // no dialog during a show (it would take the keyboard from the slides):
    // unsaved edits are kept aside instead
    if (isDirty()) lsSet('tp.draftBackup', draft());
    const wasListening = S.listening;
    loadIntoEditor({ id: null, title: deckName(j.doc), lang: 'auto', text: j.script, deck: deckName(j.doc), deckId: j.docId });
    S.importedSlides = j.slides;
    startPrompter();
    if (wasListening) startListening();
    toast('▶', t('imported')(j.slides.length), { ttl: 3000 });
  } catch (err) {
    toast('!', t('importFail') + err.message, { warn: true, ttl: 6000 });
  }
}

// -------------------------------------------------------------- prompter

function startPrompter() {
  const text = scriptEl.value;
  if (!text.trim()) return editorMsg(t('emptyScript'));
  lsSet('tp.draft', draft());
  // Same script as before: resume where we were (position, timer, marks).
  const same = S.doc && S.docSource === text && S.docLang === langEl.value && S.docDeck === (S.scriptDeck || null) && S.docDeckId === (S.scriptDeckId || null);
  if (!same) {
    const doc = parseScript(text, { lang: langEl.value, title: titleEl.value.trim() });
    if (!doc.tokens.length) return editorMsg(t('emptyScript'));
    S.docDeck = S.scriptDeck || null;
    S.docDeckId = S.scriptDeckId || null;
    S.docSource = text;
    S.docLang = langEl.value;
    openDoc(doc);
  }
  app.dataset.view = 'prompter';
  shellState();
  $('#prompter').focus();
  requestAnimationFrame(() => S.renderer.relayout());
}

function openDoc(doc) {
  const saved = lsGet('tp.buildState', null);
  S.pendingBuildRestore = saved;
  S.openingDoc = true;
  stopListening();
  S.semantic?.dispose();
  S.builds?.dispose();
  S.unfollow?.();
  S.outlineRequest?.abort();
  S.doc = doc;
  S.mustReminded = new Set();
  S.lastReminder = null;
  S.lastControlError = null;
  S.toastedLabels.clear();
  S.prevLabel = null;
  $('#toasts').innerHTML = '';
  S.boundDeck = deckKey(S.slide);
  S.follower = new Follower(doc, { lookaheadSec: settings.lookahead });
  S.analysis = heuristicAnalysis(doc);
  S.jevAnalysis = null;
  S.slideMap = null;
  const savedMap = lsGet('tp.slideMap', null);
  S.pendingSlideMap = savedMap;
  if (savedMap?.key === docKey(doc) && savedMap.deck === deckKey(S.slide)) {
    try { S.slideMap = manualAlignment(doc, savedMap.text, S.slide?.total); S.pendingSlideMap = null; } catch {}
  }
  $('#map-editor').hidden = true;
  S.timerStart = 0;
  S.timerAcc = 0;
  if (!S.renderer) {
    S.renderer = new Renderer({
      stage: $('#stage'), scroller: $('#scroller'), content: $('#content'),
      onPick: (tok) => S.follower && S.follower.jumpTo(tok),
    });
  }
  S.renderer.readingLine = settings.readingLine;
  S.renderer.wordProgress = settings.wordProgress;
  S.renderer.level = S.level = settings.level || 0;
  S.renderer.detail = settings.detail;
  S.renderer.mathMode = settings.mathDisplay;
  S.renderer.setDoc(doc, S.analysis);
  S.builds = new BuildController(doc, {
    send: (action, expected) => {
      if (S.doc !== doc) throw new Error('Script changed');
      return slideControl(action, expected);
    },
    range: (n) => slideRange(n),
    markers: (n) => slides().markers(n),
    log: (event, detail) => clientLog(event, detail),
    onChange: () => {
      if (S.openingDoc || S.doc !== doc) return;
      updateBuildUi();
      saveBuildState();
      if (S.builds?.error && S.lastControlError !== S.builds.error) {
        S.lastControlError = S.builds.error;
        toast('▶', (uiLang() === 'zh' ? '自动控制已暂停：' : 'Automatic control paused: ') + S.builds.error, { warn: true, ttl: 12000 });
      }
    },
  });
  applyBuildFlags();
  S.builds.slideState(slideAppControllable() ? S.slide : { playing: false });
  // a reload in the middle of a show: the builds already shown on this slide
  if (saved && saved.key === docKey(doc) && saved.deck === deckKey(S.slide) && Date.now() - saved.at < 15 * 60 * 1000 && S.builds.restore(saved.slide, saved.done)) S.pendingBuildRestore = null;
  S.openingDoc = false;
  saveBuildState();
  S.unfollow = S.follower.on((v) => { if (S.doc === doc) onView(v); });
  S.semantic = new SemanticClient(doc, S.follower, {
    enabled: settings.semantic && jevAvailable(),
    onJudgment: onJudgment,
    onSkipReminder: onSkipReminder,
  });
  S.semantic.suspend();
  buildLevelSeg();
  // the slide show may already be on some slide: start there
  if (settings.slideFollow && S.slide && S.slide.slide != null) {
    const r = slideRange(S.slide.slide);
    if (r) S.follower.slideChanged(r.tokStart, r.tokEnd);
  }
  onView(S.follower.view());
  requestOutline(doc);
  transcript.fin = '';
  transcript.int = '';
  renderTranscript();
}

async function requestOutline(doc) {
  if (!settings.semantic || !jevAvailable()) return;
  S.outlineRequest?.abort();
  const ctrl = S.outlineRequest = new AbortController();
  S.outlinePending = true;
  try {
    const res = await fetch('/api/outline', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: scriptEl.value, lang: langEl.value, title: doc.title }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (S.doc !== doc || ctrl.signal.aborted || !settings.semantic) return;
    if (!res.ok || j.errors) {
      toast('Jev', uiLang() === 'zh' ? `智能提纲部分不可用（${j.errors || '请求失败'}），使用本地提纲。` : 'Some outline analysis is unavailable; using local fallback.', { warn: true, ttl: 5000 });
      if (!res.ok || !Object.keys(j.sents || {}).length) return;
    }
    S.jevAnalysis = j;
    S.analysis = mergeAnalysis(doc, heuristicAnalysis(doc), j);
    S.renderer.setAnalysis(S.analysis);
    if (S.level > 0) toast('Jev', t('analyzed'), { ttl: 2500 });
  } catch (err) {
    if (S.doc === doc && !ctrl.signal.aborted) toast('Jev', uiLang() === 'zh' ? '智能提纲请求失败，使用本地提纲。' : 'Outline request failed; using local fallback.', { warn: true });
  } finally {
    if (S.outlineRequest === ctrl) S.outlinePending = false;
  }
}

function setLevel(level) {
  level = Math.max(0, Math.min(4, level));
  S.level = settings.level = level;
  saveSettings();
  S.renderer.setLevel(level);
  buildLevelSeg();
  if (level > 0 && !S.jevAnalysis && settings.semantic && S.outlinePending) toast('Jev', t('analyzing'), { ttl: 1800 });
}

function onView(v) {
  // while off script, outline the resume point so the eye finds it
  $('#stage').classList.toggle('offscript', v.status === 'offscript');
  if (v.status === 'tracking' && v.run === 0) {
    S.toastedLabels.clear();
    S.prevLabel = null;
  }
  S.renderer.update(v);
  updateHud(v);
  // A human-marked required paragraph is never downgraded by model scores.
  S.mustReminded ||= new Set();
  for (const p of [...S.mustReminded]) if (!S.doc.phrases.some(ph => ph.para === p && S.follower.skipped.has(ph.idx))) S.mustReminded.delete(p);
  for (const p of S.doc.paras.filter(p => p.must)) {
    if (!S.mustReminded.has(p.idx) && S.doc.phrases.some(ph => ph.para === p.idx && S.follower.skipped.has(ph.idx))) {
      S.mustReminded.add(p.idx);
      toast('!', (uiLang() === 'zh' ? '必讲段落有遗漏：' : 'Required passage skipped: ') + shorten(p.text, 80), { warn: true, ttl: 12000,
        actions: [{ label: uiLang() === 'zh' ? '回到此处' : 'Return here', run: () => S.follower.jumpTo(p.tokStart) }] });
    }
  }
  if (S.semantic && S.listening) S.semantic.check();
  if (S.builds) S.builds.view(v, canDriveSlides());
}

// ------------------------------------------------------------------ HUD

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function elapsed() {
  return S.timerAcc + (S.timerStart ? Date.now() - S.timerStart : 0);
}

// elapsed · estimated time left at the current pace
function timerText(v) {
  const el = fmtTime(elapsed());
  if (!S.doc || !v || !v.rate || !S.timerStart) return el;
  const left = Math.max(0, S.doc.tokens.length - v.pos) / v.rate * 1000;
  return `${el} · ${t('left')(fmtTime(left))}`;
}

function updateHud(v) {
  const st = $('#chip-status');
  st.textContent = t('status')[v.status] || v.status;
  st.className = `chip st-${v.status}`;
  const sem = $('#chip-sem');
  if (v.semantic && v.semantic.label && v.status === 'offscript') {
    sem.hidden = false;
    sem.textContent = t('sem')[v.semantic.label] || v.semantic.label;
  } else sem.hidden = true;
  $('#chip-pace').textContent = S.listening ? t('pace')(v.rate, S.doc.lang) : '';
  $('#chip-timer').textContent = timerText(v);
  $('#progress .fill').style.width = `${(v.progress * 100).toFixed(1)}%`;
  updateSlideChip();
}

function linked() {
  return !!(S.slide && S.slide.source && S.slide.source !== 'none');
}

function updateLinkButton() {
  const on = linked();
  const b = $('#btn-link-keynote');
  if (b) b.hidden = on;
  const eb = $('#btn-editor-link');
  if (eb) {
    eb.textContent = on ? t('linkOn')(S.slide.source === 'powerpoint' ? 'PowerPoint' : S.slide.source === 'keynote' ? 'Keynote' : t('slideSources').external) : t('linkKeynote');
    eb.classList.toggle('on', on);
  }
}

function updateSlideChip() {
  updateLinkButton();
  updateBuildUi();
  const chip = $('#chip-slide');
  const ns = $('#next-slide');
  const st = S.slide;
  if (!linked()) {
    chip.hidden = true;
    ns.hidden = true;
    return;
  }
  chip.hidden = false;
  const appName = st.source === 'powerpoint' ? 'PowerPoint' : st.source === 'keynote' ? 'Keynote' : '';
  if (st.slide == null || st.running === false) {
    // linked, but nothing to follow yet
    chip.textContent = st.running === false ? t('slideAppClosed')(appName) : t('slideLinked')(appName);
    ns.hidden = true;
    return;
  }
  chip.textContent = `${appName ? `${appName} · ` : ''}${t('slideOf')(st.slide, st.total)}${st.playing ? ' ▶' : ''}`;
  const nextTitle = slideTitle(st.slide + 1);
  ns.hidden = !nextTitle;
  ns.textContent = nextTitle ? `${t('next')} → ${nextTitle}` : '';
}

function slideTitle(n) {
  if (!S.doc) return '';
  const sl = S.doc.slides.find((s) => s.n === n);
  if (sl) return sl.title || '';
  const imp = (S.importedSlides || []).find((s) => s.n === n);
  return imp ? imp.title : '';
}

setInterval(() => {
  if (!S.follower || app.dataset.view !== 'prompter') return;
  const now = Date.now();
  S.follower.tick(now);
  if (S.builds) S.builds.tick(canDriveSlides());
  if (S.controlId && Date.now() - (S.leaseAt || 0) > 3000 && !S.renewingLease) {
    const engine = S.engine;
    S.renewingLease = true;
    claimControls(engine).catch(err => { if (S.engine === engine) onEngineState('error', err.message); }).finally(() => { S.renewingLease = false; });
  }
  if (S.listening) $('#chip-timer').textContent = timerText(S.follower.view(now));
  if (S.listening && !S.watchdogDone && now - S.listenStartedAt > 12000) {
    S.watchdogDone = true;
    if (!S.recogAt) {
      const msg = S.heardAt ? t('noRecognition') : t('noAudio');
      toast('!', msg, { warn: true, ttl: 15000 });
      clientLog('watchdog', S.heardAt ? 'sound-but-no-text' : 'no-sound');
    }
  }
}, 500);

// quiet HUD while speaking
let lastMouse = Date.now();
document.addEventListener('mousemove', () => {
  lastMouse = Date.now();
  $('#prompter').classList.remove('quiet');
});
setInterval(() => {
  const quiet = S.listening && Date.now() - lastMouse > 3500 && $('#settings').hidden && $('#simpanel').hidden;
  $('#prompter').classList.toggle('quiet', quiet);
}, 500);

// ------------------------------------------------------------- toasts

function toast(tag, text, { ttl = 3200, warn = false, actions = [] } = {}) {
  const doc = S.doc;
  const box = $('#toasts');
  const e = document.createElement('div');
  e.className = `toast${warn ? ' warn' : ''}`;
  const tg = document.createElement('span');
  tg.className = 'tag';
  tg.textContent = tag;
  const tx = document.createElement('span');
  tx.className = 'txt';
  tx.textContent = text;
  e.append(tg, tx);
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = () => {
      if (!doc || S.doc === doc) a.run();
      e.remove();
    };
    e.appendChild(b);
  }
  box.appendChild(e);
  while (box.children.length > 3) box.firstChild.remove();
  if (ttl) setTimeout(() => {
    e.classList.add('out');
    setTimeout(() => e.remove(), 450);
  }, ttl);
  return e;
}

function onJudgment(j) {
  if (j.error || !j.relation || j.action === 'stale') return;
  const label = j.relation.choice;
  // unsure judgments only show in the status chip, not as a toast
  if ((j.relation.confidence ?? 0) < 0.45 && j.action === 'hold') return;
  const name = t('sem')[label] || label;
  const moved = j.action && j.action !== 'hold' && j.action !== 'stale';
  // a direction label whose move did not happen just points at the line
  const keepsHint = label === 'adlib_related' || label === 'unrelated' || label === 'false_start';
  const hint = moved || keepsHint ? t('semHint')[label] || '' : t('holdHint');
  // the judgment has already been applied: this is where to pick up
  const ph = S.doc.phrases[S.follower.currentPhrase()];
  const target = ph ? ph.text : '';
  // Moves always get a toast. Otherwise one toast per label per off-script
  // episode, and only once the label is confident or confirmed by the next
  // judgment (the first guess on a few words is often revised); the status
  // chip shows everything.
  const prev = S.prevLabel;
  S.prevLabel = label;
  if (!moved) {
    if (S.toastedLabels.has(label)) return;
    if ((j.relation.confidence ?? 0) < 0.75 && prev !== label) return;
  }
  S.toastedLabels.add(label);
  toast(name, `${hint}${target}`, { ttl: 3800 });
}

function shorten(text, max = 60) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp); // English: end on a word
  return `${cut}…`;
}

function onSkipReminder(r) {
  const target = r.tokStart ?? S.doc.phrases[r.phrases[0]].tokStart;
  S.lastReminder = { target, at: Date.now() };
  toast(t('skippedReminder'), shorten(r.text), {
    ttl: 9000, warn: true,
    actions: [
      { label: t('goBack'), run: () => S.follower.jumpTo(target) },
      { label: t('dismiss'), run: () => {} },
    ],
  });
}

// -------------------------------------------------------------- engines

function recLang() {
  if (settings.recLang !== 'auto') return settings.recLang;
  return S.doc && S.doc.lang === 'zh' ? 'zh-CN' : 'en-US';
}

function nativeReady(lang) {
  const n = S.health && S.health.native;
  if (!n || !n.built) return false;
  const inst = n.locales && n.locales.installed;
  return !!inst && inst.includes(lang);
}

function chooseEngine() {
  const e = settings.engine;
  if (e === 'sim') return 'sim';
  if (e === 'native') return 'native';
  if (e === 'webspeech') return 'webspeech';
  if (shell && nativeReady(recLang())) return 'native';
  if (WebSpeechEngine.supported()) return 'webspeech';
  if (nativeReady(recLang())) return 'native';
  return null;
}

function makeEngine(kind) {
  let engine;
  const current = () => S.listening && S.engine === engine;
  const handlers = {
    onInterim: (text) => { if (current()) onSpeech('interim', text); },
    onFinal: (text) => { if (current()) onSpeech('final', text); },
    onState: (state, detail) => { if (current()) onEngineState(state, detail); },
    onLevel: (rms) => { if (current()) onLevel(rms); },
  };
  const lang = recLang();
  if (kind === 'webspeech') engine = new WebSpeechEngine({ lang, terms: distinctiveTerms(S.doc), ...handlers });
  else if (kind === 'native') { engine = new NativeEngine({ lang, text: scriptEl.value, ...handlers }); engine.pageId = S.pageId; }
  else engine = new SimEngine({ doc: S.doc, ...handlers });
  return engine;
}

// Reflect listening state: mic button label/colour and the start hint.
function setListeningUi(on) {
  $('#btn-mic').classList.toggle('on', on);
  $('#btn-mic .lbl').textContent = t(on ? 'micStop' : 'micStart');
  app.dataset.listening = on ? '1' : '0';
  shellState();
}

// Engine state goes to the server log (no transcripts), for diagnosis.
function clientLog(event, detail) {
  if (detail && typeof detail === 'object') detail = JSON.stringify(detail);
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, detail, engine: S.engine && S.engine.name }) }).catch(() => {});
}

async function startListening() {
  if (!S.doc || S.listening) return;
  const kind = chooseEngine();
  if (!kind) return toast('!', uiLang() === 'zh' ? '没有可用的语音识别器。请安装本机语言模型或使用支持语音识别的浏览器。' : 'No speech recognizer available. Install the on-device language model or use a supported browser.', { warn: true, ttl: 8000 });
  if (kind === 'webspeech' && !WebSpeechEngine.supported()) return toast('!', t('noWebSpeech'), { warn: true });
  S.engine = makeEngine(kind);
  S.listening = true;
  S.semantic?.resume();
  applyBuildFlags();
  setListeningUi(true);
  $('#btn-mic').classList.remove('err');
  if (!S.timerStart) S.timerStart = Date.now();
  // watchdog: tell the speaker what is wrong if nothing is recognized
  S.listenStartedAt = Date.now();
  S.heardAt = 0;
  S.recogAt = 0;
  S.watchdogDone = kind === 'sim';
  clientLog('listen-start', kind);
  if (kind !== 'sim') {
    S.meter = S.meter || new MicMeter((rms) => onLevel(rms));
    if (kind === 'webspeech') S.meter.start();
  }
  const engine = S.engine;
  try {
    if (kind === 'native') {
      await claimControls(engine);
      if (S.engine !== engine || !S.listening) return;
      await engine.start();
    } else if (kind === 'webspeech') await Promise.all([engine.start(), claimControls(engine)]);
    else await engine.start();
    if (S.engine === engine && S.listening) S.follower.armListening();
  } catch (err) {
    if (S.engine === engine) onEngineState('error', err.message);
  }
}

function stopListening() {
  // clear state first: engines report 'stopped', which must not re-enter here
  const eng = S.engine;
  S.engine = null;
  S.listening = false;
  const controlId = S.controlId;
  S.controlId = null;
  if (controlId) fetch('/api/slides/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: controlId }) }).catch(() => {});
  S.semantic?.suspend();
  S.builds?.setListening(false);
  if (eng) eng.stop();
  if (S.meter) S.meter.stop();
  if (S.timerStart) {
    S.timerAcc += Date.now() - S.timerStart;
    S.timerStart = 0;
  }
  setListeningUi(false);
  if (S.follower) {
    S.follower.status = 'idle';
    onView(S.follower.view());
  }
}

function toggleListening() {
  if (S.listening) stopListening();
  else startListening();
}

const transcript = { fin: '', int: '' };
function onSpeech(kind, text) {
  if (!S.follower || !S.listening || !S.engine) return;
  if (!S.recogAt && text && text.trim() && S.engine && S.engine.name !== 'sim') {
    S.recogAt = Date.now();
    toast('🎙', t('recognizing'), { ttl: 2000 });
    clientLog('first-result', S.engine.name);
  }
  S.follower.onSpeech(kind, text);
  const sep = S.doc.lang === 'zh' ? '' : ' ';
  if (kind === 'final') {
    transcript.fin = `${transcript.fin}${transcript.fin ? sep : ''}${text.trim()}`.slice(-300);
    transcript.int = '';
  } else {
    transcript.int = text.trim();
  }
  renderTranscript();
}

function renderTranscript() {
  // show the tail that fits: most recent words on the right
  const max = S.doc && S.doc.lang === 'zh' ? 60 : 110;
  const sep = S.doc && S.doc.lang === 'zh' ? '' : ' ';
  let fin = transcript.fin;
  const int = transcript.int;
  const room = Math.max(0, max - int.length);
  if (fin.length > room) fin = `…${fin.slice(fin.length - room)}`;
  $('#transcript .fin').textContent = fin;
  $('#transcript .int').textContent = int ? `${fin ? sep : ''}${int}` : '';
}

function onEngineState(state, detail) {
  if (state === 'error' || state === 'listening') clientLog(`engine-${state}`, detail);
  if (state === 'error') {
    $('#btn-mic').classList.add('err');
    if (detail === 'not-allowed' || detail === 'service-not-allowed' || detail === 'audio-capture') {
      toast('!', t('micDenied'), { warn: true, ttl: 8000 });
      stopListening();
    } else if (detail) {
      toast('!', String(detail).slice(0, 160), { warn: true, ttl: 5000 });
    }
    stopListening();
  } else if (state === 'listening') {
    $('#btn-mic').classList.remove('err');
  } else if (state === 'stopped' && S.listening) {
    stopListening();
  }
}

const meterCtx = $('#meter').getContext('2d');
function onLevel(rms) {
  const active = S.vad.push(rms);
  if (active || rms > 0.004) S.heardAt = Date.now(); // any real signal counts as sound
  if (S.follower) S.follower.onVoice(active);
  const w = 54;
  const h = 16;
  meterCtx.clearRect(0, 0, w, h);
  const level = Math.min(1, Math.sqrt(rms) * 2.2);
  meterCtx.fillStyle = active ? '#4cd97b' : '#555a63';
  meterCtx.fillRect(0, 0, Math.round(level * w), h);
}

// --------------------------------------------------------------- slides

function connectEvents() {
  if (S.events) S.events.close();
  const es = new EventSource(`/api/events?pageId=${S.pageId}`);
  S.events = es;
  es.addEventListener('open', () => {
    S.eventsConnected = true;
    applyBuildFlags();
    const engine = S.engine;
    if (S.listening && engine?.name === 'webspeech') claimControls(engine).catch(err => { if (S.engine === engine) onEngineState('error', err.message); });
  });
  es.addEventListener('error', () => {
    S.eventsConnected = false;
    S.controlId = null;
    applyBuildFlags();
    if (S.engine?.name === 'native') {
      stopListening();
      toast('!', uiLang() === 'zh' ? '与本机服务断开连接，请重新开始收音。' : 'Local connection lost. Start listening again.', { warn: true, ttl: 8000 });
    }
  });
  es.addEventListener('slide', (e) => onSlideState(JSON.parse(e.data)));
  es.addEventListener('asr', (e) => {
    const msg = JSON.parse(e.data);
    if (S.engine && S.engine.name === 'native') S.engine.handle(msg);
    if (msg.type === 'install') {
      $('#native-note').textContent = `${msg.locale || ''} ${msg.state || ''} ${msg.progress != null ? Math.round(msg.progress * 100) + '%' : ''}`;
      if (msg.state === 'done') loadHealth();
    }
  });
  es.addEventListener('hello', (e) => {
    const j = JSON.parse(e.data);
    S.eventsConnected = true;
    if (j.slides) onSlideState(j.slides, true);
  });
}

// Where each slide's text is ([slide N] sections, or the Jev alignment) and
// which click markers belong to it; rebuilt when the doc or alignment changes.
function slides() {
  if (!S.slideIdx || S.slideIdx.doc !== S.doc || S.slideIdx.map !== S.slideMap) {
    S.slideIdx = { doc: S.doc, map: S.slideMap, ...slideIndex(S.doc || { slides: [], tokens: [], phrases: [], builds: [] }, S.slideMap) };
  }
  return S.slideIdx;
}

function slideRange(n) {
  return S.doc ? slides().range(n) : null;
}

function onSlideState(st, initial = false) {
  const deckChanged = !!(deckKey(S.slide) && deckKey(st) && (deckKey(st) !== deckKey(S.slide) || st.source !== S.slide.source));
  const prev = S.slide ? S.slide.slide : null;
  const wasPlaying = !!(S.slide && S.slide.playing);
  S.slide = st;
  if (deckChanged) S.slideMap = null;
  const savedMap = S.pendingSlideMap;
  // Mapping belongs to a document, not to its playing state. Restore it as soon
  // as a real document identity arrives, including while reviewing before a show.
  if (savedMap && S.doc && deckKey(st) && st.slide != null) {
    S.pendingSlideMap = null;
    if (savedMap.key === docKey(S.doc) && savedMap.deck === deckKey(st)) {
      try {
        S.slideMap = manualAlignment(S.doc, savedMap.text, st.total);
        S.builds?._enter(st.slide);
      } catch {}
    }
  }
  if (deckChanged && S.builds) {
    S.buildsPaused = true;
    S.builds._enter(st.slide);
    S.boundDeck = deckKey(st);
    S.importedSlides = null;
    S.semantic?.invalidate();
    toast('▶', uiLang() === 'zh' ? '幻灯片文档已切换，自动控制已暂停。请确认稿件和页码后恢复。' : 'Presentation changed. Automatic control paused; verify the script and slide before resuming.', { warn: true, ttl: 10000 });
  }
  if (!S.boundDeck && st.doc) S.boundDeck = deckKey(st);
  // a show starts with click markers in the script, but the Mac app cannot
  // see clicker keys yet: say so once
  if (st.playing && S.doc && S.doc.builds.length && deckMismatch() && S.mismatchHinted !== deckName(st.doc)) {
    S.mismatchHinted = deckName(st.doc);
    toast('▶', t('otherDeck')(S.docDeck, deckName(st.doc)), { ttl: 15000, warn: true, actions: [{ label: t('importNow'), run: () => importPlaying() }] });
  }
  if (st.playing && !wasPlaying && shell && S.inputAccess === false && S.doc && S.doc.builds.length && !S.accessHinted) {
    S.accessHinted = true;
    toast('▶', t('keysNeedAccess'), { ttl: 12000, warn: true, actions: [{ label: t('askAccess'), run: () => postShell({ type: 'cmd', cmd: 'ask-input-access' }) }] });
  }
  // the build controller first, so the follower's slide move finds it on the new slide
  if (S.builds) S.builds.slideState(slideAppControllable() ? st : { playing: false });
  const saved = S.pendingBuildRestore;
  if (saved && S.doc && st.playing && st.slide != null) {
    S.pendingBuildRestore = null;
    if (saved.key === docKey(S.doc) && saved.deck === deckKey(st) && Date.now() - saved.at < 15 * 60 * 1000) S.builds.restore(saved.slide, saved.done);
  }
  applyBuildFlags();
  updateSlideChip();
  shellState();
  const note = $('#slide-note');
  if (note) note.textContent = st.error ? st.error : st.source !== 'none' ? `${st.source}${st.running === false ? ' (not running)' : ''}${st.playing ? ' ▶' : ''}${st.doc ? ` · ${st.doc}` : ''}` : '';
  if (initial || deckChanged || deckMismatch() || !S.follower || st.slide == null || st.slide === prev) return;
  if (!settings.slideFollow) return;
  const r = slideRange(st.slide);
  if (r) S.follower.slideChanged(r.tokStart, r.tokEnd);
}

async function watchSlides(source) {
  settings.slides = source;
  saveSettings();
  await fetch('/api/slides/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
}

// Speech drives the show (Keynote/PowerPoint): builds at [click] markers and
// the next slide at the end of a slide's text. See lib/builds.js.
function slideAppControllable() {
  return !!(S.slide && (S.slide.source === 'keynote' || S.slide.source === 'powerpoint'));
}

function canDriveSlides() {
  return S.listening && !!S.controlId && S.engine?.name !== 'sim' && S.eventsConnected && slideAppControllable() && !S.slide?.error && !deckMismatch();
}

async function claimControls(engine) {
  engine.controllerId ||= globalThis.crypto.randomUUID();
  const res = await fetch('/api/slides/claim', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: engine.controllerId, pageId: S.pageId }) });
  const j = await res.json();
  if (!res.ok || j.owner !== engine.controllerId) throw new Error(j.error || 'Could not claim presentation control');
  if (S.engine !== engine || !S.listening) {
    fetch('/api/slides/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: engine.controllerId }) }).catch(() => {});
    return;
  }
  S.controlId = engine.controllerId;
  S.leaseAt = Date.now();
  applyBuildFlags();
}

async function slideControl(action, expected = {}) {
  if (!canDriveSlides()) throw new Error(uiLang() === 'zh' ? '演讲会话已停止或幻灯片状态不可用' : 'Session stopped or slide state unavailable');
  const res = await fetch('/api/slides/control', { method: 'POST', signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, owner: S.controlId, expected: { slide: expected.slide ?? S.slide.slide, doc: S.slide.doc, docId: S.slide.docId, source: S.slide.source } }) });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || `control ${res.status}`);
}

// A focused-window clicker may be used with recognition stopped. Borrow the
// active session's lease, or claim one for just this command; never optimistically
// count a rejected command as a successful build.
async function manualSlideControl(action) {
  if (S.manualControlPending || S.engine?.name === 'sim') return;
  if (!S.eventsConnected || !slideAppControllable() || !S.slide.playing || S.slide.error || deckMismatch()) {
    toast(t('slideSync'), uiLang() === 'zh' ? '幻灯片状态不可用，未发送翻页' : 'Slide state unavailable; no command sent');
    return;
  }
  const expected = { slide: S.slide.slide, doc: S.slide.doc, docId: S.slide.docId, source: S.slide.source };
  const sameSlide = () => S.eventsConnected && S.slide.playing && !S.slide.error && !deckMismatch()
    && S.slide.slide === expected.slide && S.slide.source === expected.source
    && S.slide.doc === expected.doc && S.slide.docId === expected.docId;
  const temporary = !S.controlId;
  const owner = S.controlId || globalThis.crypto.randomUUID();
  S.manualControlPending = true;
  try {
    if (temporary) {
      const claim = await fetch('/api/slides/claim', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner, pageId: S.pageId }) });
      const j = await claim.json();
      if (!claim.ok || j.owner !== owner) throw new Error(j.error || 'Could not claim presentation control');
    }
    if (!sameSlide() || S.engine?.name === 'sim') throw new Error('Slide state changed; no command sent');
    const res = await fetch('/api/slides/control', { method: 'POST', signal: AbortSignal.timeout(6000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, owner, expected }) });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `control ${res.status}`);
    if (sameSlide()) S.builds?.manual(action === 'next' ? 'next' : 'prev-slide');
  } catch (err) {
    S.buildsPaused = true;
    applyBuildFlags();
    toast(t('slideSync'), err.message);
  } finally {
    if (temporary) await fetch('/api/slides/release', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }) }).catch(() => {});
    S.manualControlPending = false;
  }
}

// A cheap identity for a script (to restore build counts after a reload).
function docKey(doc) {
  let h = 5381;
  const txt = S.docSource || '';
  const identity = `${S.docLang || doc.lang}\n${S.docDeckId || S.docDeck || ''}\n${txt}`;
  for (let i = 0; i < identity.length; i++) h = ((h * 33) ^ identity.charCodeAt(i)) >>> 0;
  return `${doc.tokens.length}:${h}`;
}

function saveBuildState() {
  if (!S.builds || !S.doc || !S.builds.playing) return;
  const st = S.builds.status();
  if (S.openingDoc) return;
  lsSet('tp.buildState', { key: docKey(S.doc), deck: deckKey(S.slide), slide: st.slide, done: st.done, at: Date.now() });
}

function applyBuildFlags() {
  if (!S.builds) return;
  const off = S.buildsPaused || deckMismatch() || !S.eventsConnected || S.engine?.name === 'sim' || !!S.slide?.error;
  S.builds.builds = settings.autoBuilds && !off;
  S.builds.advance = settings.autoAdvance && !off;
  S.builds.setListening(canDriveSlides());
  updateBuildUi();
}

// The script was imported from one Keynote document and another one is
// playing: its markers would click the wrong slides.
function deckMismatch() {
  const playing = S.slide && S.slide.source === 'keynote' && S.slide.doc ? deckName(S.slide.doc) : '';
  if (S.docDeckId && S.slide?.docId && S.slide.source === 'keynote') return S.docDeckId !== S.slide.docId;
  return !!(S.docDeck && playing && S.docDeck !== playing);
}

function buildChipText() {
  if (!S.builds || !S.doc || !slideAppControllable() || !S.slide || !S.slide.playing) return '';
  if (!settings.autoBuilds && !settings.autoAdvance) return '';
  const st = S.builds.status();
  if (st.error) return uiLang() === 'zh' ? '控制失败 · 点此恢复' : 'Control failed · resume';
  if (!S.eventsConnected || S.slide.error) return uiLang() === 'zh' ? '联动不可用' : 'Link unavailable';
  if (S.engine?.name === 'sim') return uiLang() === 'zh' ? '演练 · 不控制幻灯片' : 'Demo · slides isolated';
  if (S.buildsPaused) return t('buildChipOff');
  if (deckMismatch()) return t('buildChipOtherDeck');
  if (st.manual) return t('buildChipBack');
  if (!st.total) return settings.autoAdvance ? t('buildChipNone') : '';
  return t('buildChip')(st.done, st.total);
}

function updateBuildUi() {
  const chip = $('#chip-build');
  if (chip) {
    const txt = buildChipText();
    chip.hidden = !txt;
    chip.textContent = txt;
    chip.title = t('buildChipTip');
    const st = S.builds ? S.builds.status() : null;
    chip.classList.toggle('on', !!txt && !S.buildsPaused && !(st && st.manual));
    chip.classList.toggle('manual', !!txt && (S.buildsPaused || !!(st && st.manual)));
    if (txt !== S.lastBuildChip) {
      S.lastBuildChip = txt;
      shellState();
    }
  }
  if (S.renderer && S.builds && S.doc) {
    const doc = S.doc;
    const idx = slides();
    S.renderer.markBuilds((i) => S.builds.markerState(i, idx.slideOf(doc.builds[i])));
  }
}

function toggleBuildsPaused() {
  if (S.builds?.error) {
    S.builds.clearError();
    S.lastControlError = null;
    S.buildsPaused = false;
  } else {
  S.buildsPaused = !S.buildsPaused;
  }
  applyBuildFlags();
  toast('▶', t(S.buildsPaused ? 'buildsPaused' : 'buildsResumed'), { ttl: 2600 });
  shellState();
}

function updateBuildNote() {
  const e = $('#build-note');
  if (!e) return;
  e.innerHTML = '';
  const help = document.createElement('div');
  help.textContent = t('buildHelp');
  e.appendChild(help);
  if (!shell || S.inputAccess == null) return;
  const st = document.createElement('div');
  if (S.inputAccess) st.textContent = t('keysOk');
  else {
    st.textContent = `${t('keysNeedAccess')} `;
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = t('askAccess');
    b.onclick = () => postShell({ type: 'cmd', cmd: 'ask-input-access' });
    st.appendChild(b);
  }
  e.appendChild(st);
}

async function alignSlides() {
  const doc = S.doc;
  const source = scriptEl.value;
  const deck = deckKey(S.slide);
  const note = $('#slide-note');
  if (doc?.slides.length) return (note.textContent = uiLang() === 'zh' ? '稿件已有 [slide N] 标记，请直接校正这些标记。' : 'Edit the existing [slide N] markers in your script.');
  if (!jevAvailable()) return (note.textContent = t('noJev'));
  note.textContent = t('importing');
  try {
    let slides = S.importedSlides;
    if (!slides) {
      const j = await (await fetch('/api/slides/import')).json();
      if (j.error) throw new Error(j.error);
      slides = S.importedSlides = j.slides;
    }
    const res = await fetch('/api/slides/align', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: scriptEl.value, lang: langEl.value, slides: slides.filter((s) => !s.skipped) }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    if (S.doc !== doc || scriptEl.value !== source || deckKey(S.slide) !== deck) return;
    editSlideMap(j.mapping);
    note.textContent = (uiLang() === 'zh' ? '请校对后点击“应用”。' : 'Review and apply the proposed mapping.') +
      (j.needsReview ? (uiLang() === 'zh' ? ' 部分页置信度不足。' : ' Some slides have low confidence.') : '');
  } catch (err) {
    note.textContent = t('importFail') + err.message;
  }
}

function editSlideMap(mapping = S.slideMap) {
  if (!S.doc) return;
  S.buildsPaused = true;
  applyBuildFlags();
  S.mapDraftDoc = S.doc;
  S.mapDraftDeck = deckKey(S.slide);
  $('#map-editor').hidden = false;
  $('#map-input').value = (mapping || S.doc.slides.map(s => ({ n: s.n, para: S.doc.paras.find(p => p.tokStart >= s.tokStart)?.idx })))
    .filter(m => m.para != null && !m.noMatch).map(m => `${m.n}=${m.para + 1}`).join('\n');
  $('#map-paragraphs').textContent = S.doc.paras.filter(p => p.tokEnd > p.tokStart).map(p => `¶${p.idx + 1}: ${shorten(p.text, 60)}`).join('\n');
}

function applySlideMap() {
  const note = $('#slide-note');
  try {
    if (S.mapDraftDoc !== S.doc || S.mapDraftDeck !== deckKey(S.slide)) throw new Error(uiLang() === 'zh' ? '稿件或幻灯片已切换，请重新打开校对。' : 'Script or presentation changed; reopen the mapping editor.');
    if (S.doc.slides.length) throw new Error(uiLang() === 'zh' ? '这份稿件已有 [slide N] 标记，请直接在编辑页校正标记。' : 'This script has [slide N] markers; edit them in the script.');
    S.slideMap = manualAlignment(S.doc, $('#map-input').value, S.slide?.total);
    lsSet('tp.slideMap', { key: docKey(S.doc), deck: deckKey(S.slide), text: $('#map-input').value });
    S.pendingSlideMap = null;
    S.semantic?.invalidate();
    S.builds?._enter(S.slide.slide);
    const r = slideRange(S.slide.slide);
    if (r && settings.slideFollow) S.follower.slideChanged(r.tokStart, r.tokEnd);
    onView(S.follower.view());
    note.textContent = S.slideMap.map(m => `${m.n}→¶${m.para + 1}`).join('  ') + (uiLang() === 'zh' ? ' · 已暂停自动控制，确认后可恢复。' : ' · Automatic control paused; resume when ready.');
    $('#map-editor').hidden = true;
  } catch (err) { note.textContent = err.message; }
}

// ------------------------------------------------------------ settings UI

function applySettings() {
  const root = document.documentElement;
  // Floating over the presenter notes, the window is a short strip: fit
  // about four lines and raise the reading line.
  const floating = app.dataset.presenting === '1';
  const fs = floating ? Math.min(settings.fontSize, Math.max(22, Math.floor(window.innerHeight / 6))) : settings.fontSize;
  const rl = floating ? 0.34 : settings.readingLine;
  root.style.setProperty('--fs', `${fs}px`);
  root.style.setProperty('--lh', floating ? Math.min(settings.lineHeight, 1.4) : settings.lineHeight);
  root.style.setProperty('--rl', rl);
  app.dataset.theme = settings.theme;
  $('#prompter').classList.toggle('mirror', settings.mirror);
  $('#prompter').classList.toggle('flip', settings.flip);
  $('#hud-bottom').querySelector('#transcript').style.display = settings.transcript ? '' : 'none';
  if (S.renderer) {
    S.renderer.readingLine = rl;
    S.renderer.wordProgress = settings.wordProgress;
    S.renderer.relayout();
  }
  if (S.follower) S.follower.O.lookaheadSec = settings.lookahead;
  if (S.semantic) S.semantic.enabled = settings.semantic && jevAvailable();
}

function bindSettings() {
  const bind = (id, key, parse = (v) => v, prop = 'value') => {
    const e = $(id);
    e[prop] = settings[key];
    e.addEventListener('input', () => {
      settings[key] = parse(e[prop]);
      saveSettings();
      applySettings();
    });
  };
  bind('#set-font', 'fontSize', Number);
  bind('#set-lh', 'lineHeight', Number);
  bind('#set-rl', 'readingLine', Number);
  bind('#set-look', 'lookahead', Number);
  bind('#set-theme', 'theme');
  bind('#set-mirror', 'mirror', Boolean, 'checked');
  bind('#set-flip', 'flip', Boolean, 'checked');
  bind('#set-words', 'wordProgress', Boolean, 'checked');
  bind('#set-transcript', 'transcript', Boolean, 'checked');
  bind('#set-semantic', 'semantic', Boolean, 'checked');
  $('#set-semantic').addEventListener('input', () => {
    if (S.semantic) S.semantic.enabled = settings.semantic && jevAvailable();
    if (!settings.semantic) S.outlineRequest?.abort();
    else if (S.doc && !S.jevAnalysis) requestOutline(S.doc);
  });
  bind('#set-slidefollow', 'slideFollow', Boolean, 'checked');
  bind('#set-autoadvance', 'autoAdvance', Boolean, 'checked');
  bind('#set-autobuilds', 'autoBuilds', Boolean, 'checked');
  for (const id of ['#set-autoadvance', '#set-autobuilds']) $(id).addEventListener('input', () => applyBuildFlags());
  $('#chip-build').onclick = () => toggleBuildsPaused();
  bind('#set-reclang', 'recLang');
  const md = $('#set-math');
  md.value = settings.mathDisplay;
  md.addEventListener('change', () => {
    settings.mathDisplay = md.value;
    saveSettings();
    if (S.renderer) S.renderer.setMathMode(md.value);
  });
  const eng = $('#set-engine');
  eng.value = settings.engine;
  eng.addEventListener('change', () => {
    settings.engine = eng.value;
    saveSettings();
    updateNativeNote();
    if (S.listening) {
      stopListening();
      startListening();
    }
  });
  const sl = $('#set-slides');
  sl.value = settings.slides;
  sl.addEventListener('change', () => {
    settings.slidesChosen = true;
    watchSlides(sl.value);
  });
  $('#btn-align').onclick = alignSlides;
  $('#btn-map').onclick = () => editSlideMap();
  $('#btn-map-apply').onclick = applySlideMap;
  const linkKeynote = () => {
    $('#set-slides').value = 'keynote';
    settings.slidesChosen = true;
    watchSlides('keynote');
    toast('Keynote', t('linkedKeynote'), { ttl: 9000 });
  };
  $('#btn-link-keynote').onclick = linkKeynote;
  $('#btn-editor-link').onclick = () => {
    if (linked()) {
      settings.slidesChosen = true;
      $('#set-slides').value = 'none';
      watchSlides('none');
    } else linkKeynote();
  };
  const det = $('#detail');
  det.value = settings.detail;
  det.addEventListener('input', () => setDetail(Number(det.value)));
  $('#btn-reset').onclick = () => resetTake();
}

function updateNativeNote() {
  const e = $('#native-note');
  const n = S.health && S.health.native;
  e.innerHTML = '';
  if (settings.engine !== 'native' && settings.engine !== 'auto') return;
  if (!n || !n.built) {
    if (settings.engine === 'native') e.textContent = t('nativeMissing');
    return;
  }
  const lang = recLang();
  const inst = n.locales && n.locales.installed;
  if (inst && !inst.includes(lang) && n.locales.supported && n.locales.supported.includes(lang)) {
    e.textContent = `${t('nativeNeedsModel')(lang)} `;
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = t('installModel');
    b.onclick = async () => {
      b.disabled = true;
      await fetch('/api/asr/native/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: lang }) });
    };
    e.appendChild(b);
  }
}

// ---------------------------------------------------------------- demo

function demoPerformance(kind) {
  const doc = S.doc;
  const last = doc.phrases.length - 1;
  if (kind === 'read') return [{ read: [0, last] }];
  const a = Math.min(last, 6);
  const b = Math.min(last, a + 4);
  const c = Math.min(last, b + 4);
  const adlib = doc.lang === 'zh'
    ? '这里我插一句我自己的经历上学期我在课上试过这个方法效果比想象的要好'
    : 'let me add a quick story here last semester I tried this in class and it worked better than I expected';
  return [
    { read: [0, a] }, { say: adlib }, { read: [a + 1, b] }, { pause: 2500 },
    { read: [c, last] },
  ];
}

// Start over: position, timer, transcript and reminders (a new take).
function resetTake() {
  if (!S.follower) return;
  S.semantic?.invalidate();
  S.follower.reset(0);
  if (S.listening) S.follower.armListening();
  S.timerAcc = 0;
  S.timerStart = S.listening ? Date.now() : 0;
  transcript.fin = '';
  transcript.int = '';
  renderTranscript();
  S.toastedLabels.clear();
  S.prevLabel = null;
  S.lastReminder = null;
  if (S.semantic) S.semantic.knownSkipped.clear();
  onView(S.follower.view());
}

function runDemo(kind) {
  if (!S.doc) return;
  if (S.listening) stopListening();
  resetTake();
  S.engine = makeEngine('sim');
  S.listening = true;
  S.semantic?.resume();
  applyBuildFlags();
  setListeningUi(true);
  S.watchdogDone = true;
  if (!S.timerStart) S.timerStart = Date.now();
  S.follower.armListening();
  S.engine.play(demoPerformance(kind), { speed: Number($('#sim-speed').value) || 1, errRate: 0.04, seed: Date.now() % 1000 });
}

// ---------------------------------------------------------------- keys

document.addEventListener('keydown', (e) => {
  if (app.dataset.view !== 'prompter') return;
  const tgt = e.target;
  if (tgt && tgt.matches && tgt.matches('input, textarea, select')) {
    if (e.key === 'Escape') tgt.blur();
    return;
  }
  const f = S.follower;
  const doc = S.doc;
  if (!f) return;
  const cur = f.currentPhrase();
  const k = e.key;
  // A clicker sends PageDown/PageUp. During a Keynote/PowerPoint show they
  // belong to the slides even when this window has focus.
  if ((k === 'PageDown' || k === 'PageUp') && S.engine?.name !== 'sim' && S.slide && S.slide.playing && (S.slide.source === 'keynote' || S.slide.source === 'powerpoint')) {
    e.preventDefault();
    manualSlideControl(k === 'PageDown' ? 'next' : 'prev');
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    toggleListening();
  } else if (k === 'ArrowRight' || k === 'PageDown' || k === 'ArrowLeft' || k === 'PageUp') {
    e.preventDefault();
    const fwd = k === 'ArrowRight' || k === 'PageDown';
    if (S.level >= 2) {
      // step through what is visible (points, bullets, headings)
      const starts = S.renderer.itemStarts();
      const next = fwd ? starts.find((x) => x > f.pos) : [...starts].reverse().find((x) => x < f.pos);
      if (next !== undefined) f.jumpTo(next);
    } else {
      const ph = doc.phrases[fwd ? Math.min(doc.phrases.length - 1, cur + 1) : Math.max(0, cur - 1)];
      f.jumpTo(ph.tokStart);
    }
  } else if (k === 'ArrowDown') {
    e.preventDefault();
    const para = doc.paras[doc.phrases[cur].para + 1];
    if (para) f.jumpTo(para.tokStart);
  } else if (k === 'ArrowUp') {
    e.preventDefault();
    const pi = doc.phrases[cur].para;
    const para = doc.paras[f.pos > doc.paras[pi].tokStart + 2 ? pi : Math.max(0, pi - 1)];
    f.jumpTo(para.tokStart);
  } else if (k === ',') setDetail(settings.detail - 0.1);
  else if (k === '.') setDetail(settings.detail + 0.1);
  else if (k === '[') setLevel(S.level - 1);
  else if (k === ']') setLevel(S.level + 1);
  else if (k >= '1' && k <= '5') setLevel(+k - 1);
  else if (k === '+' || k === '=') {
    settings.fontSize = Math.min(110, settings.fontSize + 2);
    $('#set-font').value = settings.fontSize;
    saveSettings();
    applySettings();
  } else if (k === '-') {
    settings.fontSize = Math.max(22, settings.fontSize - 2);
    $('#set-font').value = settings.fontSize;
    saveSettings();
    applySettings();
  } else if (k === 'm' || k === 'M') {
    settings.mirror = !settings.mirror;
    $('#set-mirror').checked = settings.mirror;
    saveSettings();
    applySettings();
  } else if (k === 't' || k === 'T') {
    settings.transcript = !settings.transcript;
    $('#set-transcript').checked = settings.transcript;
    saveSettings();
    applySettings();
  } else if ((k === 'b' || k === 'B') && S.lastReminder && Date.now() - S.lastReminder.at < 60000) {
    f.jumpTo(S.lastReminder.target);
    S.lastReminder = null;
  } else if ((k === 'f' || k === 'F') && shell) {
    postShell({ type: 'cmd', cmd: 'toggle-present' });
  } else if (k === 'f' || k === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('!', t('noFullscreen'), { warn: true }));
  } else if (k === 'Escape') {
    if (!$('#settings').hidden || !$('#simpanel').hidden) {
      $('#settings').hidden = true;
      $('#simpanel').hidden = true;
    } else if (S.listening && !(S.escAt && Date.now() - S.escAt < 2500)) {
      // a stray Esc (clickers, Keynote habits) must not end the session
      S.escAt = Date.now();
      toast('Esc', t('escAgain'), { ttl: 2500 });
    } else {
      S.escAt = 0;
      backToEditor();
    }
  }
});

function backToEditor() {
  stopListening();
  app.dataset.view = 'editor';
  shellState();
}

// ---------------------------------------------------------------- wiring

function wire() {
  // Buttons keep focus after a click, and Space would click them again on
  // top of our shortcut; hand focus back to the prompter instead.
  $('#prompter').addEventListener('click', (e) => {
    if (e.target.closest('button')) setTimeout(() => $('#prompter').focus({ preventScroll: true }), 0);
  });
  scriptEl.addEventListener('input', () => {
    editorMsg('');
    saveDraftSoon();
  });
  titleEl.addEventListener('input', saveDraftSoon);
  langEl.addEventListener('change', saveDraftSoon);
  $('#btn-new').onclick = () => {
    if (confirmDiscard()) loadIntoEditor({ id: null, title: '', lang: 'auto', text: '' });
  };
  for (const b of document.querySelectorAll('[data-sample]')) b.onclick = () => loadSample(b.dataset.sample);
  $('#btn-save').onclick = saveScript;
  $('#btn-start').onclick = startPrompter;
  $('#btn-import-keynote').onclick = importKeynote;
  $('#btn-ui-lang').onclick = () => {
    settings.uiLang = uiLang() === 'zh' ? 'en' : 'zh';
    settings.uiLangChosen = true;
    setUiLang(settings.uiLang);
    saveSettings();
    applyI18n();
  };
  $('#btn-back').onclick = backToEditor;
  $('#btn-mic').onclick = toggleListening;
  $('#start-hint').onclick = () => startListening();
  $('#btn-settings').onclick = () => {
    $('#simpanel').hidden = true;
    $('#settings').hidden = !$('#settings').hidden;
    updateNativeNote();
    updateBuildNote();
  };
  $('#btn-demo').onclick = () => {
    $('#settings').hidden = true;
    $('#simpanel').hidden = !$('#simpanel').hidden;
  };
  $('#sim-read').onclick = () => runDemo('read');
  $('#sim-story').onclick = () => runDemo('story');
  $('#sim-stop').onclick = () => stopListening();
  $('#sim-say').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !S.doc) return;
    const text = e.target.value.trim();
    e.target.value = '';
    if (!text) return;
    if (!S.engine || S.engine.name !== 'sim') {
      stopListening();
      S.engine = makeEngine('sim');
      S.listening = true;
      setListeningUi(true);
      S.watchdogDone = true;
      S.follower.armListening();
    }
    S.engine.say(text);
  });
}

async function init() {
  wire();
  bindSettings();
  applySettings();
  applyI18n();
  await loadHealth();
  applySettings();
  connectEvents();
  if (shell && !settings.slidesChosen && settings.slides === 'none') {
    // the Mac app exists to sit on top of the slide show: link Keynote
    settings.slides = 'keynote';
    $('#set-slides').value = 'keynote';
    saveSettings();
    setTimeout(() => toast('Keynote', t('linkedKeynote'), { ttl: 9000 }), 800);
  }
  if (settings.slides && settings.slides !== 'none') watchSlides(settings.slides);
  const d = lsGet('tp.draft', null);
  if (d && d.text) {
    titleEl.value = d.title || '';
    langEl.value = d.lang || 'auto';
    scriptEl.value = d.text;
    S.scriptDeck = d.deck || null;
    S.scriptDeckId = d.deckId || null;
    S.savedText = d.dirty ? '' : d.text;
    S.savedMeta = { title: titleEl.value.trim(), lang: langEl.value };
  } else {
    await loadSample(uiLang() === 'zh' ? 'zh-demo.md' : 'en-demo.md', false);
  }
  refreshList();
  // URL options for launchers and automated tests:
  //   ?sample=en-demo.md&start=1&listen=1&engine=webspeech&level=0
  const params = new URLSearchParams(location.search);
  if (params.get('engine')) settings.engine = params.get('engine');
  if (params.get('sample')) await loadSample(params.get('sample'), false);
  if (params.get('level')) settings.level = +params.get('level');
  if (params.has('start')) {
    startPrompter();
    if (params.has('listen')) setTimeout(() => startListening(), 300);
  }
}

init();

// exposed for automated acceptance tests
S.api = { startPrompter, setLevel, runDemo, startListening, stopListening, toggleListening, onSpeech, backToEditor, openDoc, textOfPhrases, settings };

// called by the native shell
window.tpShell = {
  presenting(on) {
    app.dataset.presenting = on ? '1' : '0';
    applySettings();
    shellState();
    if (!on) toast('⬇︎', t('floatOff'), { ttl: 2000 });
  },
  toggleListening() {
    if (app.dataset.view !== 'prompter') startPrompter();
    toggleListening();
  },
  ready() {
    shellState();
  },
  // Clicker / keyboard / mouse input to the slide show during a show:
  // 'next' | 'prev-build' | 'prev-slide' | 'next-slide' | 'jump'
  manualInput(kind) {
    if (S.builds && slideAppControllable()) S.builds.manual(kind);
  },
  // whether the shell may see key presses (Accessibility permission)
  inputAccess(ok) {
    S.inputAccess = !!ok;
    updateBuildNote();
  },
  toggleBuilds() {
    toggleBuildsPaused();
  },
};
if (shell) {
  document.documentElement.classList.add('in-shell');
  setTimeout(shellState, 500);
  window.addEventListener('resize', () => { if (app.dataset.presenting === '1') applySettings(); });
  // the title bar shows the timer while floating
  setInterval(() => { if (app.dataset.presenting === '1') shellState(); }, 1000);
}
clientLog('page-load', shell ? 'mac-app' : 'browser');
