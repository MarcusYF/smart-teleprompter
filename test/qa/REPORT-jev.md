# Jev semantic layer evaluation (QA subagent, base 8013d1e, 2026-09-30)

Saved by the main session from the agent's hand-back (condensed). Spend ≈ $0.19. 56 dev + 28 held-out labeled off-script cases (7 labels, en + zh, 4 scripts, ASR-style text). Harness and raw results: test/qa/run-*.mjs, results/.

- Full off-script stretch, current prompts: relation 56/56 dev, 26/28 held-out; `where` top-1 88%, ±1 97%; p50 164 ms, p95 271 ms; ~1,590 tokens/request.
- What the speaker sees is decided by the first early request: label right 46% (dev) / 50% (held-out); 10/84 episodes ended in a wrong display move (9 on the first request). Causes: the padding of recently read script words looked like "went back"; slips containing later script words jumped without a probability check; far-back targets not among candidates.
- Recommended and applied: V2 state layout (current line, current sentence, words just read as labeled context, new speech, earlier/later script lines) + follower guards (label/line direction must agree, no jump back to the phrase just read, relation p ≥ 0.6). Wrong moves 10 → 1 of 84; correct 70 → 80; first-request accuracy 0.46 → 0.70 (dev), 0.50 → 0.82 (held-out); calibration ECE 0.13 → 0.07.
- Skipped reminders: rubric names "instruction, assignment, or deadline"; threshold 0.6 → 0.5: 22/22 (was 19/22).
- Outline: same rubric gap scored homework/deadlines as filler (0.28/0.48/1.32 → 1.96/1.89/1.95 with the rubric edit). Cue issues remaining: cues cannot span two phrases; some cues drop the key figure/operation.
- Risks: small self-written sample; thresholds tuned for jev-1.13.0 (re-run test/qa/run-track.mjs after model updates); Chinese did as well as English here.
