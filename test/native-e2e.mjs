// Real-recognizer check without a person: macOS `say` renders a
// performance to WAV, the on-device helper (native/build/tp-asr) recognizes
// it at real-time pace, and its interim/final events drive the Follower.
//
//   node test/native-e2e.mjs --lang en --scenario adlib [--rate 1.5]
//
// Needs the helper built (npm run build:native) and Apple's on-device model
// for the language installed (the app's settings panel offers the download).

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parseScript, textOfPhrases } from '../public/lib/script.js';
import { Follower } from '../public/lib/follower.js';
import { SemanticClient } from '../public/lib/semantic-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const lang = arg('lang', 'en');
const scenario = arg('scenario', 'read');
const rate = +arg('rate', '1.5');
const work = arg('work', join(tmpdir(), 'tp-native-e2e'));
mkdirSync(work, { recursive: true });

const doc = parseScript(readFileSync(join(ROOT, 'public', 'samples', lang === 'zh' ? 'zh-demo.md' : 'en-demo.md'), 'utf8'));
const sil = (ms) => ` [[slnc ${ms}]] `;
const adlib = lang === 'zh'
  ? '我插一句，上个学期我在课堂上真的试过这个办法，学生们的反应特别有意思。'
  : 'Let me add a quick story. Last semester I tried this in my own class, and the students had wildly different opinions.';
const plans = {
  read: { parts: [textOfPhrases(doc, 0, 14)], end: 13 },
  adlib: { parts: [textOfPhrases(doc, 0, 7), sil(600), adlib, sil(600), textOfPhrases(doc, 7, 14)], end: 13, holdAfter: 6 },
  // phrases 7-11 are skipped; in Chinese, phrase 7 is the 4-character
  // transition 这样一来, which the follower may leave unmarked (too short to
  // matter), so only the substantive phrases are required there
  skip: { parts: [textOfPhrases(doc, 0, 7), sil(600), textOfPhrases(doc, 12, 20)], end: 19, skipped: lang === 'zh' ? [8, 9, 10, 11] : [7, 8, 9, 10, 11] },
  pause: { parts: [textOfPhrases(doc, 0, 6), sil(4000), textOfPhrases(doc, 6, 12)], end: 11 },
};
const plan = plans[scenario];
const wav = join(work, `${lang}-${scenario}.wav`);
const txt = join(work, `${lang}-${scenario}.txt`);
writeFileSync(txt, plan.parts.join(' ') + sil(1500));
execFileSync('/usr/bin/say', ['-v', lang === 'zh' ? 'Tingting' : 'Samantha', '-r', lang === 'zh' ? '230' : '170', '-o', wav,
  '--file-format=WAVE', '--data-format=LEI16@16000', '-f', txt]);

const bin = join(ROOT, 'native', 'build', 'tp-asr');
const f = new Follower(doc);
const t0 = Date.now();
const vt = () => (Date.now() - t0) * rate; // virtual (audio) time
// --jev: also run the semantic layer against the local server
const judgments = [];
const sem = process.argv.includes('--jev') ? new SemanticClient(doc, f, {
  base: arg('server', 'http://127.0.0.1:5217'), now: vt,
  onJudgment: (j) => {
    judgments.push(j);
    if (j.relation) console.log(`   [jev] ${j.relation.choice} (${j.relation.confidence?.toFixed(2)}) where=${j.where?.choice} covered=${j.covered?.toFixed(2)} -> ${j.action} | "${j.offScript}"`);
  },
  onSkipReminder: (r) => console.log(`   [jev] skipped key point (${r.p.toFixed(2)}): ${r.text}`),
}) : null;
let lastPrint = '';
const p = spawn(bin, ['--locale', lang === 'zh' ? 'zh-CN' : 'en-US', '--file', wav, '--rate', String(rate)]);
p.stdout.setEncoding('utf8');
let buf = '';
let error = null;
const tick = setInterval(() => f.tick(vt()), 100);
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === 'error') error = m;
    if (m.type !== 'interim' && m.type !== 'final') continue;
    f.onSpeech(m.type, m.text, vt());
    if (sem) sem.check(vt());
    const v = f.view(vt());
    const key = `${v.pos}|${v.status}`;
    if (key !== lastPrint) {
      lastPrint = key;
      console.log(`${(vt() / 1000).toFixed(1)}s ${m.type.padEnd(7)} pos=${v.pos} ph=${v.phrase} ${v.status} | ${m.text.slice(-60)}`);
    }
  }
});
p.on('exit', async (code) => {
  clearInterval(tick);
  await new Promise((r) => setTimeout(r, 1500)); // let pending Jev calls land
  if (error) {
    console.log(`\nrecognizer error: ${error.code} ${error.message}`);
    process.exit(2);
  }
  const want = doc.phrases[plan.end].tokEnd;
  let ok = code === 0 && Math.abs(f.pos - want) <= 3;
  console.log(`\nexit ${code}; end pos ${f.pos} (want ~${want}, phrase ${plan.end}): ${ok ? 'OK' : 'FAIL'}`);
  if (plan.skipped) {
    const miss = plan.skipped.filter((x) => !f.skipped.has(x));
    if (miss.length) ok = false;
    console.log(`skipped marks ${[...f.skipped]}: ${miss.length ? `FAIL missing ${miss}` : 'OK'}`);
  }
  process.exit(ok ? 0 : 1);
});
