// Real HTTP/SSE server in an isolated data directory; no Jev calls or slide apps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';

test('real HTTP routes, persistence, SSE and origin protection', async t => {
  const data = mkdtempSync(join(tmpdir(), 'tp-http-test-'));
  const child = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, PORT: '0', TELEPROMPTER_DATA: data, TYPESAFE_API_KEY: 'offline-unused-placeholder' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', d => { logs += d; });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode == null) await new Promise(r => child.once('exit', r));
    rmSync(data, { recursive: true });
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup timeout: ' + logs)), 5000);
    child.stdout.on('data', d => {
      logs += d;
      const m = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${logs}`)); });
  });
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin + '/api/ping')).status, 200);
  const page = await fetch(origin + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /btn-map/);
  assert.equal((await post('/api/scripts', { text: 'hostile' }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/api/scripts', { text: 'form payload' }, { 'Content-Type': 'text/plain' })).status, 415);
  const hostileHost = await new Promise((resolve, reject) => {
    get(origin + '/api/scripts', { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(origin + '/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  assert.deepEqual(await (await fetch(origin + '/api/scripts')).json(), []);
  const savedRes = await post('/api/scripts', { text: 'Hello script.', title: 'HTTP acceptance', deck: 'Test deck' }, { Origin: origin });
  assert.equal(savedRes.status, 200); const saved = await savedRes.json();
  assert.equal((await (await fetch(origin + '/api/scripts/' + saved.id)).json()).text, 'Hello script.');
  assert.equal((await (await fetch(origin + '/api/scripts')).json()).length, 1);
  assert.equal((await fetch(origin + '/api/scripts/' + saved.id, { method: 'DELETE', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await post('/api/slides/control', { action: 'next' })).status, 400);
  assert.equal((await post('/api/slides/control', { action: 'next', expected: { slide: 1, source: 'keynote', doc: 'unavailable' } })).status, 409);
  assert.equal((await post('/api/slides/claim', { owner: 'take-one', pageId: 'page-one' })).status, 200);
  assert.equal((await post('/api/slides/claim', { owner: 'take-two', pageId: 'page-two' })).status, 409);
  assert.equal((await post('/api/asr/native/start', { owner: 'take-one', pageId: 'wrong-page' })).status, 409);
  const ctrl = new AbortController();
  const events = await fetch(origin + '/api/events?pageId=page-one', { signal: ctrl.signal }), reader = events.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: hello/);
  const st = await post('/api/slides/state', { slide: 2, total: 3 }, { Origin: 'https://reveal.example' });
  assert.equal(st.status, 200); assert.equal(st.headers.get('access-control-allow-origin'), '*');
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: slide/); ctrl.abort();
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await post('/api/slides/claim', { owner: 'take-two', pageId: 'page-two' })).status, 200);
  assert.equal((await fetch(origin + '/api/scripts/' + saved.id, { method: 'DELETE', headers: { Origin: origin } })).status, 200);
  assert.deepEqual(await (await fetch(origin + '/api/scripts')).json(), []);
});
