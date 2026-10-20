// Which Keynote deck a script belongs to.
//
// The server reports a deck as "file:<path>", or as "session:<id>" (Keynote's
// per-session document id) until it is first saved, together with that
// session id. Scripts from before 1.4.3 hold a bare session id, which stops
// matching once Keynote restarts.

export const deckName = (n) => String(n || '').replace(/\.key$/i, '').trim();
export const deckKey = (st) => st?.docId || st?.doc || null;

// A script tied to storedId (and named storedName) belongs to the deck the
// watcher state st shows.
export function sameDeck(storedId, storedName, st) {
  if (!storedId || !st?.docId) return false;
  if (storedId === st.docId) return true;
  // imported before the deck was saved, or an older script, in this Keynote session
  if (st.sessionId && (storedId === `session:${st.sessionId}` || storedId === st.sessionId)) return true;
  // an older script after a Keynote restart: by the deck's name
  if (!/^(file|session):/.test(storedId)) return !!storedName && deckName(st.doc) === storedName;
  return false;
}

// Two watcher states show the same document (a save changes its key, not its session).
export const sameDocument = (a, b) => deckKey(a) === deckKey(b) || (!!a?.sessionId && a.sessionId === b?.sessionId);
