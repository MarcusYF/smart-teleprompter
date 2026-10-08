// V2: baseline questions and option texts, new state layout (see layout.mjs).
// Needs the client to send leadIn / speech / curId.
import { run, pickChoice, whereCriteria } from './common.mjs';
import { layoutState, ASR_NOTE, LEAD_NOTE } from './layout.mjs';

export async function trackJudgment(p) {
  const lines = (p.candidates || []).slice(0, 60);
  const state = layoutState(p, lines);
  const questions = {
    relation: {
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
    },
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
  return run(state, questions, (a) => ({
    relation: pickChoice(a.relation),
    where: pickChoice(a.where),
    onScript: a.on_script?.noul ?? null,
    covered: a.covered?.noul ?? null,
  }));
}
