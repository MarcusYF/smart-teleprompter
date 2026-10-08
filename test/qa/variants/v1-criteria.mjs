// V1: same state and questions as server/semantic.mjs, but the relation
// options are structured (what / not_for) and name the two confusions seen in
// the baseline: the padded lead-in words that repeat the script just read, and
// slips that contain words from elsewhere in the script. Adds `unclear`.
// Server-only change.
import { run, pickChoice, scriptLines, whereCriteria } from './common.mjs';

export const RELATION = {
  type: 'choice',
  instructions: {
    question: 'A speaker is giving a talk from a prepared script. `off_script_speech` is what they said since they last followed the script word for word. `current_script_phrase` is where the teleprompter thinks they are. What is the speaker doing?',
    note: 'The speech comes from automatic speech recognition: no punctuation, and it may contain wrong words, homophones, split or merged words, and fillers.',
    lead_in: 'The first words of `off_script_speech` can repeat the end of `script_before_current`, which the speaker had just read. Those words are not a return to earlier content; judge what comes after them.',
  },
  criteria: {
    reading_current: {
      what: 'Reading `current_script_phrase` or the text right after it almost word for word; the differences are only recognition errors.',
    },
    paraphrase: {
      what: 'Saying the content of the current or the next script sentence in noticeably different words.',
      not_for: 'A new example, story, opinion, or explanation that the script does not contain.',
    },
    adlib_related: {
      what: 'Adding their own comment, example, story, analogy, joke, or explanation that is related to the talk but is not in the script.',
      not_for: 'Restating a script sentence in other words.',
    },
    false_start: {
      what: 'A slip or stumble: breaking off a word and restarting, or saying a wrong word or phrase and then correcting it (no, sorry, I mean, 不对, 说错了).',
      note: 'The wrong words can come from another part of the script; followed by a correction they are a slip, not a jump.',
    },
    jumped_ahead: {
      what: 'Reading or paraphrasing content that appears later in `script_lines`, after the current phrase, so part of the script was skipped.',
      not_for: 'Script words said by mistake and then corrected.',
    },
    went_back: {
      what: 'Returning to or repeating content from earlier in `script_lines`, before the current phrase.',
      not_for: 'Opening words that repeat the end of `script_before_current`, or a script term mentioned inside an aside.',
    },
    unrelated: {
      what: 'Talking about something unrelated to the content of the talk, such as logistics, technical problems, time, or chatting with the audience.',
      note: 'It can mention a word that also appears in the script.',
    },
    unclear: {
      what: 'There is too little speech so far to tell which of the other options applies.',
    },
  },
};

export async function trackJudgment(p) {
  const lines = (p.candidates || []).slice(0, 60);
  const state = {
    script_before_current: p.before || '',
    current_script_phrase: p.current || '',
    current_sentence: p.sentence || '',
    script_after_current: p.after || '',
    off_script_speech: p.offScript || p.recent || '',
    script_lines: scriptLines(lines),
  };
  const questions = {
    relation: RELATION,
    where: {
      type: 'choice',
      instructions: 'Which line of `script_lines` is the speaker saying (reading or paraphrasing) at the end of `off_script_speech`? Opening words that repeat the end of `script_before_current` do not count. Choose none if the speech does not correspond to any line.',
      criteria: whereCriteria(lines),
    },
    on_script: {
      type: 'noul',
      instructions: 'Is the end of `off_script_speech` a reading or a paraphrase of some line of `script_lines`?',
      criteria: {
        true: 'The speaker is saying content that is in the script, possibly in other words.',
        false: 'The speaker is saying something that is not in the script.',
      },
    },
    covered: {
      type: 'noul',
      instructions: 'In `off_script_speech`, has the speaker already expressed the main point of `current_sentence`, in any wording?',
      criteria: {
        true: 'The main point of the current sentence has been said, even if with different words.',
        false: 'The main point of the current sentence has not been said yet.',
      },
    },
  };
  return run(state, questions, (a) => ({
    relation: pickChoice(a.relation),
    where: pickChoice(a.where),
    onScript: a.on_script?.noul ?? null,
    covered: a.covered?.noul ?? null,
  }));
}
