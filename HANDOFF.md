# Handoff — Smart Teleprompter

As of 2026-10-19. Version 1.4.3 (19), standalone Apple Silicon / macOS 26+ preview, published as https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.4.3 (pre-release).

## Read first
README.md (English), package.json, docs/VALIDATION.md, CHANGELOG.md, PRIVACY.md, PROJECT_MAINTENANCE.md.

## Current state
Public repository: https://github.com/MarcusYF/smart-teleprompter (main = release commit b83acce, tag v1.4.3; tree equals development commit 6e9b961 on branch codex/portable-app). To publish: `git commit-tree HEAD^{tree} -p origin/main`, push it as main, tag it, run `gh release create --prerelease` with the ZIP and SHA256SUMS.txt, and check the asset digests.
Download: https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.4.3 . The asset digests match the locally tested files. Earlier releases: v1.4.2 and v1.3.0.

## Implementation
Runtime is in Contents/Resources/app, Node in Contents/MacOS/node, and the recognizer in the runtime native/build directory. An explicit runtime allowlist excludes data/. User data is under Application Support/SmartTeleprompter. Startup uses a unique backend instance ID; port remains 5217. Optional Jev key dialog uses service local.claude-jev.teleprompter.jev with legacy fallback; saving a key requires reopening.

## Verification and open work
156 regression + 73 stress tests, real HTTP/SSE, and the extracted signature and relocated read-only bundle checks passed locally for 1.4.3. CI on b83acce (as on cb8b682): functional passed; the Apple Silicon performance job failed two strict timing tests (long rewritten utterances), as it did at 1.3.0. Do not claim remote timing success.
Pending: live acceptance of click-to-set-position catch-up in a real Keynote show (user testing); a live Keynote restart in the middle of a linked session; real noisy-room mic, dual-display fullscreen, physical clickers, PowerPoint, Jev quality and latency, second Mac. The preview has ad-hoc signatures and no Apple notarization.

## Working environment
Local branch codex/portable-app preserves legacy master history. Public GitHub history was created separately to avoid publishing legacy private artifacts. Keep scripts, logs, caches, credentials, build archives and machine-specific snapshots excluded. Node 24+; native build needs macOS 26 SDK. Commands: npm run test:all; npm run test:http; npm run build:app; node tools/verify-bundle.mjs /path/to/智能提词器.app.

2026-10-18/19: 1.3.1 recovers the on-device recognizer from Bluetooth-headset microphone stalls. 1.4.0 adds build-aware Keynote import (server/keynote-file.mjs reads builds from the saved .key file; public/lib/autoclick.js places one [click] per build where the notes have none), deck build counts during a show (GET /api/slides/builds), and a page turn on a pause near a slide's end. 1.4.1 stops the Mac app quitting when a dialog closes (the prompter window is an NSPanel). 1.4.2 makes a click on the script set the position (Follower.overrideTo) and catches the show up (BuildController.seek). 1.4.3 identifies decks by file (DECK_KEY_JS in server/slides.mjs; public/lib/deck.js), because Keynote's document id changes on every open. The installed app on the development Mac is 1.4.3 (19).

Latest record: project-memory/records/2026-10-19T233000Z-deck-identity-release-1-4-3.md. Immutable snapshots are local and Git-ignored.
