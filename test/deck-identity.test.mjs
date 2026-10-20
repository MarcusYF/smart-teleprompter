// Decks are identified by their file, so a script keeps its deck when
// Keynote restarts (Keynote's document id lasts one session only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_KEY_JS } from '../server/slides.mjs';
import { sameDeck, sameDocument, deckName } from '../public/lib/deck.js';

const deckKey = new Function(`${DECK_KEY_JS}; return deckKey;`)();
const doc = (path, id) => ({ file: () => (path ? { toString: () => path } : null), id: () => id });

test('the JXA deck key is the file, or the session id until saved', () => {
  assert.equal(deckKey(doc('/Decks/Week 3.key', 'A1')), 'file:/Decks/Week 3.key');
  assert.equal(deckKey(doc(null, 'B2')), 'session:B2');
  assert.equal(deckKey({ file: () => { throw new Error('no file'); }, id: () => 'C3' }), 'session:C3');
  // reopening (or a Keynote restart) gives a new session id, not a new key
  assert.equal(deckKey(doc('/Decks/a.key', 'first')), deckKey(doc('/Decks/a.key', 'second')));
});

const playing = (path, session, name = 'Lecture.key') => ({ source: 'keynote', doc: name, docId: path ? `file:${path}` : `session:${session}`, sessionId: session });

test('a script keeps its deck across Keynote restarts', () => {
  const before = playing('/D/Lecture.key', 'S1');
  const after = playing('/D/Lecture.key', 'S2');
  assert.equal(sameDeck(before.docId, 'Lecture', after), true);
  // another file with the same name is another deck
  assert.equal(sameDeck(before.docId, 'Lecture', playing('/Other/Lecture.key', 'S3')), false);
});

test('a deck imported before its first save keeps its script once saved', () => {
  const unsaved = playing(null, 'S1', 'Untitled.key');
  const saved = playing('/D/Talk.key', 'S1', 'Talk.key');
  assert.equal(sameDeck(unsaved.docId, 'Untitled', saved), true);
  assert.equal(sameDocument(unsaved, saved), true, 'saving is not a change of deck');
  assert.equal(sameDocument(saved, playing('/D/Talk.key', 'S9', 'Talk.key')), true);
  assert.equal(sameDocument(saved, playing('/E/Talk.key', 'S4', 'Talk.key')), false, 'same name, other document');
  // after a restart an unsaved deck is gone: its session key matches nothing
  assert.equal(sameDeck(unsaved.docId, 'Untitled', playing(null, 'S7', 'Untitled.key')), false);
});

test('scripts saved by earlier versions (a bare session id) still find their deck', () => {
  const legacy = '0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9';
  // same Keynote session
  assert.equal(sameDeck(legacy, 'Lecture', playing('/D/Lecture.key', legacy)), true);
  // after a restart: by name
  assert.equal(sameDeck(legacy, 'Lecture', playing('/D/Lecture.key', 'NEW')), true);
  assert.equal(sameDeck(legacy, 'Lecture', playing('/D/Other.key', 'NEW', 'Other.key')), false);
  assert.equal(sameDeck(legacy, null, playing('/D/Lecture.key', 'NEW')), false);
  assert.equal(deckName('Lecture.key'), 'Lecture');
});

test('no identity, no match', () => {
  assert.equal(sameDeck(null, 'Lecture', playing('/D/Lecture.key', 'S1')), false);
  assert.equal(sameDeck('file:/D/Lecture.key', 'Lecture', { source: 'keynote', doc: 'Lecture.key' }), false);
});
