// Minimal TypeSafe (Jev) client. The API key stays in this process: it is
// read from TYPESAFE_API_KEY or, failing that, from the macOS Keychain entry
// configured in the app, or the legacy TYPESAFE_API_KEY Keychain entry.
// The key is never logged or sent to the browser.

import { execFile } from 'node:child_process';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = process.env.TELEPROMPTER_JEV_MODEL || 'jev-latest';
const PRICE_PER_MTOK = Number(process.env.TELEPROMPTER_JEV_PRICE_PER_MTOK); // optional estimate for the configured model

let keyPromise = null;

function keychainKey(service) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-a', 'typesafe-ai', '-s', service, '-w'],
      { timeout: 5000 }, (err, stdout) => resolve(err ? null : (stdout || '').trim() || null));
  });
}

export function apiKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY, source: 'env' };
      if (process.platform === 'darwin') {
        const k = await keychainKey('local.claude-jev.teleprompter.jev') || await keychainKey('TYPESAFE_API_KEY');
        if (k) return { key: k, source: 'keychain' };
      }
      return { key: null, source: 'none' };
    })();
  }
  return keyPromise;
}

export const usage = { requests: 0, inputTokens: 0, errors: 0, lastLatencyMs: 0, model: null };

export function usageSummary() {
  return { ...usage, costUSD: Number.isFinite(PRICE_PER_MTOK) && PRICE_PER_MTOK > 0 ? +(usage.inputTokens * PRICE_PER_MTOK / 1e6).toFixed(6) : null, estimated: true };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

// One System One request. Returns the parsed response ({model, answers, usage}).
export async function ask(state, questions, { timeoutMs = 8000, retries = 2, model = JEV_MODEL, signal } = {}) {
  signal?.throwIfAborted();
  const { key } = await apiKey();
  signal?.throwIfAborted();
  if (!key) {
    const e = new Error('No TypeSafe API key (set TYPESAFE_API_KEY or add it to the Keychain).');
    e.code = 'NO_KEY';
    throw e;
  }
  const body = JSON.stringify({ state, model, questions });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'claude-jev-teleprompter/1.0' },
        body,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(err => { if (!res.ok) return {}; throw err; }); // includes response body timeout
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = new Error(`TypeSafe HTTP ${res.status}`);
        const ra = parseFloat(res.headers.get('retry-after') || '');
        if (attempt < retries) await sleep(Number.isFinite(ra) ? Math.max(0, Math.min(2000, ra * 1000)) : 300 * 2 ** attempt, signal);
        continue;
      }
      if (!res.ok) {
        const e = new Error(`TypeSafe HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
        e.status = res.status;
        throw e;
      }
      if (!json.answers || typeof json.answers !== 'object') throw new Error('TypeSafe returned an invalid response');
      usage.requests++;
      usage.inputTokens += json.usage?.input_tokens || 0;
      usage.lastLatencyMs = Date.now() - t0;
      usage.model = json.model || usage.model;
      return json;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      lastErr = err;
      if (err.status && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) await sleep(250 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  usage.errors++;
  throw lastErr;
}

// Run many independent requests with bounded concurrency.
export async function mapLimit(items, limit, fn, { signal } = {}) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { error: String(err.message || err) };
      }
    }
  });
  await Promise.all(workers);
  signal?.throwIfAborted();
  return out;
}
