// Speech-driven builds with the real recognizer and a simulated slide show.
// macOS `say` reads the spoken text of some slides of a script (markers and
// cues removed) to WAV, piece by piece, so the audio time of every [click]
// is known. The on-device helper (native/build/tp-asr) recognizes the audio
// at `--rate` times real time; its results drive the Follower and the
// BuildController, whose clicks go to a simulated Keynote that knows how many
// builds each slide has. Nothing is sent to a real slide app.
//
//   node test/builds-e2e.mjs --script notes.md --slides 3-6 --clicks 0,0,2,2,8,6 [--rate 1.5]
//
// Reports, for every marker, when its click came relative to the words around
// it, and whether each slide advanced only after all of its builds.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseScript } from '../public/lib/script.js';
import { Follower } from '../public/lib/follower.js';
import { BuildController } from '../public/lib/builds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const rate = +arg('rate', '1.5');
const work = arg('work', join(tmpdir(), 'tp-builds-e2e'));
mkdirSync(work, { recursive: true });
const doc = parseScript(readFileSync(arg('script'), 'utf8'));
const [s0, s1] = arg('slides', '3-4').split('-').map(Number);
const clicks = arg('clicks', '').split(',').map(Number); // builds per slide, slide 1 first
const lang = doc.lang;

// ---------------------------------------------------------------- audio
// Pieces of spoken text between markers, one WAV each, concatenated.
const slides = doc.slides.filter((s) => s.n >= s0 && s.n <= s1).sort((a, b) => a.tokStart - b.tokStart);
const range = (n) => {
  const st = [...doc.slides].sort((a, b) => a.tokStart - b.tokStart);
  const i = st.findIndex((s) => s.n === n);
  if (i < 0) return null;
  return { tokStart: st[i].tokStart, tokEnd: i + 1 < st.length ? st[i + 1].tokStart : doc.tokens.length };
};
const tokText = (a, b) => {
  // display text of whole phrases in [a, b) (markers fall between phrases or inside one)
  const out = [];
  for (const ph of doc.phrases) {
    if (ph.tokEnd <= a || ph.tokStart >= b) continue;
    out.push(ph.pieces.filter((p) => p.kind !== 'cue' && (p.tok === undefined || (p.tok >= a && p.tok < b)))
      .map((p) => p.t).join('').trim());
  }
  return out.filter(Boolean).join(lang === 'zh' ? '' : ' ');
};
const cuts = []; // token positions where a piece ends: markers and slide ends
for (const s of slides) {
  const r = range(s.n);
  for (const b of doc.builds.filter((x) => x.slide === s.n)) cuts.push({ tok: b.tok, kind: 'marker', b, slide: s.n });
  cuts.push({ tok: r.tokEnd, kind: 'end', slide: s.n });
}
cuts.sort((a, b) => a.tok - b.tok || (a.kind === 'marker' ? -1 : 1));
const voice = lang === 'zh' ? 'Tingting' : 'Samantha';
const sayRate = lang === 'zh' ? '230' : '175';
const pcm = [];
let at = 0; // seconds of audio so far
let from = range(s0).tokStart;
const timeline = [];
const silence = (sec) => Buffer.alloc(Math.round(sec * 16000) * 2);
pcm.push(silence(0.5));
at += 0.5;
for (const c of cuts) {
  const text = tokText(from, c.tok);
  if (text) {
    const f = join(work, `piece-${timeline.length}.wav`);
    execFileSync('/usr/bin/say', ['-v', voice, '-r', sayRate, '-o', f, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
    const wav = readFileSync(f);
    const data = wav.subarray(wav.indexOf('data') + 8);
    pcm.push(data);
    at += data.length / 32000;
  }
  timeline.push({ ...c, t: at });
  pcm.push(silence(c.kind === 'end' ? 0.8 : 0.35));
  at += c.kind === 'end' ? 0.8 : 0.35;
  from = c.tok;
}
pcm.push(silence(1.5));
const body = Buffer.concat(pcm);
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24);
head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(body.length, 40);
const wavPath = join(work, `slides-${s0}-${s1}.wav`);
writeFileSync(wavPath, Buffer.concat([head, body]));
console.log(`audio ${at.toFixed(1)} s, ${timeline.filter((x) => x.kind === 'marker').length} markers, slides ${s0}-${s1}`);

// ------------------------------------------------------------ simulated show
// Audio clock: the helper feeds the file at about `rate` times real time;
// the true feed rate is calibrated afterwards from the audio length and the
// wall time the helper took, and every event is mapped back to audio time.
let t0 = Date.now();
const wall = () => Date.now() - t0;
const vt = () => wall() * rate / 1000; // provisional audio seconds (for the follower's clock)
const show = { slide: s0, built: 0, playing: true, total: Math.max(s1 + 1, clicks.length) };
const events = [];
let ctl;
const send = async () => {
  await new Promise((r) => setTimeout(r, 120)); // osascript
  const need = clicks[show.slide - 1] ?? 0;
  if (show.built < need) {
    show.built++;
    events.push({ w: wall(), what: 'build', slide: show.slide, k: show.built });
  } else {
    show.slide++;
    show.built = 0;
    events.push({ w: wall(), what: 'slide', slide: show.slide });
    // the watcher reports a little later
    setTimeout(() => {
      ctl.slideState({ playing: true, slide: show.slide, total: show.total });
      const r = range(show.slide);
      if (r) f.slideChanged(r.tokStart, r.tokEnd, vt() * 1000);
    }, 300);
  }
};
const f = new Follower(doc);
ctl = new BuildController(doc, {
  send, range,
  nextRange: (n) => range(n + 1),
  markers: (n) => doc.builds.filter((b) => b.slide === n),
  now: () => Date.now(),
});
ctl.slideState({ playing: true, slide: s0, total: show.total });
f.jumpTo(range(s0).tokStart, 0);
f.on((v) => ctl.view(v, true));
f.armListening(0);

// --------------------------------------------------------------- recognizer
const bin = join(ROOT, 'native', 'build', 'tp-asr');
const p = spawn(bin, ['--locale', lang === 'zh' ? 'zh-CN' : 'en-US', '--file', wavPath, '--rate', String(rate)]);
let buf = '';
const tick = setInterval(() => {
  f.tick(vt() * 1000);
  ctl.tick(true);
}, 100);
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'status' && m.state === 'listening') t0 = Date.now(); // feeding starts
    if (m.type === 'interim' || m.type === 'final') f.onSpeech(m.type, m.text, vt() * 1000);
    if (m.type === 'error') console.log('asr error', m.message);
  }
});
let feedWall = 0;
p.on('exit', () => {
  feedWall = wall() - 400; // the recognizer finishes shortly after the last chunk
  clearInterval(tick);
  setTimeout(report, 1500);
});

function report() {
  let ok = true;
  const eff = (at + 1.5) / (feedWall / 1000); // audio seconds per wall second
  for (const e of events) e.t = e.w / 1000 * eff;
  console.log(`feed rate ${eff.toFixed(3)}x (asked ${rate}x)`);
  const builds = events.filter((e) => e.what === 'build');
  const marks = timeline.filter((x) => x.kind === 'marker');
  let bi = 0;
  console.log('\nmarker  slide  said-at  click-at  delay');
  for (const m of marks) {
    for (let k = 0; k < (m.b.count || 1); k++) {
      const e = builds[bi++];
      const delay = e ? e.t - m.t : NaN;
      const flag = !e ? 'MISSING' : delay < -1.2 ? 'EARLY' : delay > 3.5 ? 'LATE' : '';
      if (flag) ok = false;
      console.log(`  #${m.b.idx}${m.b.count > 1 ? `.${k + 1}` : ''}   ${String(m.slide).padStart(3)}   ${m.t.toFixed(1).padStart(6)}   ${e ? e.t.toFixed(1).padStart(6) : '   -  '}   ${Number.isFinite(delay) ? delay.toFixed(1) : '-'} ${flag}`);
    }
  }
  console.log('\nslide ends');
  for (const end of timeline.filter((x) => x.kind === 'end')) {
    const e = events.find((x) => x.what === 'slide' && x.slide === end.slide + 1);
    const builtAll = builds.filter((b) => b.slide === end.slide).length === (clicks[end.slide - 1] ?? 0);
    const delay = e ? e.t - end.t : NaN;
    // the last slide of the range may or may not advance before the audio ends
    const last = end.slide === s1;
    const flag = !e ? (last ? '' : 'NO-ADVANCE') : !builtAll ? 'BUILDS-MISSING' : delay < -1.5 ? 'EARLY' : delay > 4 ? 'LATE' : '';
    if (flag) ok = false;
    console.log(`  slide ${end.slide}: text ends ${end.t.toFixed(1)} s, next slide at ${e ? e.t.toFixed(1) : '-'} (${Number.isFinite(delay) ? delay.toFixed(1) : '-'} s) ${builtAll ? 'all builds' : 'builds missing'} ${flag}`);
  }
  console.log(ok ? '\nPASS' : '\nCHECK');
  process.exit(ok ? 0 : 1);
}
