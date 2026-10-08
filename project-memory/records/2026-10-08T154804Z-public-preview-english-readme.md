# Public preview and English README

Source: user-authorized general app publication and public visibility, followed by the request for an English README, 2026-10-08.

## Delivered
Public repository: https://github.com/MarcusYF/smart-teleprompter
Public preview: https://github.com/MarcusYF/smart-teleprompter/releases/tag/v1.3.0
README rewritten in English, retaining installation, features, syntax, slide control, privacy, build and validation instructions. Release assets are the standalone 1.3.0 (14) arm64 macOS 26+ ZIP and SHA256SUMS.txt. GitHub asset digest matches the tested archive: 77649df51bde49ea03d8597e5baa407226de9439619458e90df5ded2fbe4ddec.

## Evidence and limits
132 regression and 73 stress tests passed locally on Apple Silicon with Node 24.21.0. HTTP/SSE and relocated read-only bundle verification passed; native title and menus were checked. Linux functional CI passed at eef4776; Mac performance CI remained queued at publication. Earlier Linux timing failures are recorded in docs/VALIDATION.md. Strict timing thresholds were preserved. No real mic/slideshow, paid Jev or second-Mac acceptance claimed. Release is ad-hoc signed and not Apple-notarized. Existing 1.2.1 installation preserved.

## Next actions
Check the Mac CI outcome and perform user-authorized live presentation acceptance. No recurring follow-up was created.
