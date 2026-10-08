// Jev judgments for the teleprompter. Code owns the workflow; Jev answers
// narrow questions:
//   track     what is the speaker doing while off script, and where are they
//   skipped   did an omitted passage contain an important point
//   outline   per-sentence importance, key fragment, per-paragraph main idea
//   slides    which script paragraph belongs to each slide

import { createHash } from 'node:crypto';
import { ask, mapLimit, JEV_MODEL } from './jev.mjs';
import { keyphraseCandidates } from '../public/lib/outline.js';

export const PROMPT_VERSION = 'v5'; // validated answers and model/title-scoped cache

// ------------------------------------------------------------------ track

// The client sends the words said since the speaker left the script
// (`speech`), the script words read just before them (`leadIn`, context so a
// judgment never sees a fragment), and the current phrase id (`curId`).
// Script lines are laid out as earlier / current / later so Jev does not
// have to infer order from ids, and the lead-in is labeled as context so it
// is not mistaken for going back (QA: first-request accuracy 0.46 -> 0.70).
const ASR_NOTE = 'The speech comes from automatic speech recognition: no punctuation, and it may contain wrong words, homophones, split or merged words, and fillers.';
const LEAD_NOTE = '`words_just_read_from_script` (if present) are the last script words the speaker read before `new_speech`; they are context, not part of the new speech.';

const RELATION = {
  type: 'choice',
  instructions: {
    question: 'A speaker is giving a talk from a prepared script. `new_speech` is what they said since they last followed the script word for word. `current_script_line` is where the teleprompter thinks they are. What is the speaker doing?',
    note: ASR_NOTE,
    context: LEAD_NOTE,
  },
  criteria: {
    reading_current: 'Reading `current_script_line` or the text right after it almost word for word; the differences are only recognition errors.',
    paraphrase: 'Expressing the same meaning as `current_sentence` or the next script sentence, but in noticeably different words.',
    adlib_related: 'Adding their own comment, example, story, joke, or explanation that is related to the current topic but is not in the script.',
    false_start: 'A slip of the tongue, stumble, or self-correction, such as breaking off a word and restarting, or saying sorry, let me say that again.',
    jumped_ahead: 'Saying content from `later_script_lines`, so part of the script was skipped.',
    went_back: 'Repeating or returning to content from `earlier_script_lines`.',
    unrelated: 'Talking about something unrelated to the script, such as logistics, technical problems, or chatting with the audience.',
  },
};

function scriptLayout(p, lines) {
  let cur = /^P\d+$/.test(p.curId || '') ? parseInt(p.curId.slice(1), 10) : -1;
  if (cur < 0) {
    // older client without curId: locate the current phrase by its text
    const m = lines.find((c) => c.text === p.current);
    cur = m ? parseInt(m.id.slice(1), 10) : -1;
  }
  const idx = (c) => parseInt(c.id.slice(1), 10);
  const fmt = (xs) => xs.map((c) => `${c.id}| ${c.text}`).join('\n');
  return {
    current: fmt(lines.filter((c) => idx(c) === cur)) || p.current || '',
    earlier: fmt(lines.filter((c) => idx(c) < cur)),
    later: fmt(lines.filter((c) => idx(c) > cur)),
  };
}

export async function trackJudgment(p, { signal } = {}) {
  const lines = (p.candidates || []).slice(0, 60);
  const layout = scriptLayout(p, lines);
  const state = {
    current_script_line: layout.current,
    current_sentence: p.sentence || '',
  };
  if (p.leadIn) state.words_just_read_from_script = p.leadIn;
  state.new_speech = p.speech ?? p.offScript ?? p.recent ?? '';
  state.earlier_script_lines = layout.earlier;
  state.later_script_lines = layout.later;
  const whereCriteria = Object.fromEntries(lines.map((c) => [c.id, null]));
  whereCriteria.none = 'The speech does not correspond to any line of the script.';
  const questions = {
    relation: RELATION,
    where: {
      type: 'choice',
      instructions: 'Which script line (in `earlier_script_lines`, `current_script_line`, or `later_script_lines`) is the speaker saying (reading or paraphrasing) at the end of `new_speech`? Choose none if the speech does not correspond to any line.',
      criteria: whereCriteria,
    },
    on_script: {
      type: 'noul',
      instructions: 'Is the end of `new_speech` a reading or a paraphrase of some script line?',
      criteria: {
        true: 'The speaker is saying content that is in the script, possibly in other words.',
        false: 'The speaker is saying something that is not in the script.',
      },
    },
    covered: {
      type: 'noul',
      instructions: 'In `new_speech`, has the speaker already expressed the main point of `current_sentence`, in any wording?',
      criteria: {
        true: 'The main point of the current sentence has been said, even if with different words.',
        false: 'The main point of the current sentence has not been said yet.',
      },
    },
  };
  const t0 = Date.now();
  const res = await ask(state, questions, { timeoutMs: 5000, retries: 1, signal });
  const a = res.answers || {};
  return {
    relation: pickChoice(a.relation),
    where: pickChoice(a.where),
    onScript: a.on_script?.noul ?? null,
    covered: a.covered?.noul ?? null,
    ms: Date.now() - t0,
    model: res.model,
    tokens: res.usage?.input_tokens,
  };
}

function pickChoice(ans) {
  if (!ans) return null;
  return { choice: ans.choice, confidence: ans.confidence, probabilities: ans.probabilities };
}

// ---------------------------------------------------------------- skipped

// Judged per sentence: a long skipped passage mixes key points with filler,
// and one serious omission is enough for a reminder. Each sentence is also
// checked against what the speaker actually said, so a paraphrase is not
// reported as an omission.
export async function skippedJudgment({ sentences, skipped, context, spoken }, { signal } = {}) {
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
      instructions: `The speaker skipped these parts of the script while giving a talk (\`surrounding_script\` shows the context). Does part K${i + 1} of \`skipped_sentences\` state an important point that the audience would miss, such as a key fact, number, definition, step, argument, or an instruction, assignment, or deadline for the audience?`,
      criteria: {
        true: 'It carries content the talk depends on; the speaker should go back to it.',
        false: 'It is a transition, signpost, repetition, aside, or minor detail that can be dropped.',
      },
    };
    if (spoken) {
      questions[`covered_${i}`] = {
        type: 'noul',
        instructions: `In \`recent_speech\` (speech recognition output, no punctuation), did the speaker say the content of part K${i + 1} of \`skipped_sentences\` itself, in any wording? Saying nearby or related content does not count.`,
        criteria: {
          true: 'The speaker said this point, possibly in different words.',
          false: 'The speaker did not say this point.',
        },
      };
    }
  });
  const res = await ask(state, questions, { timeoutMs: 6000, retries: 1, signal });
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
async function analyzeParagraph(doc, para, signal) {
  const section = doc.sections[para.section];
  const sentIds = [];
  for (let si = para.sentStart; si < para.sentEnd; si++) sentIds.push(si);
  if (!sentIds.length) return { sents: [], mainRel: 0, tokens: 0, model: null };
  if (sentIds.length > 255) throw new Error('Split paragraphs longer than 255 sentences before requesting a Jev outline');
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
  const res = await ask(state, questions, { timeoutMs: 15000, retries: 2, signal });
  const a = res.answers || {};
  // Stored relative to the paragraph so cached results survive edits
  // elsewhere in the script.
  const sents = sentIds.map((si) => {
    const imp = a[`imp_${si}`];
    if (!imp || !Number.isFinite(imp.score)) throw new Error('Jev returned no usable sentence importance');
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
      imp: Math.max(0, Math.min(3, imp.score)),
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
export async function analyzeOutline(doc, cache, { signal } = {}) {
  const results = await mapLimit(doc.paras, 8, async (para) => {
    const key = `outline:${PROMPT_VERSION}:${JEV_MODEL}:${doc.lang}:${hash(`${doc.title}\n${doc.sections[para.section]?.title}\n${para.text}`)}`;
    const hit = cache.get(key);
    if (hit && (JEV_MODEL !== 'jev-latest' || Date.now() - (hit.cachedAt || 0) < 24 * 60 * 60 * 1000)) return { ...hit, cached: true };
    const r = await analyzeParagraph(doc, para, signal);
    cache.set(key, { ...r, cachedAt: Date.now() });
    return r;
  }, { signal });
  const out = { source: 'jev', model: JEV_MODEL, promptVersion: PROMPT_VERSION, models: [...new Set(results.map((r) => r?.model).filter(Boolean))], sents: {}, paras: {}, tokens: 0, errors: 0, cachedParas: 0 };
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

// ----------------------------------------------------------------- slides

// Map each slide to the paragraph where its part of the talk starts.
// Jev scores slide-paragraph fit; a monotonic assignment is solved in code.
export async function alignSlides(doc, slides, { signal } = {}) {
  const paras = doc.paras.filter((p) => p.tokEnd > p.tokStart);
  if (paras.length > 250) throw Object.assign(new Error('Script has more than 250 spoken paragraphs; add explicit [slide N] markers'), { status: 422 });
  if (!paras.length || !slides.length) throw Object.assign(new Error('Alignment requires script text and slides'), { status: 400 });
  if (slides.some((s) => !Number.isInteger(s.n) || s.n < 1) || new Set(slides.map((s) => s.n)).size !== slides.length) throw Object.assign(new Error('Invalid slide numbers'), { status: 400 });
  slides = [...slides].sort((a, b) => a.n - b.n);
  const lines = paras.map((p, i) => `A${i}| ${p.text.slice(0, doc.lang === 'zh' ? 90 : 220)}`).join('\n');
  const answers = await mapLimit(slides, 8, async (sl) => {
    const state = {
      slide: { number: sl.n, title: sl.title || '', text: (sl.body || '').slice(0, 600), presenter_notes: (sl.notes || '').slice(0, 600) },
      script_paragraphs: lines,
    };
    const res = await ask(state, {
      para: {
        type: 'choice',
        instructions: 'While this slide is shown, the speaker reads part of the script. Which paragraph of `script_paragraphs` would the speaker say first while showing `slide`?',
        criteria: { ...Object.fromEntries(paras.map((_, i) => [`A${i}`, null])), none: 'No spoken paragraph matches this slide, including picture-only slides.' },
      },
    }, { timeoutMs: 15000, retries: 2, signal });
    const pr = res.answers?.para?.probabilities;
    if (!pr || !paras.some((_, i) => Number.isFinite(pr[`A${i}`]) && pr[`A${i}`] > 0 && pr[`A${i}`] <= 1)) throw new Error('Jev returned no usable alignment');
    return pr;
  }, { signal });
  const errors = answers.filter((a) => a.error);
  if (errors.length) throw Object.assign(new Error(`Alignment failed for ${errors.length}/${slides.length} slides: ${errors[0].error}`), { status: 502 });
  // DP: slides in order map to non-decreasing paragraph indices.
  const S = slides.length;
  const P = paras.length;
  const logp = answers.map((pr) => paras.map((_, i) => Math.log((pr && pr[`A${i}`]) || 1e-4)));
  const dp = Array.from({ length: S }, () => new Float64Array(P).fill(-Infinity));
  const bp = Array.from({ length: S }, () => new Int32Array(P).fill(-1));
  for (let i = 0; i < P; i++) dp[0][i] = logp[0][i] - 0.02 * i;
  for (let s = 1; s < S; s++) {
    let bestPrev = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < P; i++) {
      if (dp[s - 1][i] > bestPrev) {
        bestPrev = dp[s - 1][i];
        bestIdx = i;
      }
      dp[s][i] = bestPrev + logp[s][i];
      bp[s][i] = bestIdx;
    }
  }
  let end = 0;
  for (let i = 1; i < P; i++) if (dp[S - 1][i] > dp[S - 1][end]) end = i;
  const assign = new Array(S);
  for (let s = S - 1; s >= 0; s--) {
    assign[s] = end;
    end = s > 0 ? bp[s][end] : end;
  }
  return {
    model: JEV_MODEL,
    needsReview: assign.some((p, s) => Math.exp(logp[s][p]) < 0.45 || (answers[s].none || 0) >= Math.exp(logp[s][p]) || (s > 0 && p === assign[s - 1])),
    mapping: slides.map((sl, s) => ({ n: sl.n, para: paras[assign[s]].idx, tokStart: paras[assign[s]].tokStart, p: Math.exp(logp[s][assign[s]]), noMatch: (answers[s].none || 0) >= Math.exp(logp[s][assign[s]]) })),
  };
}
