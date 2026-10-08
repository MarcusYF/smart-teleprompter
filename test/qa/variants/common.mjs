// Shared pieces for the prompt variants (copies of server/semantic.mjs's
// track question with edits). Uses the app's Jev client read-only.
import { ask } from '../../../server/jev.mjs';

export { ask };

export function pickChoice(ans) {
  if (!ans) return null;
  return { choice: ans.choice, confidence: ans.confidence, probabilities: ans.probabilities };
}

export function scriptLines(lines) {
  return lines.map((c) => `${c.id}| ${c.text}`).join('\n');
}

export function whereCriteria(lines, none = 'The speech does not correspond to any line of the script.') {
  const w = Object.fromEntries(lines.map((c) => [c.id, null]));
  w.none = none;
  return w;
}

export async function run(state, questions, pack) {
  const t0 = Date.now();
  const res = await ask(state, questions, { timeoutMs: 5000, retries: 1 });
  const a = res.answers || {};
  return { ...pack(a), ms: Date.now() - t0, model: res.model, tokens: res.usage?.input_tokens };
}
