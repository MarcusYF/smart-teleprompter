// Speech input engines. All engines report the same events:
//   onInterim(text)  provisional text of the utterance in progress
//   onFinal(text)    final text of an utterance
//   onState(state, detail)   'listening' | 'stopped' | 'error' | ...
//   onLevel(rms)     microphone level (0..1), when available

import { simulate } from './simulate.js';

const noop = () => {};

// ---------------------------------------------------------- Web Speech

export class WebSpeechEngine {
  static supported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({ lang, terms = [], onInterim = noop, onFinal = noop, onState = noop }) {
    this.lang = lang;
    this.terms = terms;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.want = false;
    this.rec = null;
    this.restarts = 0;
    this.name = 'webspeech';
  }

  start() {
    this.want = true;
    this._start();
  }

  _start() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new R();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Contextual biasing where the browser supports it.
    if ('phrases' in rec && window.SpeechRecognitionPhrase && this.terms.length) {
      try {
        rec.phrases = this.terms.slice(0, 50).map((t) => new window.SpeechRecognitionPhrase(t, 3.0));
      } catch {
        // unsupported shape; ignore
      }
    }
    let committed = 0;
    this.pending = '';
    this.rec = rec;
    rec.onresult = (e) => {
      if (!this.want || this.rec !== rec) return;
      let interim = '';
      for (let i = committed; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && i === committed) {
          this.onFinal(r[0].transcript);
          committed++;
        } else {
          interim += r[0].transcript;
        }
      }
      this.pending = interim;
      this.onInterim(interim);
    };
    rec.onstart = () => {
      if (!this.want || this.rec !== rec) return;
      this.onState('listening');
    };
    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'phrases-not-supported') {
        // this recognizer cannot take biasing phrases; retry without them
        this.terms = [];
        return;
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') this.want = false;
      this.onState('error', e.error);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      // Chrome ends sessions every minute or so and drops the utterance in
      // progress; keep what was already heard instead of losing it
      if (this.want && this.pending && this.pending.trim()) this.onFinal(this.pending);
      this.pending = '';
      if (this.want) {
        this.restarts++;
        setTimeout(() => { if (this.want && !this.rec) this._start(); }, this.restarts > 20 ? 1000 : 120);
      } else {
        this.onState('stopped');
      }
    };
    try {
      rec.start();
      this.rec = rec;
    } catch (err) {
      this.want = false;
      this.rec = null;
      this.onState('error', String(err.message || err));
    }
  }

  stop() {
    this.want = false;
    const rec = this.rec;
    this.rec = null;
    this.pending = '';
    if (rec) {
      try {
        if (rec.abort) rec.abort();
        else rec.stop();
      } catch {
        // ignore
      }
    }
    this.onState('stopped');
  }
}

// ------------------------------------------- Apple on-device (via server)

export class NativeEngine {
  constructor({ lang, text, onInterim = noop, onFinal = noop, onState = noop, onLevel = noop }) {
    this.lang = lang;
    this.text = text;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.onLevel = onLevel;
    this.name = 'native';
    this.active = false;
    this.sessionId = null;
  }

  async start() {
    const sessionId = this.sessionId = globalThis.crypto.randomUUID();
    this.active = true;
    const ctrl = this.startRequest = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch('/api/asr/native/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: this.lang, text: this.text, sessionId, owner: this.controllerId, pageId: this.pageId }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!this.active || this.sessionId !== sessionId) return;
      if (!res.ok) {
        this.active = false;
        this.onState('error', j.error || 'native recognizer failed');
      }
    } catch (err) {
      if (!this.active || this.sessionId !== sessionId) return;
      this.active = false;
      this.onState('error', String(err.message || err));
    } finally {
      clearTimeout(timer);
      if (this.startRequest === ctrl) this.startRequest = null;
    }
  }

  // messages relayed from the server's event stream
  handle(msg) {
    if (!this.active || msg.sessionId !== this.sessionId) return;
    if (msg.type === 'interim') this.onInterim(msg.text);
    else if (msg.type === 'final') this.onFinal(msg.text);
    else if (msg.type === 'level') this.onLevel(msg.rms);
    else if (msg.type === 'status') {
      if (msg.state === 'stopped') {
        this.active = false;
        this.onState(msg.code ? 'error' : 'stopped', msg.detail);
      } else this.onState(msg.state, msg.detail);
    } else if (msg.type === 'error') {
      this.active = false;
      this.onState('error', msg.message);
    }
  }

  stop() {
    this.active = false;
    this.startRequest?.abort();
    if (this.sessionId) fetch('/api/asr/native/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId }) }).catch(noop);
    this.onState('stopped');
  }
}

// --------------------------------------------------------- simulation

export class SimEngine {
  constructor({ doc, onInterim = noop, onFinal = noop, onState = noop }) {
    this.doc = doc;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.timers = [];
    this.name = 'sim';
  }

  play(performance, opts = {}) {
    this.stop(true);
    const sim = simulate(this.doc, performance, opts);
    const speed = opts.speed || 1;
    this.onState('listening');
    for (const ev of sim.events) {
      this.timers.push(setTimeout(() => {
        if (ev.kind === 'final') this.onFinal(ev.text);
        else this.onInterim(ev.text);
      }, ev.t / speed));
    }
    this.timers.push(setTimeout(() => this.onState('stopped'), sim.duration / speed + 300));
    return sim;
  }

  // Say arbitrary text as if spoken, word by word.
  say(text, { rate = this.doc.lang === 'zh' ? 5 : 2.6 } = {}) {
    const units = this.doc.lang === 'zh' ? [...text.replace(/\s+/g, '')] : text.split(/\s+/).filter(Boolean);
    const sep = this.doc.lang === 'zh' ? '' : ' ';
    let acc = [];
    units.forEach((u, i) => {
      this.timers.push(setTimeout(() => {
        acc.push(u);
        this.onInterim(acc.join(sep));
        if (i === units.length - 1) {
          this.onFinal(acc.join(sep));
          acc = [];
        }
      }, (i * 1000) / rate));
    });
  }

  start() {
    this.onState('listening');
  }

  stop(silent) {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (!silent) this.onState('stopped');
  }
}

// ------------------------------------------------ microphone level meter

export class MicMeter {
  constructor(onLevel = noop) {
    this.onLevel = onLevel;
    this.stream = null;
    this.ctx = null;
    this.raf = null;
    this.generation = 0;
  }

  async start() {
    if (this.stream) return true;
    const generation = ++this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) {
        for (const t of stream.getTracks()) t.stop();
        return false;
      }
      this.stream = stream;
    } catch {
      return false;
    }
    try {
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        this.onLevel(Math.sqrt(s / buf.length));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  stop() {
    this.generation++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}

// Voice activity from level with an adaptive noise floor.
export class Vad {
  constructor() {
    this.floor = 0.01;
    this.active = false;
    this.lastAbove = 0;
  }

  push(rms, now = performance.now()) {
    // floor tracks quiet periods quickly, rises slowly
    if (rms < this.floor) this.floor = this.floor * 0.9 + rms * 0.1;
    else this.floor = this.floor * 0.999 + rms * 0.001;
    const thr = Math.max(0.012, this.floor * 2.8);
    if (rms > thr) this.lastAbove = now;
    this.active = now - this.lastAbove < 350;
    return this.active;
  }
}
