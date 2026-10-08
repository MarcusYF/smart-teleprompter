# Changelog

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
