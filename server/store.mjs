// Local persistence: saved scripts and a small JSON cache of Jev results.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function atomicWrite(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export class JsonCache {
  constructor(file, maxEntries = 5000) {
    this.file = file;
    this.max = maxEntries;
    this.map = new Map();
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(data)) this.map.set(k, v);
    } catch {
      // first run
    }
    this.timer = null;
  }

  get(k) {
    return this.map.get(k);
  }

  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this._schedule();
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.flush();
    }, 800);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      atomicWrite(this.file, JSON.stringify(Object.fromEntries(this.map)));
      this.error = null;
      return true;
    } catch (err) {
      this.error = err.message;
      console.error('Jev cache could not be saved:', err.message);
      return false; // a cache failure must not terminate a live presentation
    }
  }
}

export class ScriptStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  _path(id) {
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error('bad id');
    return join(this.dir, `${id}.json`);
  }

  list() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
          return { id: s.id, title: s.title, lang: s.lang, updatedAt: s.updatedAt, chars: (s.text || '').length };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  get(id) {
    const p = this._path(id);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }

  save(script) {
    const id = script.id && /^[\w-]{1,64}$/.test(script.id) ? script.id : randomUUID();
    const rec = {
      id,
      title: String(script.title || '').slice(0, 200),
      lang: script.lang || 'auto',
      text: String(script.text || ''),
      deck: script.deck ? String(script.deck).slice(0, 300) : undefined, // Keynote document the notes came from
      deckId: script.deckId ? String(script.deckId).slice(0, 300) : undefined,
      settings: script.settings || {},
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(this._path(id), JSON.stringify(rec, null, 2));
    return rec;
  }

  // Deleting only moves the file into a trash folder.
  remove(id) {
    const p = this._path(id);
    if (!existsSync(p)) return false;
    const trash = join(this.dir, '.trash');
    mkdirSync(trash, { recursive: true });
    renameSync(p, join(trash, `${id}-${Date.now()}.json`));
    return true;
  }
}
