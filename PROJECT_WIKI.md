# Project wiki — 智能提词器 / Smart Teleprompter

Append-only project knowledge. Add dated evidence, decisions, definitions, and corrections. Later corrections cite the entry they supersede; retain the original.


<!-- project-memory:2026-10-08T150000Z-portable-release-preparation -->
## 2026-10-08T150000Z-portable-release-preparation
Source: User-authorized app release, 2026-10-08

2026-10-08: Standalone app stores runtime inside bundle and data in per-user Application Support; shipping the developer checkout or data folder is prohibited. Backend instance checks prevent reusing an old process. Public preview targets Apple Silicon/macOS 26+, with ad-hoc signing; live presentation acceptance is distinct from automated success. Evidence: docs/VALIDATION.md and the preparation record.


<!-- project-memory:2026-10-08T154804Z-public-preview-english-readme -->
## 2026-10-08T154804Z-public-preview-english-readme
Source: Current user conversation, 2026-10-08: public GitHub app publication and English README

2026-10-08: Published v1.3.0 as a standalone Apple Silicon / macOS 26+ public preview; README is English. Public release asset digest equals the tested local ZIP. Strict tracker timing budgets now run on the target Apple Silicon runner after two Linux timing failures; functional CI is separate. Remote timing success must be verified independently. Evidence: docs/VALIDATION.md and release v1.3.0.

<!-- project-memory:2026-10-19T025500Z-bluetooth-mic-recovery -->
## 2026-10-19T025500Z-bluetooth-mic-recovery
Source: user report in the Mac app, 2026-10-18 local

2026-10-18: A Bluetooth headset as default input can stall the native recognizer: AVAudioEngine stops on each profile switch, and rebuilding a fresh engine on every change loops forever. The helper now waits for the device to settle, reattaches the same engine, and builds a new one only when buffers stop; the app retries a silent start once. On this Mac `timeout` is not installed; use `curl --max-time` to sample the SSE stream. Evidence: the dated record.


<!-- project-memory:2026-10-19T041300Z-build-aware-keynote-import -->
## 2026-10-19T041300Z-build-aware-keynote-import
Source: User report and requests, 2026-10-18/19 local: animations and page turns did not always follow speech; commit and package the fix

2026-10-19: Keynote's AppleScript has no build information, but the saved `.key` file does. KN.SlideArchive field 43 lists the build chunks in click order; KN.BuildChunkArchive field 5 marks automatic chunks; a By-Paragraph build's k-th chunk reveals paragraph k of the drawable's TSWP storage text. Imported notes without `[click]` markers previously made every build wait for the slide's end; slides with more than six unmarked builds never turned. Import now places markers from build text. During a show, the controller uses the saved deck's per-slide build counts, ignoring them while the deck has unsaved changes. A pause within the last few words also turns the page. The Write tool turns `\uXXXX` escapes into literal characters; check new source files for invisible U+FFFC/U+2029. Evidence: the dated record.


<!-- project-memory:2026-10-19T221000Z-public-release-1-4-2 -->
## 2026-10-19T221000Z-public-release-1-4-2
Source: User request, 2026-10-19: push the latest version to GitHub, update the version and describe the features in the README

2026-10-19: Released 1.4.2 (18) as the GitHub preview v1.4.2. Public main gets a commit whose tree equals the development branch HEAD, on top of the public history. The legacy history stays local. The Apple Silicon CI timing tests for long rewritten utterances fail on the shared runner, as they did at 1.3.0; functional CI passes. Evidence: docs/VALIDATION.md, Public release and CI.
