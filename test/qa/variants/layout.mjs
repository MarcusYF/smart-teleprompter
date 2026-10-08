// State layout used by V2-V4: the padded lead-in (script words the speaker had
// just read) is separated from the words said since leaving the script, and
// script lines are split into earlier / current / later blocks so the
// position relation is explicit rather than inferred from ids.
import { scriptLines } from './common.mjs';

export function splitLines(p, lines) {
  const cur = /^P\d+$/.test(p.curId || '') ? parseInt(p.curId.slice(1), 10) : -1;
  const idx = (c) => parseInt(c.id.slice(1), 10);
  return {
    earlier: lines.filter((c) => idx(c) < cur),
    current: lines.filter((c) => idx(c) === cur),
    later: lines.filter((c) => idx(c) > cur),
  };
}

export function layoutState(p, lines) {
  const s = splitLines(p, lines);
  const state = {
    current_script_line: scriptLines(s.current) || p.current || '',
    current_sentence: p.sentence || '',
  };
  if (p.leadIn) state.words_just_read_from_script = p.leadIn;
  state.new_speech = p.speech ?? p.offScript ?? '';
  state.earlier_script_lines = scriptLines(s.earlier);
  state.later_script_lines = scriptLines(s.later);
  return state;
}

export const ASR_NOTE = 'The speech comes from automatic speech recognition: no punctuation, and it may contain wrong words, homophones, split or merged words, and fillers.';
export const LEAD_NOTE = '`words_just_read_from_script` (if present) are the last script words the speaker read before `new_speech`; they are context, not part of the new speech.';
