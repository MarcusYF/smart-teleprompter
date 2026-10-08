# Handoff — Smart Teleprompter

As of 2026-10-08. Version 1.3.0 (14), standalone Apple Silicon / macOS 26+ public preview.

## Read first
README.md (English), package.json, docs/VALIDATION.md, CHANGELOG.md, PRIVACY.md, PROJECT_MAINTENANCE.md.

## Current state
User-authorized public publication completed: https://github.com/MarcusYF/smart-teleprompter
Download: https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.3.0
Release tag points to eef4776a32b6c5f3f6f6eac02e3d985cf72365f1; subsequent documentation checkpoints may be on main. Both ZIP and checksum assets are public; ZIP digest matches the locally tested archive. Existing installed 1.2.1 (13) was preserved.

## Implementation
Runtime is in Contents/Resources/app, Node in Contents/MacOS/node, and the recognizer in the runtime native/build directory. An explicit runtime allowlist excludes data/. User data is under Application Support/SmartTeleprompter. Startup uses a unique backend instance ID; port remains 5217. Optional Jev key dialog uses service local.claude-jev.teleprompter.jev with legacy fallback; saving a key requires reopening.

## Verification and open work
132 regression + 73 stress tests, real HTTP/SSE, extracted signature and relocated read-only bundle checks passed locally. Native title/menus and toolbar wrap verified. Linux functional CI passed for eef4776. Mac performance CI was still queued: https://github.com/MarcusYF/smart-teleprompter/actions/runs/37803334523 . Two earlier Linux timing runs failed; thresholds unchanged and performance now targets Apple Silicon. Do not claim full remote CI success until checking its actual outcome.
Real noisy-room mic, dual-display fullscreen Keynote, physical clickers, PowerPoint, Jev quality/latency, second-Mac and long-session stability remain pending. No new credential was saved in tests. Preview has ad-hoc signatures, no Apple notarization.

## Working environment
Local branch codex/portable-app preserves legacy master history. Public GitHub history was created separately to avoid publishing legacy private artifacts. Keep scripts, logs, caches, credentials, build archives and machine-specific snapshots excluded. Node 24+; native build needs macOS 26 SDK. Commands: npm run test:all; npm run test:http; npm run build:app; node tools/verify-bundle.mjs /path/to/智能提词器.app.

Latest record: project-memory/records/2026-10-08T154804Z-public-preview-english-readme.md. Immutable snapshots are local and Git-ignored.
