# Tracker / follower QA report (QA subagent, base 8013d1e, 2026-09-30)

Saved by the main session from the agent's hand-back (condensed; full scenario detail in the tracker-*.test.mjs files).

Result at 8013d1e: 49/73 scenario tests pass. With the prototype fixes (now merged): 72/73, main suite unchanged.

| Finding | Severity | Fix (merged) |
|---|---|---|
| F1 Off-script speech reusing script words drags the display forward (en ad-lib +35 tokens, zh Q&A +216); Jev judgments dropped as stale | critical | sticky off-script episode until the display re-anchors; in-order match streak gate for re-anchoring elsewhere (en 3 / zh 6, far en 5 / zh 7); judgments stay fresh inside an episode |
| F2 Withdrawn or shortened interims ('' with no final) move the display back 13–29 tokens; Apple-style short finals bounce | high | retracted hypotheses never move back; an interim emptied without a final is committed first; Chrome session end keeps the pending interim (engines.js) |
| F3 `_markSkips` LCS over whole span × recent words: 45–69 ms stall after a long Q&A | high (perf) | align only the window the recent words can cover, cached similarity rows, flat buffer: ~1 ms |
| F4 Skip marks wrong: one-word omissions, re-read passages, parallel list items, starting mid-script | medium | count rule (≥2 unsaid tokens and <50% said), moveSeq offset, re-read coverage on back moves, re-attribution on far jumps, first-anchor rule |
| F6 simulate.js garbles zh scripts with English words/decimals | low | units are pieces; Latin units joined with spaces |
| F7 Spelled-out acronyms ("P P O") | low | speechTokens merges single-letter runs |

Remaining: parallel list item 2 unmarked in 1/5 seeds (refrain words explain it equally well); going back is correct but slow (10–15 spoken units); 20k-token scripts could use a band-limited `_step`.
