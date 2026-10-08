# Privacy / 隐私说明

Smart Teleprompter runs a local HTTP service bound to loopback only. It has no
account system, analytics SDK, telemetry collector, or automatic upload of saved
scripts. The downloadable app contains only program assets and public examples.

- **Apple on-device recognition:** microphone audio is processed by Apple's local
  SpeechAnalyzer. Apple's language models may need an initial network download.
- **Browser Web Speech:** processing is controlled by the browser provider and
  may send audio to its service; it should not be assumed to be offline.
- **Optional Jev:** relevant script excerpts and recognized text are sent to
  TypeSafe to infer speaking behavior, skipped content, cues, or slide mappings.
  Turning off Jev aborts pending requests and uses local matching and heuristics.
  A configured key does not prove network connectivity or semantic accuracy.
- **Credentials:** the Mac app stores a user-supplied key in macOS Keychain under
  `local.claude-jev.teleprompter.jev`. The backend also accepts `TYPESAFE_API_KEY`
  from its environment or the legacy Keychain item. Keys stay out of browser
  responses, scripts, repository contents, and release archives. Removing the
  app-specific key does not remove the legacy item or an environment variable.
- **Storage:** the Mac app uses
  `~/Library/Application Support/SmartTeleprompter/` for scripts, outline caches,
  and logs. The browser retains its settings and draft locally. The source server
  defaults to `data/`, overridable with `TELEPROMPTER_DATA`.
- **Slide access:** macOS Automation permission allows reading presenter notes and
  controlling the selected slideshow. Accessibility permission enables observation
  of manual clicker/keyboard navigation. These permissions are not needed for
  plain script-only prompting.

Back up scripts before deleting data. Script deletion moves files to the local
`scripts/.trash/` directory. Outline caches contain script-derived material, so
treat the data folder and any diagnostic logs you share as private.
