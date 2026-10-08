# Project maintenance extensions

## Canonical state and path mapping
See `.project-memory.json`. Existing domain files remain authoritative.

## Additional project logic
Keep the README, package version, validation report and handoff consistent at releases.
Record whether each result comes from unit tests, a bundled backend, native UI,
or live microphone/slideshow acceptance. Never promote simulated success to live acceptance.

Public source and release archives exclude data/, output/, credentials, local
diagnostic logs, raw private scripts, and machine-specific checkpoint snapshots.
Only generic project decisions and verification summaries belong in public records.
Use an explicit source-file list when publishing through the GitHub connector.

## Shared memory contract
Preserve dated records, snapshots, and wiki history by default. Refresh the current overview and handoff at substantive checkpoints. State proposals, decisions, evidence, and uncertainty separately. Explicit user instructions may override this convention.
