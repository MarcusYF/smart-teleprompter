# UI acceptance report (QA subagent, build 8013d1e, 2026-09-30)

Saved by the main session from the agent's hand-back (the agent could not write files).

## Checklist summary
| # | Area | Result |
|---|------|--------|
| 1 | Editor | Partial: unsaved edits discarded without confirm (B8); stale "Saved"; library hidden ≤760px |
| 2 | Verbatim | Pass with notes: centring exact; pace/time-left misleading (m2) |
| 3 | ad-lib + skip + pause demo | Partial: skips not detected after a first pass (B2); wrong toast hint (m1) |
| 4 | Injected speech | Partial: English paraphrase bounced forward/back (B7); zh remark moved 2 chars (m12) |
| 5 | Granularity | Partial: Condensed ≈ Verbatim at default; Detail slider weak and visible at all levels (m7) |
| 6 | Controls | Partial: Flip vertically breaks scrolling (B1); mirror flips script only (m6) |
| 7 | Slides (External) | Partial: slide changes create false skip reminders (B3); `---` off by one (B6); no sync on open (m4) |
| 8 | Robustness | Partial: 700px English HUD overflow (B5); unpunctuated scripts split badly (m9) |

Performance: 20× script (4,120 tokens, 760 phrases): start 78 ms; onSpeech+render median 3.1 ms, p95 6.6 ms.

## Major
- B1 Flip vertically: offsets measured with getClientRects include the scaleY(-1) transform; current phrase goes off-screen.
- B2 jumpTo() keeps spokenTok/maxPos, so after one read-through skips are never detected again.
- B3 slideChanged() calls _markSkips; semantic checks run while not listening → false reminders from slide navigation.
- B4 Esc then Start rebuilds the Follower → position, timer, skips lost.
- B5 Narrow window: HUD overflows; label.detail display overrides [hidden].
- B6 `---` separators numbered off by one (text before the first rule is not slide 1).
- B7 English paraphrase: advance-sentence then went_back on the same speech → bounce, contradictory toasts.
- B8 Editor replaces unsaved text on New / sample / list click without confirm.

## Minor
m1 toast hints claim moves on hold; m2 pace/time-left from script progress swing wildly; m3 demo end leaves listening on;
m4 opening a script does not sync to the current slide, external slide not range-checked; m5 back move into mid-phrase marks it skipped;
m6 mirror only flips the scroller; m7 Condensed/Detail thresholds ineffective; m8 weak cues (whole-phrase candidates ending on 的, dropped head words);
m9 unpunctuated scripts split mid noun phrase / inside zh words; m10 library hidden ≤760px; m11 toasts under panels;
m12 Space shows Paused immediately; loose pinyin advance during a zh remark; skip marks never clear when read later.

## Polish
P1 simulator final before last interim (duplicate tails); P2 simulator joins English words in zh docs; P3 editor polish (stale Saved, units, delete confirm);
P4 text (untranslated demo buttons, repeated "Paraphrasing", mid-word cuts, Go back wraps, jargon toast, "Next → #2");
P5 snap scroll on new doc; P6 phrase starting at line end; P7 headings bar for 0-token section; P8 light-theme contrast; P9 slider values;
P10 fullscreen error hint; P11 ←/→ by visible item in outline levels.

## UX suggestions
1 keep status visible when HUD is quiet; 2 Esc should not lose the place; 3 skip reminders only while listening, never for slide jumps, a key for Go back;
4 pace from recognized words; 5 sync to the current slide on open; 6 outline ←/→ by item, Detail only where it matters; 7 mirror whole prompter.
