# File-based Keynote deck identity and public release 1.4.3

Source: user requests, 2026-10-19: identify decks by file path so a script survives Keynote restarts ("按文件路径识别 deck，修掉重启问题"), then publish it ("发上去").

## Change
- Keynote's AppleScript `document.id()` changes every time a document is opened: a scratch copy closed and reopened went from `9374D864…` to `E534C770…`, while its file stayed the same. Scripts were tied to that id, so after a Keynote restart the prompter treated the deck as another document.
- Decks are now keyed `file:<path>`, or `session:<id>` until first saved. `DECK_KEY_JS` in server/slides.mjs is used by the watcher (which also reports `sessionId`), the import, the build counts and the in-Keynote click guard. The guard also tolerates a null current slide at the start of a recording.
- public/lib/deck.js has `sameDeck` and `sameDocument`. Saving a new deck is not a change of deck. Scripts with a bare session id from earlier versions match in the same session, or by name after a restart, and are then tied to the file (`adoptDeck` in app.js).

## Evidence
- 156 regression tests (5 new for deck identity), 73 stress tests and the HTTP smoke test pass. The existing same-name deck-switch test still pauses control.
- A development server against the open deck reports `docId: file:<path>` plus the session id.
- 1.4.3 (19) ZIP SHA-256 6129d367bf06f25f487b21c1fb37480a1e4c11137f38b4caff3e37c34aab5221. Extracted signature and bundle checks passed. Installed in /Applications and started; the app was left closed, as the user had left it.
- Published: v1.4.3 pre-release (source commit b83acce on public main, tree equal to development commit 6e9b961); the downloaded assets match. Test fixtures that used local deck names and ids were neutralized before publication. CI: functional passed; Apple Silicon timing failed the same two pre-existing long-utterance budgets.

## Open
- Not exercised: a real Keynote restart in the middle of a linked session (the reopen test covers the same id change).
- The remote timing budgets still need investigation or recalibration.
