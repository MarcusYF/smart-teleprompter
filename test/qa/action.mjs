// What the prompter does with a judgment.
//   realAction()  runs the app's own Follower.applySemantic (current rules)
//   simAction()   the same rules with tunable thresholds / policies, used to
//                 evaluate threshold changes offline on stored answers
import { Follower } from '../../public/lib/follower.js';
import { phraseIdx } from './lib.mjs';

export const ON_SCRIPT_LABELS = ['jumped_ahead', 'went_back', 'paraphrase', 'reading_current'];

export function realAction(doc, cur, j) {
  const f = new Follower(doc);
  const pos = doc.phrases[cur].tokStart;
  f.tracker.setPosition(pos);
  f.pos = pos;
  f.maxPos = pos;
  f.run = 6;
  f.status = 'offscript';
  const action = f.applySemantic({ ...j, requestPos: pos });
  return { action, final: doc.tokens[Math.min(f.pos, doc.tokens.length - 1)].phrase };
}

export const CURRENT_T = { whereP: 0.4, onScript: 0.5, covered: 0.6 };

// Mirror of Follower.applySemantic (HEAD 8013d1e) with tunable thresholds.
// Optional policy guards, all off by default:
//   direction    went_back needs where < cur, jumped_ahead needs where > cur
//   minBack      a backward move needs cur - where >= minBack phrases
//   relP         minimum probability of the relation label for a jump
//   farPhrases/farWhereP   stricter whereP for moves longer than farPhrases
//   coveredFirst paraphrase + covered moves to the next sentence even when
//                `where` points inside the current sentence
//   manner       split variants: relation derived from where vs cur in code
export function simAction(doc, cur, j, opts = {}) {
  const T = { ...CURRENT_T, ...opts };
  const rel = j.relation || {};
  const label = rel.choice;
  const relP = rel.probabilities ? rel.probabilities[label] ?? 0 : 0;
  const whereIdx = j.where ? phraseIdx(j.where.choice) : -1;
  const whereP = j.where && j.where.probabilities ? j.where.probabilities[j.where.choice] || 0 : 0;
  const onScript = j.onScript ?? 1;
  const covered = j.covered ?? 0;
  const ph = doc.phrases;
  const moveLabels = T.moveLabels || ON_SCRIPT_LABELS;
  const backInSentence = whereIdx >= 0 && whereIdx < cur && ph[whereIdx] &&
    ph[whereIdx].sent === ph[cur].sent && (label === 'paraphrase' || label === 'reading_current');
  const dirBad = !!T.direction && whereIdx >= 0 && ((label === 'went_back' && whereIdx > cur) || (label === 'jumped_ahead' && whereIdx < cur));
  const tooClose = T.minBack != null && whereIdx >= 0 && whereIdx < cur && cur - whereIdx < T.minBack;
  const relOk = T.relP == null || relP >= T.relP;
  const dist = whereIdx >= 0 ? Math.abs(whereIdx - cur) : 0;
  const needWhereP = T.farPhrases != null && dist > T.farPhrases ? Math.max(T.whereP, T.farWhereP ?? T.whereP) : T.whereP;
  const coveredFirst = !!T.coveredFirst && label === 'paraphrase' && covered >= T.covered &&
    (whereIdx < 0 || !ph[whereIdx] || ph[whereIdx].sent === ph[cur].sent);
  if (!coveredFirst && moveLabels.includes(label) && whereIdx >= 0 && ph[whereIdx] && whereP >= needWhereP &&
      onScript >= T.onScript && whereIdx !== cur && !backInSentence && !dirBad && !tooClose && relOk) {
    return { action: whereIdx > cur ? 'jump-forward' : 'jump-back', final: whereIdx };
  }
  if (label === 'paraphrase' && covered >= T.covered && (T.relPAdvance == null || relP >= T.relPAdvance)) {
    const sent = doc.sents[ph[cur].sent];
    const next = doc.sents[sent.idx + 1];
    if (next) return { action: 'advance-sentence', final: next.phStart };
  }
  return { action: 'hold', final: cur };
}

// Outcome of the displayed phrase vs the case's ideal.
//   correct   within tolerance (exact for hold cases, +-1 phrase otherwise)
//   held      stayed put although a move was ideal (benign miss)
//   partial   moved in the right direction but stopped short (benign)
//   wrong     moved when it should hold, moved the wrong way, or overshot
// With { path: true } (episodes, where a move can happen mid-stretch) any
// phrase the speaker covered during the stretch counts: [pathLo-1, expect+1].
export function pathOf(c) {
  const ids = [c.where, ...(c.whereOk || [])].map(phraseIdx).filter((x) => x >= 0);
  let lo = Math.min(c.expect, ...ids);
  if (c.label === 'paraphrase' || c.label === 'reading_current') lo = Math.min(lo, c.cur);
  return [lo, Math.max(c.expect, ...ids)];
}

export function outcome(c, final, { path = false } = {}) {
  const hold = c.expect === c.cur;
  if (hold) return final === c.cur ? 'correct' : 'wrong';
  if (Math.abs(final - c.expect) <= 1) return 'correct';
  if (path && final !== c.cur) {
    const [lo, hi] = pathOf(c);
    if (final >= lo - 1 && final <= hi + 1) return 'correct';
  }
  if (final === c.cur) return 'held';
  const dirOk = Math.sign(final - c.cur) === Math.sign(c.expect - c.cur);
  const short = Math.abs(final - c.cur) < Math.abs(c.expect - c.cur);
  return dirOk && short ? 'partial' : 'wrong';
}

export function expectedActionType(c) {
  if (c.expect === c.cur) return 'hold';
  return c.expect > c.cur ? 'forward' : 'back';
}

export function actionType(action) {
  if (action === 'hold' || action === 'stale') return 'hold';
  if (action === 'jump-back') return 'back';
  return 'forward';
}
