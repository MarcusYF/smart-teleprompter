# Validation — 1.4.2 (18)

As of 2026-10-19. 1.4.2 adds manual positioning that overrides the automatic one:
a click on the script or an arrow-key move (web app). The show catches up in the
build controller. The native shell lets the first click reach the floating page.

Why: in a user test with a 13-slide deck (1.4.1, real microphone, Keynote
recording), 3 of 12 page turns came from speech. The others were turned by hand
while the tracked position was typically 20–60 words behind, after skipped
sentences, and 4 slides were left with builds unplayed.

| Check | Source of evidence | Result |
| --- | --- | --- |
| `npm test`, `npm run test:qa`, `npm run test:http` | unit / stress / localhost HTTP | 151 regression tests (7 new) and 73/73 stress tests passed; HTTP passed |
| Catch-up logic | unit tests with a simulated Keynote that knows its builds | a click later on the slide plays every marked build before it; a click two slides ahead plays the rest of the slide, turns a picture-only slide, then plays the target slide's builds (including `[click x2]`); unmarked builds are clicked through when the deck's counts are known; no clicks when not listening or for an earlier slide; a hand turn back cancels; catch-up clicks about 150 ms apart (speech-driven 450 ms) |
| Missed-sentence reminders | unit test | after a forward manual position, no phrase before it is marked skipped, pending checks are stale, and later automatic moves do not re-mark them |
| Click in the web page | built-in browser, development server, no microphone | a click on a word moved the reading position to that phrase; no console errors |
| ZIP extracted code-signature check, `tools/verify-bundle.mjs` | bundle | passed; Info.plist reports 1.4.2 (18) |

Not covered: the catch-up was not exercised against a live Keynote show (the
user's live retest is pending); the first-click change in the floating window
was compiled but not clicked by automation.

1.4.2 ZIP SHA-256: `3dd0fc102dab80ad3df69624c842a5881a5c7b143d6dab963743df59054af83a`.

---

## 1.4.1 (17)

As of 2026-10-19. 1.4.1 changes only the native shell: the app quit whenever a
JavaScript confirm or alert dialog closed (reported with "Replace the current
script with Keynote notes?"), and dialogs could sit below the floating prompter.

| Check | Source of evidence | Result |
| --- | --- | --- |
| Cause | minimal AppKit program with the shell's window setup | with an NSPanel as the only window and "terminate after last window closed", closing an NSAlert terminated the app; with an NSWindow it did not. With the fix (no automatic termination; quit when the panel closes), the alert closed without quitting and closing the panel quit |
| ZIP extracted code-signature check | bundle | `codesign --verify --deep --strict` passed; Info.plist reports 1.4.1 (17) |
| `tools/verify-bundle.mjs` | bundled backend | passed (relocated read-only bundle, no external Node, Node v24.21.0, script persistence) |
| Install | installed app | replaced the installed 1.4.0 (16) in /Applications; the app starts and its server answers |

Not covered: the import dialog was not clicked in the installed app by automation
(no UI scripting permission); the user's retest is pending. Server and web app
are identical to 1.4.0, whose checks below still apply.

1.4.1 ZIP SHA-256: `1797d683ae78b97b60eac6ee658cd9b09154fc6149df7f242ef50a3e48e5a583`.

---

## 1.4.0 (16)

As of 2026-10-19. 1.4.0 adds build-aware Keynote import and more robust page
turns (server, web app and tests); the native shell and speech helper sources are
unchanged from 1.3.1.

| Check | Source of evidence | Result |
| --- | --- | --- |
| `npm test`, `npm run test:qa` | unit / stress tests | 144 regression tests (12 new: synthetic `.key` reading, marker placement, controller use of build counts) and 73/73 stress tests passed |
| `npm run test:http` | real localhost HTTP/SSE | passed |
| Marker placement vs hand-placed markers | offline, a 16-slide lecture deck with 61 hand-placed markers (one paragraph per build) | 49 within 2 words, 51 within 12; several misses are picture or formula builds with no text |
| Speech-driven builds, auto-placed markers | real recognizer (`test/builds-e2e.mjs`: macOS `say` audio, on-device helper, simulated Keynote with the deck's build counts), 5 slides with 24 builds | every click within 1.0 s of its words; every page turn within 1.0 s of the slide's end; all builds shown |
| Same, last two words of each slide left out, 2.5 s pause | same harness, `--drop-tail 2 --end-pause 2.5` | every page turn 2.2–3.5 s after the speaker stopped; all builds shown |
| Same slides, notes without markers (previous behaviour) | same harness | no build during speech; builds flashed after each slide's text; page turns 11–21 s late |
| Import from Keynote | live Keynote 14.5, scratch copy of a deck | 55 markers placed on 13 slides; `/api/slides/builds` matched the file; an unsaved edit was reported as unsaved |
| ZIP extracted code-signature check | bundle | `codesign --verify --deep --strict` passed; Info.plist reports 1.4.0 (16) |
| `tools/verify-bundle.mjs` | bundled backend | passed: relocated read-only bundle, no external Node, Node v24.21.0, script persistence, recognizer locale enumeration; the bundled `.key` reader returned the expected build counts |

Not covered: a live show driven by a real microphone with these changes; decks
saved by Keynote versions other than 14.5 and 15.1; nested (indented) slides; the
extracted app's native GUI (the shell is unchanged). The verification Mac
reported only en-US as an installed on-device speech model (zh-CN was installed
for 1.3.0 checks). Other pending items are as in 1.3.1.

Runtime provenance: the bundled Node binary is the one in the published 1.3.0
archive (digest `77649df51bde49ea03d8597e5baa407226de9439619458e90df5ded2fbe4ddec`).

1.4.0 ZIP SHA-256: `441ef3aeff8b0a842abb6dc349e977266b38b4416573456c0dc6743307cb721e`.

---

## 1.3.1 (15)

As of 2026-10-18. 1.3.1 changes only the on-device speech helper's microphone
handling and the web app's no-sound retry and messages; the native shell, server
and bundled Node 24.21.0 runtime are unchanged from 1.3.0.

| Check | Source of evidence | Result |
| --- | --- | --- |
| `npm run test:all`, Node 24.21.0 | unit / stress tests | 132 regression tests passed. Tracker stress: one failure in the first run on a heavily loaded machine (load average about 8; the failing test was not captured), then 73/73 in three consecutive reruns |
| `npm run test:http` | real localhost HTTP/SSE | passed |
| ZIP extracted code-signature check | bundle | `codesign --verify --deep --strict` passed; Info.plist reports 1.3.1 (15) |
| `tools/verify-bundle.mjs` | bundled backend | passed: relocated read-only bundle, no external Node, Node v24.21.0, script persistence, recognizer locale enumeration |
| Bundled recognizer, file input | bundled helper | transcribed a synthesized English sentence correctly; the new microphone-recovery code is present in the binary |
| Bluetooth headset microphone | live microphone, developer build of the same helper source | with a Bluetooth headset as default input, the previous helper stalled (no sound). An intermediate version that rebuilt the audio engine on every device change looped (7 restarts in 8 s, silent). The released version produced speech-level audio and a first recognition result about 1.2 s after listening started |

Not covered: the extracted 1.3.1 app's native GUI was not opened (the shell is
unchanged since 1.3.0, and a developer copy with the same bundle identifier was in
use); the live microphone check used one headset model on one Mac; other Bluetooth
devices, USB microphones, noisy rooms, dual-display Keynote, physical clickers,
PowerPoint and Jev quality remain pending as in 1.3.0.

Runtime provenance: the bundled Node binary was taken from the published 1.3.0
archive, whose local copy matches the public asset digest
`77649df51bde49ea03d8597e5baa407226de9439619458e90df5ded2fbe4ddec`
(the official Node 24.21.0 build, re-signed ad hoc by the build script).

1.3.1 ZIP SHA-256: `a8ad24e9844bbf36d7b0d1c4935e1218a69c7b0d4750f44778dfd7dfcfa62ba1`.

---

## 1.3.0 (14)

As of 2026-10-08. The results below are distinct from full live-presentation acceptance.

| Check | Result |
| --- | --- |
| `npm run test:all`, Node 24.21.0 | 132 regression tests + 73 tracker stress tests passed, 0 TODO |
| `npm run test:http` | Real localhost HTTP/SSE, persistence, origin protection and control leases passed |
| Native shell + SpeechAnalyzer build | Compiled for arm64 / macOS 26, bundled with official Node 24.21.0 |
| ZIP extracted code-signature check | Ad-hoc signatures verified with `codesign --verify --deep --strict` |
| `tools/verify-bundle.mjs` | Relocated read-only bundle, no external Node path, server/UI assets, saving a temporary script and recognizer enumeration passed |
| Native GUI | Opened the extracted app; title showed v1.3.0 (14); editor and new Configure Jev / Open data folder menu entries appeared |
| Editor toolbar | Long English controls now wrap instead of clipping Start at the default window width |

The bundled recognizer returned supported locales, with en-US and zh-CN installed
on the verification Mac. These models are **not** included in the archive; a new
user may need to download them from Apple.

No paid Jev content requests, microphone capture, or real slideshow control were
started during packaging verification. The Jev key dialog was compiled and its
menu checked; a new key was not saved during testing. Keychain writes require
user interaction. Existing local drafts and the installed 1.2.1 app were preserved.

Still pending: noisy-room microphone use, real dual-display fullscreen Keynote,
physical clicker events, PowerPoint, online Jev accuracy/latency, and independent
testing on a second Mac. The 1.2 GUI report observed an unexplained native app exit;
this release's successful startup does not establish long-session stability.

Build and backend verification are repeatable using:

```bash
npm run test:all
npm run test:http
npm run build:app
ditto -x -k output/SmartTeleprompter-1.3.1-macOS-arm64.zip /tmp/tp-verify
node tools/verify-bundle.mjs /tmp/tp-verify/智能提词器.app
```

The app is not Apple-notarized. macOS Gatekeeper behavior on a downloaded copy is
not covered by local ad-hoc signature checks. See README for first-launch guidance.

## Public release and CI

**1.4.2 (18)**, released 2026-10-19 as the preview
[v1.4.2](https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.4.2)
(source commit `cb8b682aef584710de4abb807d196f12159e692b`). The GitHub asset
digests match the locally tested files: ZIP
`3dd0fc102dab80ad3df69624c842a5881a5c7b143d6dab963743df59054af83a`,
SHA256SUMS.txt `8477cdd87dfdd6c83b5f659ed9176a6285f4e7ee04060d235b2ac9b15e63db31`.
1.3.1, 1.4.0 and 1.4.1 were not released separately; their changes are in 1.4.2.

CI for `cb8b682`: Linux functional tests passed. The Apple Silicon performance
job failed in [run 39349917737](https://github.com/MarcusYF/smart-teleprompter/actions/runs/39349917737).
Two strict timing tests ("40-60 word utterances with rewrites", English and
Chinese) exceeded their budgets. The same two tests failed on the 1.3.0
documentation commit `f6c7944` (run 37803790107), and the tracker has not
changed since. The failure is pre-existing on the shared runner and not caused
by this release, but remote timing is not reported as passed. The local Apple
Silicon stress suite passes 73/73.

### 1.3.0 (14)

The tested archive is published at [v1.3.0](https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.3.0).
ZIP SHA-256: `77649df51bde49ea03d8597e5baa407226de9439619458e90df5ded2fbe4ddec`.
The GitHub asset digest matches the local tested archive.

Linux functional CI passed for source commit `eef4776a32b6c5f3f6f6eac02e3d985cf72365f1`.
The separate Apple Silicon performance job was queued at publication; it is not
reported as passed. See [the workflow run](https://github.com/MarcusYF/smart-teleprompter/actions/runs/37803334523).
Two earlier Linux runs exceeded strict tracker timing budgets, including after
serial execution. Functional checks passed. Timing tests now run on the target
Apple Silicon platform with their original thresholds; the local Mac stress
suite passed. This runner change is not evidence of a remote performance pass.
