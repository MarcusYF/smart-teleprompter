# Changelog

## 1.4.3 (19) — 2026-10-19

- A script stays linked to its Keynote deck after Keynote restarts. Decks were
  identified by Keynote's document id, which changes every time a document is
  opened, so after a restart the prompter treated the deck as a different
  document, stopped following slides and paused automatic control. Decks are
  now identified by their file; an unsaved deck uses its session id until it is
  saved, and saving it is not a change of deck. Scripts saved by earlier
  versions are matched by deck name and then tied to the file.
- The click guard tolerates the moment when Keynote reports no current slide
  (at the start of a recording).

## 1.4.2 (18) — 2026-10-19

- A click on the script, or an arrow-key move in the prompter, sets the
  position by hand and overrides the automatic one. Sentences passed over are
  no longer counted as missed, and their reminders close. While listening and
  linked, the slide show catches up at once. Every build marked up to the
  clicked word plays about 150 ms apart; on a later slide, the rest of the
  current slide plays (including builds without markers, when the deck's
  counts are known) and the slides in between are turned. A click on an
  earlier slide moves only the text.
- A click also takes back a slide the speaker had turned back to by hand.
- In the floating presentation window, the first click on the script reaches
  the page.

## 1.4.1 (17) — 2026-10-19

- The Mac app no longer quits when a confirmation dialog closes, for example
  "Replace the current script with Keynote notes?". The prompter window is a
  panel, which AppKit does not count as a window, so closing any dialog looked
  like closing the last window. The app now quits when the prompter window
  closes.
- Dialogs appear above the prompter while it floats over a slide show.

## 1.4.0 (16) — 2026-10-19

- Animations follow speech in imported decks without `[click]` markers. Import
  reads each slide's builds from the saved `.key` file and places one marker per
  build, before the sentence that first mentions what the build reveals; picture
  and formula builds are spaced between their neighbours at paragraph starts.
  Previously every build waited for the end of the slide's text and then flashed
  by, and a slide with more than six unmarked builds never turned automatically.
- Slides whose existing markers do not match their builds get a `// ⚠` line in
  the imported script; the import message counts placed markers and warns about
  unsaved Keynote changes.
- During a show, the prompter reads the saved deck's build count per slide. It
  ignores markers beyond that count (their click would turn the slide early),
  classifies manual clicks as builds or the page turn, and clicks through every
  unmarked build before a page turn.
- A pause within the last few words of a slide (three in English, six characters
  in Chinese) turns the page when the recognizer misses the final words.
- A manual click on a slide before any recognized speech there no longer blocks
  that slide's automatic page turn.
- The log records, for each page turn the speech did not make, how far the speech
  was from the slide's end and what drove the show (no transcript text).

## 1.3.1 (15) — 2026-10-18

- On-device recognition recovers when the input device changes mode. A Bluetooth
  headset switching to its microphone profile used to stop the audio engine for
  good, so listening produced no sound. The helper now waits for the device to
  settle, reattaches the same audio engine (keeping the input open), rebuilds it
  only when audio stops arriving, rate-limits restarts, and reports an error if
  the microphone stays silent.
- When on-device listening hears nothing for 12 seconds, the app restarts it once
  quietly before warning.
- The no-sound and no-words messages for on-device recognition name the input
  device, Bluetooth headsets and the app's microphone permission instead of Chrome.

## 1.3.0 (14) — 2026-10-08

- Standalone Apple Silicon macOS 26+ app with bundled front end, server, official
  Node.js 24.21.0 runtime, and compiled Apple SpeechAnalyzer helper.
- Removes the developer checkout path and external Node installation dependency.
- Persists Mac app scripts, caches, and logs in per-user Application Support.
- Adds secure Jev key configuration and a data-folder menu.
- Wraps editor controls so the Start button remains accessible with long English labels.
- Verifies backend instance identity to avoid connecting a new app to an old server.
- Adds an isolated, relocated/read-only bundle check, public installation/privacy
  docs, MIT license, Node license notices, and GitHub Actions workflows.
- Keeps the 1.2 voice-following, formula, outline, and slideshow reliability fixes.

## 1.2.1 (13)

- Displays the actual bundle version and build number in all native window modes.

## 1.2 (12)

- Cancels pending slideshow control on pause, stop, or lost connection.
- Pauses control after errors and does not count failed clicks as completed.
- Isolates recognizer sessions and discards obsolete semantic responses.
- Preserves animation counts and reviewed slide mappings through refresh.
- Handles save errors, consecutive formulas, and unsaved editing more reliably.
- Guards control by document/page identity and single-window ownership.
