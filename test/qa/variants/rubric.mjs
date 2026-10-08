// Rubric variant: HEAD skippedJudgment and outline code with one edit each
// (assignment / instruction / deadline named as important). Generated from
// server/semantic.mjs by the QA harness; see REPORT-jev.md.
import { createHash } from 'node:crypto';
import { ask, mapLimit } from '../../../server/jev.mjs';
import { keyphraseCandidates } from '../../../public/lib/outline.js';

// ---------------------------------------------------------------- skipped

// Judged per sentence: a long skipped passage mixes key points with filler,
// and one serious omission is enough for a reminder. Each sentence is also
// checked against what the speaker actually said, so a paraphrase is not
// reported as an omission.
export async function skippedJudgment({ sentences, skipped, context, spoken }) {
  const list = (sentences && sentences.length ? sentences : [skipped || '']).slice(0, 20);
  const state = {
    skipped_sentences: list.map((t, i) => `K${i + 1}| ${t}`).join('\n'),
    surrounding_script: context || '',
    recent_speech: spoken || '',
  };
  const questions = {};
  list.forEach((_, i) => {
    questions[`important_${i}`] = {
      type: 'noul',
      instructions: `The speaker skipped these script sentences while giving a talk. Does sentence K${i + 1} of \`skipped_sentences\` state an important point that the audience would miss, such as a key fact, number, definition, step, argument, or an instruction, assignment, or deadline for the audience?`,
      criteria: {
        true: 'It carries content the talk depends on; the speaker should go back to it.',
        false: 'It is a transition, signpost, repetition, aside, or minor detail that can be dropped.',
      },
    };
    if (spoken) {
      questions[`covered_${i}`] = {
        type: 'noul',
        instructions: `In \`recent_speech\` (speech recognition output, no punctuation), did the speaker express the main point of sentence K${i + 1} of \`skipped_sentences\`, in any wording?`,
        criteria: {
          true: 'The speaker said this point, possibly in different words.',
          false: 'The speaker did not say this point.',
        },
      };
    }
  });
  const res = await ask(state, questions, { timeoutMs: 6000, retries: 1 });
  const a = res.answers || {};
  const out = list.map((text, i) => ({ text, important: a[`important_${i}`]?.noul ?? null, covered: a[`covered_${i}`]?.noul ?? null }));
  const uncovered = out.filter((x) => (x.covered ?? 0) < 0.5);
  return {
    sentences: out,
    important: uncovered.reduce((m, x) => Math.max(m, x.important ?? 0), 0),
    model: res.model,
  };
}

// ---------------------------------------------------------------- outline

const IMPORTANCE_LEVELS = [
  'Filler: a greeting, thanks, transition, or signpost with no content of its own.',
  'Supporting detail: an example, elaboration, or restatement that helps but could be dropped.',
  'Important point: a claim, fact, number, or step the audience should remember, or an instruction, assignment, or deadline the audience must act on.',
  'Central point: the main message of its paragraph.',
];

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Analyze one paragraph: importance + key fragment for each sentence, and
// the main sentence of the paragraph.
async function analyzeParagraph(doc, para) {
  const section = doc.sections[para.section];
  const sentIds = [];
  for (let si = para.sentStart; si < para.sentEnd; si++) sentIds.push(si);
  const label = (si) => `S${si - para.sentStart + 1}`;
  const state = {
    talk_title: doc.title || (doc.sections[0] && doc.sections[0].title) || '',
    section_title: section ? section.title : '',
    paragraph: sentIds.map((si) => `${label(si)}| ${doc.sents[si].text}`).join('\n'),
  };
  const questions = {};
  const cands = {};
  for (const si of sentIds) {
    questions[`imp_${si}`] = {
      type: 'score',
      instructions: `How important is sentence ${label(si)} of \`paragraph\` for the audience to understand the talk?`,
      criteria: IMPORTANCE_LEVELS,
    };
    const cs = keyphraseCandidates(doc, si);
    cands[si] = cs;
    if (cs.length >= 2) {
      questions[`kp_${si}`] = {
        type: 'choice',
        instructions: `Which fragment of sentence ${label(si)} works best as a short cue that reminds the speaker what the sentence says? Prefer the fragment with the sentence's most informative words.`,
        criteria: Object.fromEntries(cs.map((c) => [c.id, c.text])),
      };
    }
  }
  if (sentIds.length >= 2) {
    questions.main = {
      type: 'choice',
      instructions: 'Which sentence of `paragraph` states its main idea?',
      criteria: Object.fromEntries(sentIds.map((si) => [label(si), doc.sents[si].text])),
    };
  }
  const res = await ask(state, questions, { timeoutMs: 15000, retries: 2 });
  const a = res.answers || {};
  // Stored relative to the paragraph so cached results survive edits
  // elsewhere in the script.
  const sents = sentIds.map((si) => {
    const imp = a[`imp_${si}`];
    const cs = cands[si];
    let kp = cs.length === 1 ? cs[0] : null;
    let kpConf = null;
    const kpa = a[`kp_${si}`];
    if (kpa) {
      kp = cs.find((c) => c.id === kpa.choice) || null;
      kpConf = kpa.confidence;
    }
    return {
      text: doc.sents[si].text,
      imp: imp ? imp.score : 1.5,
      impConf: imp ? imp.confidence : null,
      kp: kp && { relPhrase: kp.phrase - doc.sents[si].phStart, pa: kp.pa, pb: kp.pb, text: kp.text },
      kpConf,
    };
  });
  let mainRel = 0;
  if (a.main && /^S\d+$/.test(a.main.choice)) mainRel = parseInt(a.main.choice.slice(1), 10) - 1;
  return { sents, mainRel, mainConf: a.main ? a.main.confidence : null, tokens: res.usage?.input_tokens || 0, model: res.model };
}

// Whole-document outline with a per-paragraph cache.
export async function analyzeOutline(doc, cache) {
  const results = await mapLimit(doc.paras, 8, async (para) => {
    const key = `outline:qa-rubric:${doc.lang}:${hash(`${doc.sections[para.section]?.title}\n${para.text}`)}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
    const r = await analyzeParagraph(doc, para);
    cache.set(key, r);
    return r;
  });
  const out = { source: 'jev', sents: {}, paras: {}, tokens: 0, errors: 0, cachedParas: 0 };
  results.forEach((r, pi) => {
    const para = doc.paras[pi];
    if (!r || r.error) {
      out.errors++;
      return;
    }
    r.sents.forEach((v, k) => {
      const si = para.sentStart + k;
      const s = doc.sents[si];
      if (!s || s.text !== v.text) return;
      out.sents[si] = {
        text: v.text, imp: v.imp, impConf: v.impConf, kpConf: v.kpConf,
        kp: v.kp && { phrase: s.phStart + v.kp.relPhrase, pa: v.kp.pa, pb: v.kp.pb, text: v.kp.text },
      };
    });
    out.paras[pi] = { text: para.text, main: Math.min(para.sentEnd - 1, para.sentStart + r.mainRel), mainConf: r.mainConf };
    if (r.cached) out.cachedParas++;
    else out.tokens += r.tokens;
  });
  return out;
}

