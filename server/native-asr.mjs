// Manages the on-device recognizer helper (native/tp-asr, Apple
// SpeechAnalyzer). The helper prints one JSON object per line:
//   {"type":"interim"|"final","text":...} {"type":"level","rms":...}
//   {"type":"status",...} {"type":"error","message":...}

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class NativeAsr extends EventEmitter {
  constructor(binPath) {
    super();
    this.bin = binPath;
    this.proc = null;
    this.locales = null;
    this.installing = null;
    this.cancelledSessions = new Set();
  }

  get built() {
    return existsSync(this.bin);
  }

  status() {
    return { built: this.built, running: !!this.proc, sessionId: this.sessionId || null, locale: this.locale || null, locales: this.locales, installing: this.installing };
  }

  listLocales() {
    if (!this.built) return Promise.resolve(null);
    if (this.listing) return this.listing;
    this.listing = new Promise((resolve) => {
      execFile(this.bin, ['--list'], { timeout: 20000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          this.locales = JSON.parse(stdout.trim().split('\n').pop());
          this.listedAt = Date.now();
        } catch {
          this.locales = null;
        }
        resolve(this.locales);
      });
    }).finally(() => { this.listing = null; });
    return this.listing;
  }

  _pipe(p, onLine) {
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          // not JSON; ignore
        }
      }
    });
  }

  start({ locale = 'en-US', terms = [], file = null, rate = 1, sessionId = randomUUID(), pageId = null } = {}) {
    if (this.cancelledSessions.has(sessionId)) throw Object.assign(new Error('Recognition session was cancelled'), { status: 409 });
    this.stop();
    if (!this.built) throw new Error('On-device recognizer is not built. Run: npm run build:native');
    const args = ['--locale', locale];
    if (terms.length) args.push('--terms', terms.slice(0, 100).join('\u001f'));
    if (file) args.push('--file', file, '--rate', String(rate));
    const p = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.sessionId = sessionId;
    this.ownerPageId = pageId;
    this.locale = locale;
    this._pipe(p, (msg) => { if (this.proc === p) this.emit('msg', { ...msg, sessionId }); });
    p.stdin.on('error', () => {}); // the helper may exit before stop reaches it
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.emit('msg', { type: 'status', state: 'stopped', sessionId, code, detail: code ? err.trim().slice(-300) || `Recognizer exited (${code})` : undefined });
    });
    p.on('error', (e) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.emit('msg', { type: 'error', sessionId, message: e.message });
    });
    return this.status();
  }

  stop(sessionId = null) {
    if (sessionId) {
      this.cancelledSessions.add(sessionId);
      while (this.cancelledSessions.size > 128) this.cancelledSessions.delete(this.cancelledSessions.values().next().value);
    }
    if (sessionId && sessionId !== this.sessionId) return;
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.emit('msg', { type: 'status', state: 'stopped', sessionId: this.sessionId, code: 0 });
    try {
      p.stdin.write('stop\n');
    } catch {
      // already gone
    }
    setTimeout(() => { if (p.exitCode === null) p.kill(); }, 1500);
  }

  // Download Apple's on-device model for a locale (user-initiated only).
  install(locale) {
    if (!this.built) throw new Error('not built');
    if (this.installing) return this.installing;
    const p = spawn(this.bin, ['--install', locale], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.installing = { locale, progress: 0 };
    this._pipe(p, (msg) => {
      if (msg.type === 'install') this.installing = { locale, progress: msg.progress ?? 0, state: msg.state };
      this.emit('msg', msg);
    });
    p.on('exit', (code) => {
      this.installing = null;
      this.listLocales();
      this.emit('msg', { type: 'install', locale, state: code === 0 ? 'done' : 'failed', code });
    });
    p.on('error', (e) => {
      this.installing = null;
      this.emit('msg', { type: 'install', locale, state: 'failed', detail: e.message });
    });
    return this.installing;
  }
}
