# Handoff — Smart Teleprompter

As of 2026-10-08. Version 1.3.0 (14), standalone Apple Silicon / macOS 26+ preview.

## Read first
README.md, package.json, docs/VALIDATION.md, CHANGELOG.md, PRIVACY.md, PROJECT_MAINTENANCE.md.

## Current work
User authorized a general app and public GitHub publication. Repository https://github.com/MarcusYF/smart-teleprompter is created; tested ZIP exists locally; code and release publication are the remaining steps at this checkpoint. Initial legacy version was 1.2.1 (13).

## Implementation
Application runtime lives in Contents/Resources/app, Node in Contents/MacOS/node, and the recognizer in the runtime native/build directory. Source is copied from an explicit runtime allowlist; no data/ is packaged. The shell uses user Application Support/SmartTeleprompter for data and a fresh server-instance ID for health checks. Port remains 5217. Jev is optional; its app-specific Keychain service is local.claude-jev.teleprompter.jev, with legacy fallback. Saving a key requires reopening the app.

## Validation and limits
132 regression + 73 stress tests and real HTTP/SSE passed on Node 24.21.0. The actual extracted app works after relocation with a read-only bundle and no external Node; temporary script persistence and recognizer locale enumeration passed. Native window title and menus verified. Final toolbar correction was packaged. See docs/VALIDATION.md for limits: no live mic/slideshow acceptance or second-Mac test; no credential write during testing; ad-hoc signing only, no Apple notarization.

## Next steps
Publish reviewed source to main through the GitHub connector; attach final ZIP and SHA256SUMS.txt to public preview tag v1.3.0; verify remote content and downloadable assets. Keep private scripts, logs, caches, credentials, build archives and local snapshots out of the source tree. Do not report successful startup as full live-presentation acceptance.

## Build/test commands
npm run test:all; npm run test:http; npm run build:app. node tools/verify-bundle.mjs /path/to/智能提词器.app. Source requires Node 24; native build requires macOS 26 SDK. Bundled Node version/checksum is pinned in tools/fetch-node.sh.

Latest preparation record: project-memory/records/2026-10-08T150000Z-portable-release-preparation.md. Checkpoint snapshots are local and ignored by Git.
