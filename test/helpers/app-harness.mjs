import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const root = new URL('../../', import.meta.url).pathname;
const mod = (path) => import(pathToFileURL(`${root}/${path}`));
const { parseScript, distinctiveTerms, textOfPhrases } = await mod('public/lib/script.js');
const { Follower } = await mod('public/lib/follower.js');
const { BuildController, slideIndex } = await mod('public/lib/builds.js');
const { SemanticClient } = await mod('public/lib/semantic-client.js');
const { heuristicAnalysis, mergeAnalysis, outlineItems } = await mod('public/lib/outline.js');
const { WebSpeechEngine, NativeEngine, SimEngine, MicMeter, Vad } = await mod('public/lib/engines.js');
const { t, setUiLang, uiLang } = await mod('public/lib/i18n.js');
const { manualAlignment } = await mod('public/lib/alignment.js');
class Elem {
  constructor() { this.dataset = {}; this.style = { setProperty() {} }; this.children = []; this.options = Array.from({length:4}, () => ({value:'auto'})); this.value = ''; this.hidden = true; this.classList = { toggle() {}, add() {}, remove() {} }; }
  addEventListener() {} focus() {} remove() {} blur() {} appendChild(e) { this.children.push(e); return e; } append(...es) { this.children.push(...es); }
  querySelector() { return new Elem(); } querySelectorAll() { return []; } getContext() { return { clearRect() {}, fillRect() {} }; }
  set innerHTML(v) { this._html = v; this.children = []; } get innerHTML() { return this._html || ''; }
  set value(v) { this._value = String(v); } get value() { return this._value; }
}
class StubRenderer {
  constructor() {} setDoc(doc) { this.doc = doc; } setAnalysis() {} setLevel() {} setDetail() {} update() {} relayout() {} markBuilds() {} setMathMode() {}
}

export async function appHarness() {
const elements = new Map(); const el = (s) => { if (!elements.has(s)) elements.set(s, new Elem()); return elements.get(s); };
el('#app').dataset.view = 'editor'; el('#script-lang').value = 'en';
const storage = new Map(); const requests = []; const events = new Map(); const documentEvents = new Map();
const stubFetch = async (url, opts) => { requests.push({ url, opts }); return { ok: true, status: 200, json: async () => url === '/api/health' ? { jev: { available: false } } : url === '/api/scripts' ? [] : url === '/api/slides/claim' ? { ok: true, owner: JSON.parse(opts.body).owner } : {}, text: async () => 'Review sample words.' }; };
globalThis.fetch = stubFetch;
const context = vm.createContext({
  parseScript, distinctiveTerms, textOfPhrases, Follower, Renderer: StubRenderer,
  BuildController, slideIndex, SemanticClient, heuristicAnalysis, mergeAnalysis,
  manualAlignment,
  WebSpeechEngine, NativeEngine, SimEngine, MicMeter, Vad, t, setUiLang, uiLang,
  window: { addEventListener() {}, innerHeight: 900 }, document: { querySelector: el, querySelectorAll: () => [], addEventListener: (name, cb) => documentEvents.set(name, cb), createElement: () => new Elem(), documentElement: new Elem() },
  localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) },
  performance, Date, URLSearchParams, location: { search: '' }, console,
  setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout, setInterval: () => 0, requestAnimationFrame: (cb) => cb(), confirm: () => true,
  EventSource: class { addEventListener(name, cb) { events.set(name, cb); } close() {} },
  AbortController,
  AbortSignal,
  crypto: globalThis.crypto,
  fetch: stubFetch,
});
vm.runInContext(readFileSync(`${root}/public/app.js`, 'utf8').replace(/^import .*;\n/gm, ''), context);

 await new Promise(r => setTimeout(r, 10));
 const evaluate = code => vm.runInContext(code, context);
 evaluate('S.eventsConnected = true');
 return { evaluate, el, storage, requests, context, events, documentEvents, stubFetch, close: () => evaluate('stopListening(); S.semantic?.dispose(); S.builds?.dispose();') };
}
