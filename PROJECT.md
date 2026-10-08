# Smart Teleprompter

## Purpose and scope
English/Chinese voice-following teleprompter with optional Jev judgments and Keynote/PowerPoint integration. Deliver a standalone Mac app and public source repository.

## Current state
2026-10-08: version 1.3.0 (14) published as a public preview for Apple Silicon / macOS 26+.
Repository: https://github.com/MarcusYF/smart-teleprompter
Release: https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.3.0
The app bundles its UI, local server, Node and recognizer. Data lives in the user's Application Support directory. README is fully English as requested.

## Canonical sources and outputs
- README.md: features, installation, usage and build instructions.
- package.json: version and build number.
- docs/VALIDATION.md: current validation evidence and pending live acceptance.
- HANDOFF.md and project-memory/records/: handoff and dated work records.
- output/: local release artifacts, excluded from the source repository.

## Next steps
Live microphone, dual-display fullscreen presentations, physical clickers, PowerPoint and online Jev acceptance remain pending. Inspect the separate Mac performance CI job before claiming full CI success. This preview has ad-hoc signatures and no Apple notarization.
