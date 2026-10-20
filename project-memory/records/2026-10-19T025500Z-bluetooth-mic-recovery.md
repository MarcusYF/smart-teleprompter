# Bluetooth microphone recovery in the on-device recognizer

Source: user report in the Mac app, 2026-10-18: a no-sound warning (naming Google Chrome) while listening with the on-device engine.

## Diagnosis
- Default input was a Bluetooth headset. The helper was running and listening; the app's 12 s watchdog reported no sound. An earlier session the same evening worked only on a second start.
- With a first rewrite that rebuilt a fresh AVAudioEngine on every device change, live monitoring showed a loop: 7 restarts in 8 s (5 from AVAudioEngineConfigurationChange) and only all-zero levels. Closing the input lets the headset fall back to its music profile; reopening switches it again.
- The warning text named Google Chrome, which is wrong in the Mac app.
- Correction: an earlier check that "no audio buffers arrived" used `timeout`, which does not exist on this Mac, so that observation was void; later measurements used `curl --max-time`.

## Change
- native/tp-asr.swift: `Mic` class. A device change is acted on only after 1.2 s without further changes and reattaches the same engine (input stays open); a fresh engine is built only when buffers stop for 3 s (backoff up to 20 s) or reattaching fails; at most 4 restarts per 20 s; an error after about 10 s of failures.
- public/app.js: when the native engine hears nothing in 12 s, restart listening once quietly before warning.
- public/lib/i18n.js: native-engine wording for no sound / no words (input device, Bluetooth headset, 智能提词器 microphone permission).

## Evidence and limits
Live, with the same headset as default input: after the change, listening produced speech-level audio (rms 0.004-0.018) and a first recognition result about 1.2 s after start. 132 regression and 73 stress tests pass. Only one headset model and one evening were observed; not verified with other Bluetooth devices, USB microphones, or the standalone 1.3.0 bundle build.
