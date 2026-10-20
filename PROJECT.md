# Smart Teleprompter

## Purpose and scope
English/Chinese voice-following teleprompter with optional Jev judgments and Keynote/PowerPoint integration. Deliver a standalone Mac app and public source repository.

## Current state
2026-10-19: version 1.4.2 (18) published as a public preview for Apple Silicon / macOS 26+ (1.3.0 was the previous release, 2026-10-08).
Repository: https://github.com/MarcusYF/smart-teleprompter
Release: https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.4.2
The app bundles its UI, local server, Node and recognizer. Data lives in the user's Application Support directory. README is fully English as requested.
2026-10-19: version 1.4.2 (18) adds Bluetooth microphone recovery (1.3.1), build-aware Keynote import with automatic `[click]` placement and robust page turns (1.4.0), a fix for the app quitting when a dialog closed (1.4.1), and click-to-set-position with slideshow catch-up (1.4.2). Its release and CI evidence are recorded in docs/VALIDATION.md.

## Canonical sources and outputs
- README.md: features, installation, usage and build instructions.
- package.json: version and build number.
- docs/VALIDATION.md: current validation evidence and pending live acceptance.
- HANDOFF.md and project-memory/records/: handoff and dated work records.
- output/: local release artifacts, excluded from the source repository.

## Next steps
Live microphone, dual-display fullscreen presentations, physical clickers, PowerPoint and online Jev acceptance remain pending. Inspect the separate Mac performance CI job before claiming full CI success. This preview has ad-hoc signatures and no Apple notarization.
