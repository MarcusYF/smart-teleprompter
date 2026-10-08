// Actual app controller wiring, with a minimal DOM; no microphone, GUI or API costs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './helpers/app-harness.mjs';
const SCRIPT = '[slide 1]\nAlpha beta gamma delta.\n[click x3] Epsilon zeta eta theta.\n\n[slide 2]\nIota kappa lambda mu.';
const setup = async t => {
  const old = globalThis.fetch, h = await appHarness();
  t.after(() => { h.close(); globalThis.fetch = old; });
  h.el('#script').value = SCRIPT; h.el('#script-lang').value = 'en';
  h.evaluate("S.slide = {source:'keynote', playing:true, slide:1, total:2, doc:'Deck A'}; S.api.startPrompter();");
  return h;
};

test('reload reads saved build counts before any initialization writes', async t => {
  const h = await setup(t);
  h.evaluate('S.builds.restore(1, 2); saveBuildState();');
  assert.equal(JSON.parse(h.storage.get('tp.buildState')).done, 2);
  h.evaluate('S.api.openDoc(parseScript(S.docSource, {lang:"en"}));');
  assert.equal(h.evaluate('S.builds.status().done'), 2);
  assert.equal(JSON.parse(h.storage.get('tp.buildState')).done, 2);
});

test('native failure clears listening UI, timer and engine', async t => {
  const h = await setup(t); h.evaluate('settings.engine="native";');
  await h.evaluate('startListening()');
  h.evaluate('S.engine.handle({type:"status",state:"stopped",code:7,detail:"microphone denied",sessionId:S.engine.sessionId})');
  assert.equal(h.evaluate('S.listening'), false);
  assert.equal(h.evaluate('S.engine'), null);
  assert.equal(h.evaluate('S.timerStart'), 0);
  assert.equal(h.el('#app').dataset.listening, '0');
});

test('simulation never calls real slide control, including periodic retries', async t => {
  const h = await setup(t); h.evaluate('settings.engine="sim";');
  await h.evaluate('startListening()');
  h.evaluate('onSpeech("final", "Alpha beta gamma delta."); S.builds.tick(canDriveSlides());');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.requests.filter(r => r.url === '/api/slides/control').length, 0);
  assert.equal(h.evaluate('S.builds.status().done'), 0);
});

test('save failure preserves dirty edits and shows the actual error', async t => {
  const h = await setup(t);
  h.el('#script').value += '\nUnsaved changes.';
  h.context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'disk full' }) });
  await h.evaluate('saveScript()');
  assert.match(h.el('#editor-msg').textContent, /disk full/);
  assert.equal(h.evaluate('isDirty()'), true);
  assert.equal(h.evaluate('S.scriptId'), null);
});

test('old recognizer callbacks cannot advance a replacement document', async t => {
  const h = await setup(t); h.evaluate('settings.engine="sim";');
  await h.evaluate('startListening()');
  h.evaluate('window.oldEngine = S.engine; openDoc(parseScript("Replacement script with other words.", {lang:"en"}));');
  h.evaluate('window.oldEngine.onFinal("Replacement script with other words.");');
  assert.equal(h.evaluate('S.follower.pos'), 0);
  assert.equal(h.evaluate('S.listening'), false);
});

test('switching decks on the same page pauses controls and invalidates imports', async t => {
  const h = await setup(t);
  h.evaluate("S.builds.restore(1, 2); S.importedSlides = [{n:1}]; onSlideState({source:'keynote', playing:true, slide:1, total:2, doc:'Deck B'});");
  assert.equal(h.evaluate('S.buildsPaused'), true);
  assert.equal(h.evaluate('S.builds.done'), 0);
  assert.equal(h.evaluate('S.importedSlides'), null);
});

test('SSE disconnect stops native recognition and cancels pending controls', async t => {
  const h = await setup(t); h.evaluate('settings.engine="native";');
  await h.evaluate('startListening()');
  h.events.get('error')();
  assert.equal(h.evaluate('S.eventsConnected'), false);
  assert.equal(h.evaluate('S.listening'), false);
  assert.equal(h.evaluate('canDriveSlides()'), false);
});

test('a new editor document cannot reuse the last deck import', async t => {
  const h = await setup(t);
  h.evaluate('S.importedSlides=[{n:1}]; loadIntoEditor({text:"A different saved script.",lang:"en"});');
  assert.equal(h.evaluate('S.importedSlides'), null);
});

test('semantic switch cancels in-flight work immediately', async t => {
  const h = await setup(t);
  h.evaluate('S.semantic.enabled=true; S.semantic.resume(); S.semantic.enabled=false;');
  assert.equal(h.evaluate('S.semantic.requests.size'), 0);
  assert.equal(h.evaluate('S.semantic.enabled'), false);
});

test('late initial slideshow state restores reload counts once', async t => {
  const h = await setup(t);
  h.evaluate('S.builds.restore(1,2); saveBuildState(); S.slide={source:"none"}; openDoc(parseScript(S.docSource,{lang:"en"}));');
  h.evaluate('onSlideState({source:"keynote",playing:true,slide:1,total:2,doc:"Deck A"},true)');
  assert.equal(h.evaluate('S.builds.status().done'), 2);
  h.evaluate('S.builds.manual("next"); onSlideState({source:"keynote",playing:true,slide:1,total:2,doc:"Deck A"});');
  assert.equal(h.evaluate('S.builds.status().done'), 3);
});

test('different documents with the same name pause control using Keynote document IDs', async t => {
  const h = await setup(t);
  h.evaluate('S.slide.docId="id-a"; S.docDeckId="id-a"; onSlideState({source:"keynote",playing:true,slide:1,total:2,doc:"Deck A",docId:"id-b"});');
  assert.equal(h.evaluate('deckMismatch()'), true);
  assert.equal(h.evaluate('S.buildsPaused'), true);
});

test('a lease conflict prevents starting a second native recognizer', async t => {
  const h = await setup(t); h.evaluate('settings.engine="native";');
  h.context.fetch = async (url, opts) => url === '/api/slides/claim' ? { ok: false, status: 409, json: async () => ({ error: 'Another window is controlling' }) } : h.stubFetch(url, opts);
  await h.evaluate('startListening()');
  assert.equal(h.evaluate('S.listening'), false);
  assert.equal(h.requests.filter(r => r.url === '/api/asr/native/start').length, 0);
});

test('reviewed manual mappings save and restore, while editing pauses control', async t => {
  const h = await setup(t);
  h.el('#script').value = 'First topic begins here.\n\nSecond topic begins here.';
  h.evaluate('startPrompter(); editSlideMap();');
  assert.equal(h.evaluate('S.buildsPaused'), true);
  h.el('#map-input').value = '1=1\n2=2'; h.evaluate('applySlideMap()');
  assert.equal(h.evaluate('S.slideMap.length'), 2);
  h.evaluate('openDoc(parseScript(S.docSource,{lang:"en"}))');
  assert.equal(h.evaluate('S.slideMap.length'), 2);
});

test('title-only edits and language changes remain dirty until saved', async t => {
  const h = await setup(t);
  h.evaluate('loadIntoEditor({text:"Some saved words.",title:"Original",lang:"en"});');
  assert.equal(h.evaluate('isDirty()'), false);
  h.el('#title').value = 'Changed title'; assert.equal(h.evaluate('isDirty()'), true);
  h.el('#title').value = 'Original'; h.el('#script-lang').value = 'zh'; assert.equal(h.evaluate('isDirty()'), true);
});

test('display levels announce Jev analysis only while an enabled request is pending', async t => {
  const h = await setup(t);
  h.evaluate('S.health.jev.available=true; settings.semantic=false; S.outlinePending=true; setLevel(1)');
  assert.equal(h.el('#toasts').children.length, 0);
  h.evaluate('settings.semantic=true; S.outlinePending=false; setLevel(2)');
  assert.equal(h.el('#toasts').children.length, 0);
  h.evaluate('S.outlinePending=true; setLevel(3)');
  assert.equal(h.el('#toasts').children.length, 1);
});

test('failed outline requests clear the pending state and retain local analysis', async t => {
  const h = await setup(t);
  h.evaluate('S.health.jev.available=true; settings.semantic=true;');
  h.context.fetch = async () => ({ ok:false, status:503, json:async () => ({error:'offline'}) });
  await h.evaluate('requestOutline(S.doc)');
  assert.equal(h.evaluate('S.outlinePending'), false);
  assert.equal(h.evaluate('S.jevAnalysis'), null);
});

test('focused-window clicker claims and releases control even with recognition stopped', async t => {
  const h = await setup(t);
  h.context.fetch = async (url, opts) => url === '/api/slides/control'
    ? (h.requests.push({url, opts}), {ok:true, json:async () => ({ok:true})}) : h.stubFetch(url, opts);
  await h.evaluate('manualSlideControl("next")');
  const claim = JSON.parse(h.requests.find(r => r.url === '/api/slides/claim').opts.body);
  const control = JSON.parse(h.requests.find(r => r.url === '/api/slides/control').opts.body);
  assert.equal(control.owner, claim.owner);
  assert.deepEqual(control.expected, {slide:1, doc:'Deck A', source:'keynote'});
  assert.equal(h.evaluate('S.builds.status().done'), 1);
  assert.equal(h.evaluate('S.listening'), false);
  assert.equal(JSON.parse(h.requests.find(r => r.url === '/api/slides/release').opts.body).owner, claim.owner);
});

test('a rejected clicker command pauses automation without incrementing builds', async t => {
  const h = await setup(t);
  h.evaluate('S.controlId="active-owner"');
  h.context.fetch = async (url, opts) => url === '/api/slides/control'
    ? (h.requests.push({url, opts}), {ok:false, status:409, json:async () => ({error:'Stale slide'})}) : h.stubFetch(url, opts);
  await h.evaluate('manualSlideControl("next")');
  assert.equal(h.evaluate('S.builds.status().done'), 0);
  assert.equal(h.evaluate('S.buildsPaused'), true);
  assert.equal(h.requests.filter(r => r.url === '/api/slides/claim' || r.url === '/api/slides/release').length, 0);
  assert.equal(JSON.parse(h.requests.find(r => r.url === '/api/slides/control').opts.body).owner, 'active-owner');
});

test('a deck change while claiming a clicker lease prevents the command', async t => {
  const h = await setup(t);
  h.context.fetch = async (url, opts) => {
    if (url === '/api/slides/claim') {
      h.evaluate('S.slide.doc="Deck B"');
    }
    return h.stubFetch(url, opts);
  };
  await h.evaluate('manualSlideControl("next")');
  assert.equal(h.requests.filter(r => r.url === '/api/slides/control').length, 0);
  assert.equal(h.requests.filter(r => r.url === '/api/slides/release').length, 1);
});

test('simulation PageDown steps the script without touching a real running show', async t => {
  const h = await setup(t);
  h.evaluate('S.engine={name:"sim", stop(){}}');
  h.documentEvents.get('keydown')({key:'PageDown', target:{matches:() => false}, preventDefault(){}});
  await new Promise(r => setTimeout(r, 10));
  assert.ok(h.evaluate('S.follower.pos') > 0);
  assert.equal(h.requests.filter(r => r.url.startsWith('/api/slides/') && r.url !== '/api/slides/watch').length, 0);
});

test('reviewed mappings restore when document identity arrives before starting a show', async t => {
  const h = await setup(t);
  h.el('#script').value = 'First topic begins here.\n\nSecond topic begins here.';
  h.evaluate('startPrompter(); editSlideMap();');
  h.el('#map-input').value = '1=1\n2=2'; h.evaluate('applySlideMap()');
  h.evaluate('S.slide={source:"none"}; openDoc(parseScript(S.docSource,{lang:"en"}));');
  assert.equal(h.evaluate('S.slideMap'), null);
  h.evaluate('onSlideState({source:"keynote",playing:false,slide:1,total:2,doc:"Deck A"})');
  assert.equal(h.evaluate('S.slideMap.length'), 2);
  h.evaluate('onSlideState({source:"keynote",playing:false,slide:1,total:2,doc:"Deck B"})');
  assert.equal(h.evaluate('S.slideMap'), null);
  assert.equal(h.evaluate('S.buildsPaused'), true);
});
