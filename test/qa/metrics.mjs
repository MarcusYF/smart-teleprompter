// Metrics over stored results.
//   node test/qa/metrics.mjs results/baseline-full.json [results/baseline-prefix.json]
// Prints Markdown tables. Also exported for compare.mjs.

import { join, isAbsolute } from 'node:path';
import { QA, loadDoc, phraseIdx, readJson, quantile } from './lib.mjs';
import { realAction, simAction, outcome, expectedActionType, actionType, ON_SCRIPT_LABELS } from './action.mjs';

export const LABELS = ['reading_current', 'paraphrase', 'adlib_related', 'false_start', 'jumped_ahead', 'went_back', 'unrelated'];
const SHORT = { reading_current: 'read', paraphrase: 'para', adlib_related: 'adlib', false_start: 'slip', jumped_ahead: 'ahead', went_back: 'back', unrelated: 'unrel' };

export function loadCases(file = 'jev-cases.json') {
  return readJson(join(QA, file)).cases;
}

export function loadResults(p) {
  return readJson(isAbsolute(p) ? p : join(QA, p));
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');

// ---------------------------------------------------------------- relation
export function relationStats(cases, byId, filter = () => true) {
  const cs = cases.filter(filter).filter((c) => byId[c.id] && !byId[c.id].error);
  const conf = Object.fromEntries(LABELS.map((g) => [g, Object.fromEntries([...LABELS, 'other'].map((p) => [p, 0]))]));
  let ok = 0;
  for (const c of cs) {
    const p = byId[c.id].relation?.choice;
    conf[c.label][LABELS.includes(p) ? p : 'other']++;
    if (p === c.label) ok++;
  }
  const per = {};
  let f1sum = 0;
  for (const l of LABELS) {
    const tp = conf[l][l];
    const fn = Object.values(conf[l]).reduce((a, b) => a + b, 0) - tp;
    const fp = LABELS.reduce((a, g) => a + (g === l ? 0 : conf[g][l]), 0);
    const P = tp + fp ? tp / (tp + fp) : NaN;
    const R = tp + fn ? tp / (tp + fn) : NaN;
    const F = P + R ? (2 * P * R) / (P + R) : 0;
    per[l] = { tp, fp, fn, P, R, F: Number.isFinite(F) ? F : 0 };
    f1sum += per[l].F;
  }
  return { n: cs.length, acc: cs.length ? ok / cs.length : NaN, ok, macroF1: f1sum / LABELS.length, per, conf };
}

// ------------------------------------------------------------------- where
export function whereStats(cases, byId, filter = () => true) {
  const cs = cases.filter(filter).filter((c) => byId[c.id] && !byId[c.id].error && ON_SCRIPT_LABELS.includes(c.label));
  let exact = 0;
  let near = 0;
  let sent = 0;
  let none = 0;
  const rows = [];
  for (const c of cs) {
    const doc = loadDoc(c.script);
    const w = byId[c.id].where?.choice;
    const pi = phraseIdx(w);
    const gi = phraseIdx(c.where);
    const e = w === c.where;
    const n1 = pi >= 0 && Math.abs(pi - gi) <= 1;
    const s = pi >= 0 && (e || (c.whereOk || []).includes(w) || doc.phrases[pi].sent === doc.phrases[gi].sent);
    if (e) exact++;
    if (n1) near++;
    if (s) sent++;
    if (pi < 0) none++;
    rows.push({ id: c.id, gold: c.where, pred: w, p: byId[c.id].where?.probabilities?.[w] ?? 0, exact: e, near: n1 });
  }
  // hold labels: does where say none?
  const hs = cases.filter(filter).filter((c) => byId[c.id] && !byId[c.id].error && ['adlib_related', 'unrelated'].includes(c.label));
  const holdNone = hs.filter((c) => byId[c.id].where?.choice === 'none').length;
  return { n: cs.length, exact, near, sent, none, rows, holdN: hs.length, holdNone };
}

// ------------------------------------------------------------- calibration
// Binned accuracy of the chosen relation label vs its probability, ECE, and
// AUROC of confidence for telling right from wrong answers.
export function calibration(items) {
  // items: [{p, conf, ok}]
  const bins = [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.01]];
  const rows = bins.map(([a, b]) => {
    const xs = items.filter((x) => x.p >= a && x.p < b);
    const acc = xs.length ? xs.filter((x) => x.ok).length / xs.length : NaN;
    const meanP = xs.length ? xs.reduce((s, x) => s + x.p, 0) / xs.length : NaN;
    return { range: `${a.toFixed(2)}–${Math.min(b, 1).toFixed(2)}`, n: xs.length, acc, meanP };
  });
  const ece = rows.reduce((s, r) => s + (r.n ? (r.n / items.length) * Math.abs(r.acc - r.meanP) : 0), 0);
  const auroc = (key) => {
    const pos = items.filter((x) => x.ok).map((x) => x[key]);
    const neg = items.filter((x) => !x.ok).map((x) => x[key]);
    if (!pos.length || !neg.length) return NaN;
    let s = 0;
    for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
    return s / (pos.length * neg.length);
  };
  const meanOk = (ok) => {
    const xs = items.filter((x) => x.ok === ok);
    return xs.length ? xs.reduce((s, x) => s + x.conf, 0) / xs.length : NaN;
  };
  return { rows, ece, aurocP: auroc('p'), aurocConf: auroc('conf'), confRight: meanOk(true), confWrong: meanOk(false) };
}

export function relationCalibration(cases, byId) {
  return calibration(cases.filter((c) => byId[c.id] && !byId[c.id].error).map((c) => {
    const r = byId[c.id].relation;
    return { p: r.probabilities?.[r.choice] ?? 0, conf: r.confidence ?? 0, ok: r.choice === c.label };
  }));
}

export function whereCalibration(cases, byId) {
  return calibration(cases.filter((c) => byId[c.id] && !byId[c.id].error && ON_SCRIPT_LABELS.includes(c.label)).map((c) => {
    const w = byId[c.id].where;
    const pi = phraseIdx(w.choice);
    return { p: w.probabilities?.[w.choice] ?? 0, conf: w.confidence ?? 0, ok: pi >= 0 && Math.abs(pi - phraseIdx(c.where)) <= 1 };
  }));
}

// ------------------------------------------------------------------ actions
export function actionStats(cases, byId, { sim = null, filter = () => true } = {}) {
  const cs = cases.filter(filter).filter((c) => byId[c.id] && !byId[c.id].error);
  const tally = { correct: 0, held: 0, partial: 0, wrong: 0 };
  const byLabel = {};
  const typeConf = { hold: { hold: 0, forward: 0, back: 0 }, forward: { hold: 0, forward: 0, back: 0 }, back: { hold: 0, forward: 0, back: 0 } };
  const rows = [];
  for (const c of cs) {
    const doc = loadDoc(c.script);
    const j = byId[c.id];
    const a = sim ? simAction(doc, c.cur, j, sim) : realAction(doc, c.cur, j);
    const o = outcome(c, a.final);
    tally[o]++;
    byLabel[c.label] = byLabel[c.label] || { correct: 0, held: 0, partial: 0, wrong: 0, n: 0 };
    byLabel[c.label][o]++;
    byLabel[c.label].n++;
    typeConf[expectedActionType(c)][actionType(a.action)]++;
    rows.push({ id: c.id, label: c.label, action: a.action, final: a.final, expect: c.expect, cur: c.cur, outcome: o });
  }
  return { n: cs.length, ...tally, byLabel, typeConf, rows };
}

// Episode: the browser's sequence of requests; the first move ends it.
export function episodeStats(cases, prefixResults, { sim = null, filter = () => true } = {}) {
  const byCase = {};
  for (const r of prefixResults) (byCase[r.id] = byCase[r.id] || []).push(r);
  const cs = cases.filter(filter).filter((c) => byCase[c.id]);
  const tally = { correct: 0, held: 0, partial: 0, wrong: 0 };
  const byLabel = {};
  const rows = [];
  let firstQueryWrong = 0;
  let movedEarly = 0;
  for (const c of cs) {
    const doc = loadDoc(c.script);
    const seq = byCase[c.id].sort((a, b) => a.n - b.n);
    let final = c.cur;
    let action = 'hold';
    let at = null;
    for (let k = 0; k < seq.length; k++) {
      const j = seq[k];
      if (j.error) continue;
      const a = sim ? simAction(doc, c.cur, j, sim) : realAction(doc, c.cur, j);
      if (k === 0 && outcome(c, a.final, { path: true }) === 'wrong') firstQueryWrong++;
      if (a.action !== 'hold' && a.action !== 'stale') {
        final = a.final;
        action = a.action;
        at = j.n;
        if (k < seq.length - 1) movedEarly++;
        break;
      }
    }
    const o = outcome(c, final, { path: true });
    tally[o]++;
    byLabel[c.label] = byLabel[c.label] || { correct: 0, held: 0, partial: 0, wrong: 0, n: 0 };
    byLabel[c.label][o]++;
    byLabel[c.label].n++;
    rows.push({ id: c.id, label: c.label, action, at, of: seq[seq.length - 1].n, final, expect: c.expect, outcome: o, requests: seq.length });
  }
  return { n: cs.length, ...tally, byLabel, rows, firstQueryWrong, movedEarly };
}

export function latency(results) {
  const ok = results.filter((r) => !r.error);
  const ms = ok.map((r) => r.ms).filter(Number.isFinite);
  const rtt = ok.map((r) => r.rtt).filter(Number.isFinite);
  const tok = ok.map((r) => r.tokens).filter(Number.isFinite);
  return {
    n: ok.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: Math.max(...ms),
    rtt50: quantile(rtt, 0.5), rtt95: quantile(rtt, 0.95),
    tokMean: tok.reduce((a, b) => a + b, 0) / (tok.length || 1),
  };
}

// ------------------------------------------------------------------ report
export function mdRelation(st) {
  const lines = ['| label | n | precision | recall | F1 |', '|---|---:|---:|---:|---:|'];
  for (const l of LABELS) {
    const p = st.per[l];
    lines.push(`| ${l} | ${p.tp + p.fn} | ${f2(p.P)} | ${f2(p.R)} | ${f2(p.F)} |`);
  }
  lines.push(`| **all** | ${st.n} | | **acc ${f2(st.acc)}** | **macro ${f2(st.macroF1)}** |`);
  return lines.join('\n');
}

export function mdConfusion(st) {
  const cols = [...LABELS, 'other'].filter((p) => p !== 'other' || LABELS.some((g) => st.conf[g].other));
  const lines = [`| gold \\ pred | ${cols.map((p) => SHORT[p] || p).join(' | ')} |`, `|---|${cols.map(() => '---:').join('|')}|`];
  for (const g of LABELS) lines.push(`| ${g} | ${cols.map((p) => (st.conf[g][p] ? (p === g ? `**${st.conf[g][p]}**` : st.conf[g][p]) : '·')).join(' | ')} |`);
  return lines.join('\n');
}

export function mdCalibration(cal) {
  const lines = ['| p(chosen) | n | accuracy | mean p |', '|---|---:|---:|---:|'];
  for (const r of cal.rows) lines.push(`| ${r.range} | ${r.n} | ${f2(r.acc)} | ${f2(r.meanP)} |`);
  lines.push(`\nECE ${f2(cal.ece)} · AUROC(p→correct) ${f2(cal.aurocP)} · AUROC(confidence→correct) ${f2(cal.aurocConf)} · mean confidence right ${f2(cal.confRight)} vs wrong ${f2(cal.confWrong)}`);
  return lines.join('\n');
}

export function mdActions(st, title = 'action') {
  const lines = [`| gold label | n | correct | held (benign) | partial (benign) | wrong move |`, '|---|---:|---:|---:|---:|---:|'];
  for (const l of LABELS) {
    const b = st.byLabel[l];
    if (!b) continue;
    lines.push(`| ${l} | ${b.n} | ${b.correct} | ${b.held} | ${b.partial} | ${b.wrong} |`);
  }
  lines.push(`| **all** | ${st.n} | **${st.correct} (${pct(st.correct, st.n)})** | ${st.held} | ${st.partial} | **${st.wrong} (${pct(st.wrong, st.n)})** |`);
  return lines.join('\n');
}

export function mdTypeConf(st) {
  const lines = ['| ideal \\ taken | hold | forward | back |', '|---|---:|---:|---:|'];
  for (const k of ['hold', 'forward', 'back']) lines.push(`| ${k} | ${st.typeConf[k].hold} | ${st.typeConf[k].forward} | ${st.typeConf[k].back} |`);
  return lines.join('\n');
}

export function indexResults(res) {
  const byId = {};
  for (const r of res.results) byId[r.id] = r;
  return byId;
}

// ------------------------------------------------------------------- main
if (import.meta.url === `file://${process.argv[1]}`) {
  const full = loadResults(process.argv[2] || 'results/baseline-local-full.json');
  const cases = loadCases(full.casesFile || 'jev-cases.json');
  const byId = indexResults(full);
  const langs = { all: () => true, en: (c) => c.script.startsWith('en'), zh: (c) => c.script.startsWith('zh') };
  console.log(`# ${full.tag}  (${full.requests} requests, $${full.costUSD})\n`);
  for (const [k, f] of Object.entries(langs)) {
    const st = relationStats(cases, byId, f);
    console.log(`## relation — ${k}: acc ${f2(st.acc)} (${st.ok}/${st.n}), macro-F1 ${f2(st.macroF1)}\n`);
    if (k === 'all') {
      console.log(mdRelation(st) + '\n');
      console.log(mdConfusion(st) + '\n');
    }
  }
  for (const [k, f] of Object.entries(langs)) {
    const w = whereStats(cases, byId, f);
    const inWin = whereStats(cases, byId, (c) => f(c) && c.hard !== 'back_outside_window');
    console.log(`## where — ${k}: top-1 ${w.exact}/${w.n} (${pct(w.exact, w.n)}), ±1 ${w.near}/${w.n} (${pct(w.near, w.n)}), same sentence ${w.sent}/${w.n}, chose none ${w.none}; in-window ±1 ${inWin.near}/${inWin.n}; hold-label cases answered none ${w.holdNone}/${w.holdN}`);
  }
  console.log('\n## calibration (relation)\n');
  console.log(mdCalibration(relationCalibration(cases, byId)));
  console.log('\n## calibration (where, correct = ±1)\n');
  console.log(mdCalibration(whereCalibration(cases, byId)));
  const lat = latency(full.results);
  console.log(`\n## latency: server ms p50 ${lat.p50} p95 ${lat.p95} max ${lat.max}; client rtt p50 ${lat.rtt50} p95 ${lat.rtt95}; mean input tokens ${Math.round(lat.tokMean)}\n`);
  const act = actionStats(cases, byId);
  console.log('## action (single request on the full off-script text, current applySemantic)\n');
  console.log(mdActions(act) + '\n');
  console.log(mdTypeConf(act) + '\n');
  for (const r of act.rows.filter((x) => x.outcome !== 'correct')) console.log(`  ${r.id} ${r.label}: ${r.action} -> P${r.final} (ideal P${r.expect}, cur P${r.cur}) ${r.outcome}`);
  if (process.argv[3]) {
    const pre = loadResults(process.argv[3]);
    const ep = episodeStats(cases, pre.results);
    const lat2 = latency(pre.results);
    console.log(`\n## episode (${pre.requests} requests; first move ends the episode)\n`);
    console.log(mdActions(ep) + '\n');
    console.log(`first request already a wrong move: ${ep.firstQueryWrong}/${ep.n}; moved before the full text: ${ep.movedEarly}/${ep.n}; latency p50 ${lat2.p50} p95 ${lat2.p95}`);
    for (const r of ep.rows.filter((x) => x.outcome !== 'correct')) console.log(`  ${r.id} ${r.label}: ${r.action} at ${r.at ?? '-'}/${r.of} -> P${r.final} (ideal P${r.expect}) ${r.outcome}`);
  }
}
