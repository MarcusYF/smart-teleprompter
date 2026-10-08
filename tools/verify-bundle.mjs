// Real backend test from a moved, read-only app bundle; no GUI, mic, or Jev calls.
import { mkdtemp, cp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const source = process.argv[2];
if (!source) throw new Error('Usage: node tools/verify-bundle.mjs /path/to/App.app');
const dir = await mkdtemp(join(tmpdir(), 'teleprompter-portable-'));
const app = join(dir, 'Moved application with spaces.app');
const data = join(dir, 'user data');
let child;
try {
  await cp(resolve(source), app, { recursive: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  execFileSync('/bin/chmod', ['-R', 'a-w', app]);
  await mkdir(data);
  const runtime = join(app, 'Contents/Resources/app');
  const expected = JSON.parse(await readFile(join(runtime, 'package.json')));
  const node = join(app, 'Contents/MacOS/node');
  assert.equal(execFileSync(node, ['-p', 'process.arch'], { encoding: 'utf8' }).trim(), 'arm64');
  let stdout = '', stderr = '';
  child = spawn(node, ['server/main.mjs'], { cwd: runtime,
    env: { PATH: '/usr/bin:/bin', HOME: dir, PORT: '0', HOST: '127.0.0.1', TELEPROMPTER_DATA: data,
      TELEPROMPTER_INSTANCE: 'bundle-verification', TYPESAFE_API_KEY: 'offline-unused-placeholder' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', e => { stderr += String(e); });
  const deadline = Date.now() + 15000;
  while (!stdout.includes('http://127.0.0.1:')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Bundled server failed: ${stderr}`);
    await new Promise(r => setTimeout(r, 100));
  }
  const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const request = (path, init) => fetch(url + path, { ...init, signal: AbortSignal.timeout(15000) });
  const ping = await (await request('/api/ping')).json();
  assert.equal(ping.version, expected.version);
  assert.equal(ping.instance, 'bundle-verification');
  assert.match(await (await request('/')).text(), /<html/);
  const script = await (await request('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Portable test', text: 'This is a temporary test script.' }) })).json();
  assert.ok(script.id);
  assert.equal(JSON.parse(await readFile(join(data, 'scripts', `${script.id}.json`))).title, 'Portable test');
  const asr = await (await request('/api/asr/native/status')).json();
  assert.equal(asr.built, true);
  assert.ok(Array.isArray(asr.locales?.supported), 'Bundled recognizer must return a supported-language list');
  console.log(JSON.stringify({ passed: true, version: expected.version, node: execFileSync(node, ['-v'], {encoding:'utf8'}).trim(),
    relocated: true, readOnlyBundle: true, externalNodeRequired: false, scriptPersistence: true, recognizer: asr }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    const exit = new Promise(r => child.once('exit', r));
    child.kill();
    await exit;
  }
  execFileSync('/bin/chmod', ['-R', 'u+w', dir]);
  await rm(dir, { recursive: true, force: true });
}
