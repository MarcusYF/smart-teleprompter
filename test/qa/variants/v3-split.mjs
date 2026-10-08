// V3: split judgment. Jev answers what kind of speech it is (no positions) and
// which line; code derives jumped_ahead / went_back from where the line is
// relative to the current sentence (candidates carry their sentence index).
// Same layout as V2.
import { run, pickChoice, whereCriteria } from './common.mjs';
import { layoutState, ASR_NOTE, LEAD_NOTE } from './layout.mjs';

export const MANNER = {
  type: 'choice',
  instructions: {
    question: 'A speaker is giving a talk from a prepared script. `new_speech` is what they said since they last followed the script word for word. What kind of speech is `new_speech`?',
    note: ASR_NOTE,
    context: LEAD_NOTE,
  },
  criteria: {
    reading: { what: 'Reading some part of the script almost word for word; the differences are only recognition errors.' },
    paraphrase: {
      what: 'Saying the content of some script sentence in noticeably different words.',
      not_for: 'A new example, story, opinion, or explanation that the script does not contain.',
    },
    own_words: {
      what: 'Their own comment, example, story, analogy, joke, or explanation that is related to the talk but is not in the script.',
      not_for: 'Restating a script sentence in other words.',
    },
    slip: {
      what: 'A slip or stumble: breaking off a word and restarting, or saying a wrong word or phrase and then correcting it.',
      note: 'The wrong words can come from another part of the script.',
    },
    off_topic: {
      what: 'Something unrelated to the content of the talk, such as logistics, technical problems, time, or chatting with the audience.',
      note: 'It can mention a word that also appears in the script.',
    },
    unclear: { what: 'There is too little speech so far to tell.' },
  },
};

const MAP = { own_words: 'adlib_related', slip: 'false_start', off_topic: 'unrelated', unclear: 'unclear' };

// Derive the prompter relation in code (would live in Follower.applySemantic).
export function deriveRelation(p, manner, where) {
  if (MAP[manner]) return MAP[manner];
  const sentOf = Object.fromEntries((p.candidates || []).map((c) => [c.id, c.sent]));
  const cs = sentOf[p.curId];
  const ws = where && where !== 'none' ? sentOf[where] : undefined;
  if (ws === undefined || cs === undefined) return manner === 'reading' ? 'reading_current' : 'paraphrase';
  if (ws < cs) return 'went_back';
  if (ws > cs + 1) return 'jumped_ahead';
  return manner === 'reading' ? 'reading_current' : 'paraphrase';
}

export async function trackJudgment(p) {
  const lines = (p.candidates || []).slice(0, 60);
  const state = layoutState(p, lines);
  const questions = {
    manner: MANNER,
    where: {
      type: 'choice',
      instructions: 'Which script line (in `earlier_script_lines`, `current_script_line`, or `later_script_lines`) is the speaker saying (reading or paraphrasing) at the end of `new_speech`? Choose none if the speech does not correspond to any line.',
      criteria: whereCriteria(lines),
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
  return run(state, questions, (a) => {
    const m = pickChoice(a.manner);
    const w = pickChoice(a.where);
    const label = m ? deriveRelation(p, m.choice, w && w.choice) : null;
    // relation keeps the manner distribution so relP gates still apply
    return {
      manner: m,
      relation: m && { choice: label, confidence: m.confidence, probabilities: { ...m.probabilities, [label]: m.probabilities[m.choice] } },
      where: w,
      onScript: a.on_script?.noul ?? null,
      covered: a.covered?.noul ?? null,
    };
  });
}
