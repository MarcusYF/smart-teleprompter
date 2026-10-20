# Build-aware Keynote import and robust page turns

Source: user report, 2026-10-18 local: with the prompter driving a Keynote show, animations and page turns sometimes did not follow the speech.

## Diagnosis
- The client log of the reported session (a 14-slide deck, notes imported from Keynote) showed automatic page turns from only 5 slides. On two of them the turn first flashed through 2–3 leftover builds ("advance-extra-click"). On two more, one extra click followed within 2 s, either for a leftover build or racing a slow transition.
- The imported notes had no `[click]` markers. With no markers, every build waits for the end of the slide's text and is then clicked through in about 2 s per build; a slide with more than six unmarked builds never turns (1 + maxExtra 6 clicks).
- Keynote's AppleScript exposes no build information, so the import could not place markers.
- The remaining slide changes left no evidence of where the speech was; the log had no position data. Two code paths can block the end-of-text turn: the last words not being recognized (the trigger needed the final token), and a hand click before any recognized speech on the slide, which left `advanced` set for the rest of the slide.
- A late extra click once raced a slow slide transition; the in-Keynote slide guard rejected it ("Presentation changed before the click"), as designed.

## Change
- server/keynote-file.mjs: a zero-dependency reader of saved `.key` files (zip, snappy, protobuf). Per slide in show order, it returns the click count and the text each click reveals: a By-Paragraph build's k-th chunk shows paragraph k, and automatic chunks join the click before them. The message types and fields used are listed in its header. Anything unexpected yields null.
- public/lib/autoclick.js: places one `[click]` per build in notes without markers. It uses a monotone alignment of build text to sentences: IDF-weighted content words (en) or character pairs (zh), a 3-sentence window, slide abbreviations as prefixes, an even-spacing prior, a paragraph-start bonus and an opening-sentence penalty. It never places a marker after the last sentence.
- Import attaches the builds (file path via JXA `doc.file()`, unsaved state via `doc.modified()`), places markers, adds a `// ⚠` line where existing markers do not match the builds (one extra marker is accepted as the author's turn), and reports counts.
- `GET /api/slides/builds` returns the open deck's counts, cached by file stamp. During a show the controller uses them: it drops markers beyond the count, classifies hand clicks as builds or the turn, and allows one extra click per unmarked build. Counts are ignored while the deck has unsaved changes.
- BuildController: a `paused` view within the last 3 (en) / 6 (zh) tokens, capped at a quarter of the slide, also turns the slide. A hand click with no speech yet on the slide no longer blocks the turn. A `slide-change` log records turns the speech did not make (tokens left, status, marks, deck count; no text).

## Evidence and limits
- Placement versus 61 hand-placed markers in a verbatim-script lecture deck (one paragraph per build): 49 within 2 words, 51 within 12; several misses are picture or formula builds with no text.
- Real recognizer (`test/builds-e2e.mjs`, macOS `say` audio, simulated Keynote with the deck's build counts) on 5 slides of the reported deck with auto-placed markers: all 24 clicks within 1 s of their words, every page turn within 1 s of the slide's end, all builds shown. With each slide's last two words left out and a 2.5 s pause, every turn came 2.2–3.5 s after the speaker stopped. With only the default 0.8 s gap, two turns came about 5 s late, driven by the next slide's words. The same slides without markers (previous behaviour) showed no build during speech and turned 11–21 s late.
- Live Keynote 14.5 on a scratch copy: import placed 55 markers on 13 slides; `/api/slides/builds` matched; an unsaved edit was reported as unsaved; the original deck was not opened.
- 144 regression tests (12 new), 73 stress tests and the HTTP smoke test pass.
- Packaged as 1.4.0 (16): output/SmartTeleprompter-1.4.0-macOS-arm64.zip, SHA-256 441ef3aeff8b0a842abb6dc349e977266b38b4416573456c0dc6743307cb721e. Extracted signature and `tools/verify-bundle.mjs` passed; the bundled reader returned the expected counts. Not installed (the installed app is a developer build that runs this checkout) and not published.
- Not verified: a live show driven by a real microphone with these changes, decks saved by other Keynote versions, nested (indented) slides, and build types beyond appear/disappear by paragraph or all at once.

## Actions and open questions
- Publication of 1.3.1 and 1.4.0 needs the user's explicit go-ahead (a public push was blocked earlier).
- The verification Mac now lists only en-US as an installed on-device speech model; downloading zh-CN again needs the user's OK.
- Next live check: a real show with a microphone, using a deck imported with auto-placed markers; read the `slide-change` log lines afterwards.
