// Local teleprompter server (no dependencies). Serves the UI, proxies Jev
// judgments (the API key never reaches the browser), relays slide-show state
// and the on-device recognizer over Server-Sent Events, and stores scripts.
//
//   node server/main.mjs            -> http://127.0.0.1:5217

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

import { apiKey, usageSummary, JEV_MODEL } from './jev.mjs';
import { trackJudgment, skippedJudgment, analyzeOutline, alignSlides } from './semantic.mjs';
import { JsonCache, ScriptStore } from './store.mjs';
import { Slides, scriptFromSlides, cleanSlideText } from './slides.mjs';
import { NativeAsr } from './native-asr.mjs';
import { parseScript, distinctiveTerms } from '../public/lib/script.js';
import { checkRequest } from './request-security.mjs';
import { ControlLease } from './control-lease.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.TELEPROMPTER_DATA || join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '5217', 10);
const HOST = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error('Teleprompter must bind to a loopback host');

mkdirSync(join(DATA, 'cache'), { recursive: true });
const cache = new JsonCache(join(DATA, 'cache', 'jev-cache.json'));
const scripts = new ScriptStore(join(DATA, 'scripts'));
const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const slides = new Slides();
const native = new NativeAsr(join(ROOT, 'native', 'build', 'tp-asr'));
const controlLease = new ControlLease();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ SSE

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
slides.on('state', (st) => broadcast('slide', st));
native.on('msg', (m) => broadcast('asr', m));
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

// ------------------------------------------------------------- helpers

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch {
    throw Object.assign(new Error('Invalid JSON object'), { status: 400 });
  }
}

// Only the slide-state endpoint is open to other local pages (browser decks).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  p = normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, 'not found');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

// ------------------------------------------------------------- routes

const routes = {
  'GET /api/ping': async () => ({ ok: true, app: 'smart-teleprompter', version, instance: process.env.TELEPROMPTER_INSTANCE || null }), // shell watchdog; no model scans
  'GET /api/health': async () => {
    const k = await apiKey();
    // installed on-device languages can change (model downloads); refresh
    if (native.built && (!native.locales || Date.now() - (native.listedAt || 0) > 60000)) await native.listLocales();
    return { ok: true, jev: { available: !!k.key, source: k.source, model: JEV_MODEL, usage: usageSummary() }, native: native.status(), slides: slides.state, platform: process.platform };
  },

  // Off-script judgment while speaking.
  'POST /api/jev/track': async (body, _req, signal) => trackJudgment(body, { signal }),

  'POST /api/jev/skipped': async (body, _req, signal) => skippedJudgment(body, { signal }),

  // Outline analysis for a script (cached per paragraph).
  'POST /api/outline': async (body, _req, signal) => {
    const doc = parseScript(body.text || '', { lang: body.lang, title: body.title });
    const t0 = Date.now();
    const out = await analyzeOutline(doc, cache, { signal });
    return { ...out, ms: Date.now() - t0, usage: usageSummary() };
  },

  'GET /api/slides/state': async () => slides.state,
  'POST /api/slides/watch': async (body) => slides.watch(body.source || 'none'),
  'POST /api/slides/state': async (body) => slides.external(body),
  'POST /api/slides/claim': async (body) => controlLease.claim(body.owner, body.pageId),
  'POST /api/slides/release': async (body) => { controlLease.release(body.owner); return { ok: true }; },
  'POST /api/slides/control': async (body) => {
    if (!body.expected || !Number.isInteger(body.expected.slide)) throw Object.assign(new Error('Expected slide state required'), { status: 400 });
    controlLease.assert(body.owner);
    return { ok: await slides.control(body.action, body.expected) };
  },
  'GET /api/slides/import': async () => {
    const data = await slides.importKeynote();
    if (data.error) return data;
    data.slides = data.slides.map((s) => ({ ...s, title: cleanSlideText(s.title), body: cleanSlideText(s.body), notes: cleanSlideText(s.notes) }));
    return { ...data, script: scriptFromSlides(data.slides) };
  },
  'POST /api/slides/align': async (body, _req, signal) => {
    const doc = parseScript(body.text || '', { lang: body.lang });
    return alignSlides(doc, body.slides || [], { signal });
  },

  'GET /api/asr/native/status': async () => {
    if (native.built) await native.listLocales();
    return native.status();
  },
  'POST /api/asr/native/start': async (body) => {
    controlLease.assert(body.owner);
    if (body.pageId !== controlLease.current.pageId) throw Object.assign(new Error('Recognition page does not own this session'), { status: 409 });
    let terms = body.terms || [];
    if (!terms.length && body.text) terms = distinctiveTerms(parseScript(body.text, { lang: body.lang }));
    let file = null;
    if (body.testAudioPath) file = body.testAudioPath; // local testing only
    if (body.sessionId && !/^[\w-]{1,64}$/.test(body.sessionId)) throw Object.assign(new Error('Invalid recognizer session'), { status: 400 });
    return native.start({ locale: body.locale || 'en-US', terms, file, rate: body.rate || 1, pageId: body.pageId, ...(body.sessionId ? { sessionId: body.sessionId } : {}) });
  },
  'POST /api/asr/native/stop': async (body) => {
    native.stop(body.sessionId);
    return native.status();
  },
  'POST /api/asr/native/install': async (body) => native.install(body.locale || 'zh-CN'),

  // engine state from the page (no transcripts), for diagnosing setups
  'POST /api/log': async (body) => {
    console.log(`[client] ${new Date().toISOString()} ${String(body.event || '').slice(0, 40)} ${String(body.engine || '')} ${String(body.detail || '').slice(0, 200)}`);
    return { ok: true };
  },

  'GET /api/scripts': async () => scripts.list(),
  'POST /api/scripts': async (body) => scripts.save(body),
};

async function handle(req, res) {
  const rejection = checkRequest(req, req.socket?.localPort || PORT);
  if (rejection) return send(res, rejection.status, { error: rejection.error });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') return pathname === '/api/slides/state' ? send(res, 204, '', CORS) : send(res, 403, { error: 'Cross-origin access denied' });

  if (pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ slides: slides.state, native: native.status() })}\n\n`);
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
      const pageId = url.searchParams.get('pageId');
      controlLease.disconnect(pageId);
      if (pageId && native.ownerPageId === pageId) native.stop(native.sessionId);
      lastActivity = Date.now();
    });
    return;
  }

  const m = pathname.match(/^\/api\/scripts\/([\w-]+)$/);
  if (m) {
    if (req.method === 'GET') {
      const s = scripts.get(m[1]);
      return s ? send(res, 200, s) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') return send(res, 200, { ok: scripts.remove(m[1]) });
  }

  const route = routes[`${req.method} ${pathname}`];
  if (route) {
    const extra = pathname.startsWith('/api/slides/state') ? CORS : {};
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const out = await route(body, req, ctrl.signal);
      return send(res, 200, out, extra);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const code = err.status || (err.code === 'NO_KEY' ? 503 : 500);
      if (code >= 500) console.error(`[${pathname}]`, err.message);
      return send(res, code, { error: err.message, code: err.code }, extra);
    }
  }

  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
  return serveStatic(req, res, pathname);
}

// --idle-exit SECONDS: quit when no page has been connected for that long
// (used by the app launcher so the server does not linger).
let lastActivity = Date.now();
const idleArg = process.argv.indexOf('--idle-exit');
const idleExit = idleArg > 0 ? parseInt(process.argv[idleArg + 1], 10) : 0;
if (idleExit > 0) {
  setInterval(() => {
    if (clients.size === 0 && !native.proc && Date.now() - lastActivity > idleExit * 1000) {
      console.log('idle, shutting down');
      shutdown();
    }
  }, 5000).unref();
}

const server = createServer((req, res) => {
  lastActivity = Date.now();
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
});

server.listen(PORT, HOST, async () => {
  const k = await apiKey();
  console.log(`Teleprompter running at http://${HOST}:${server.address().port}`);
  console.log(`  Jev: ${k.key ? `available (key from ${k.source}), model ${JEV_MODEL}` : 'no API key found; semantic features off'}`);
  console.log(`  On-device recognizer: ${native.built ? 'built' : 'not built (npm run build:native)'}`);
});

function shutdown() {
  slides.stop();
  native.stop();
  cache.flush();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
