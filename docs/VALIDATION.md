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

## Public release and CI

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
