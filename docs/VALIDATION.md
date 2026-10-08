# Validation — 1.3.0 (14)

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
ditto -x -k output/SmartTeleprompter-1.3.0-macOS-arm64.zip /tmp/tp-verify
node tools/verify-bundle.mjs /tmp/tp-verify/智能提词器.app
```

The app is not Apple-notarized. macOS Gatekeeper behavior on a downloaded copy is
not covered by local ad-hoc signature checks. See README for first-launch guidance.
