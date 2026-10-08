# Portable release preparation — 2026-10-08

Source: user request to package a general app and publish to GitHub; public visibility explicitly approved.

Implemented 1.3.0 (14): bundled Node 24.21.0, frontend, server and Apple SpeechAnalyzer; per-user storage; secure app Keychain configuration menu; backend instance guard; editor toolbar wrapping. Targets Apple Silicon / macOS 26+. MIT source license and bundled runtime notices added.

Verified: 132 regression + 73 stress tests, HTTP/SSE, compiled shell/helper, extracted ZIP signatures, relocated/read-only backend with no external Node and temporary persistence, locale enumeration. Native title/editor and new menu entries verified. No microphone, paid Jev content request or real slideshow started.

Public repository created: https://github.com/MarcusYF/smart-teleprompter . Source and release publication remain pending at this checkpoint. Private scripts, keys, logs, output archives and machine snapshots excluded from public source. Existing installed app and local draft retained. Release planned as a public preview; long-session and real-presentation acceptance remain open.

Evidence: docs/VALIDATION.md, CHANGELOG.md, README.md, output/SmartTeleprompter-1.3.0-macOS-arm64.zip, output/SHA256SUMS.txt.
