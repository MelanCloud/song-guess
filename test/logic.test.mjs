import test from 'node:test';
import assert from 'node:assert/strict';

import { LADDER, MAX_STAGE, anchorFor, pointsFor, shuffle, createGame, startRound, submitGuess, giveUp, extend, canExtend } from '../js/game.js';
import { normalize, stripVariant, answerKey } from '../js/text.js';
import { buildIndex, search } from '../js/autocomplete.js';

// Node's crypto.getRandomValues lives on globalThis.crypto in modern Node.
const track = (id, name, artists, durationMs = 200_000) => ({
  id, name, artists, durationMs, uri: `spotify:track:${id}`, album: 'A', art: '', artSmall: '',
});

/* ------------------------------------------------------------------ ladder */

test('ladder is 0.1s, 0.5s, 1s then +1s to 10s', () => {
  assert.deepEqual(LADDER, [100, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  assert.equal(MAX_STAGE, 11);
});

test('points decrease as the ladder is climbed, never below 1', () => {
  assert.equal(pointsFor(0), 12);
  assert.equal(pointsFor(MAX_STAGE), 1);
  for (let i = 1; i <= MAX_STAGE; i++) assert.ok(pointsFor(i) < pointsFor(i - 1));
});

/* ------------------------------------------------------------------ anchor */

test('anchor mode "start" always begins at zero', () => {
  assert.equal(anchorFor(track('a', 'X', ['Y']), 'start'), 0);
});

test('random anchor is deterministic per track and leaves room for the full 10s', () => {
  const t = track('4cOdK2wGLETKBW3PvgPWqT', 'Never Gonna Give You Up', ['Rick Astley'], 213_000);
  const a1 = anchorFor(t, 'random');
  const a2 = anchorFor(t, 'random');
  assert.equal(a1, a2, 'same track must always get the same anchor');
  assert.ok(a1 > 0);
  assert.ok(a1 + 10_000 <= t.durationMs, 'must leave room for the longest snippet');
});

test('tracks shorter than the longest snippet fall back to the start', () => {
  assert.equal(anchorFor(track('s', 'Short', ['Y'], 8000), 'random'), 0);
});

/* ----------------------------------------------------------------- shuffle */

test('shuffle keeps every track exactly once', () => {
  const items = Array.from({ length: 50 }, (_, i) => track(`id${i}`, `T${i}`, ['A']));
  const out = shuffle(items);
  assert.equal(out.length, items.length);
  assert.deepEqual(new Set(out.map((t) => t.id)), new Set(items.map((t) => t.id)));
});

/* ------------------------------------------------------------------- text */

test('normalize folds accents, case and punctuation', () => {
  assert.equal(normalize('Björk'), 'bjork');
  assert.equal(normalize('Café  del   MAR'), 'cafe del mar');
  assert.equal(normalize("Don't Stop Me Now"), 'dont stop me now');
  assert.equal(normalize('Salt & Pepa'), 'salt and pepa');
});

test('stripVariant removes remaster and feature noise', () => {
  assert.equal(stripVariant('Bohemian Rhapsody - 2011 Remaster'), 'Bohemian Rhapsody');
  assert.equal(stripVariant('Song (Radio Edit)'), 'Song');
  assert.equal(stripVariant('Song (feat. Someone)'), 'Song');
  assert.equal(stripVariant('Perfect Song'), 'Perfect Song');
});

test('a remastered re-release counts as the same answer', () => {
  const a = track('1', 'Bohemian Rhapsody - 2011 Remaster', ['Queen']);
  const b = track('2', 'Bohemian Rhapsody', ['Queen']);
  assert.equal(answerKey(a), answerKey(b));
});

test('same title by a different artist is a different answer', () => {
  assert.notEqual(
    answerKey(track('1', 'Hurt', ['Nine Inch Nails'])),
    answerKey(track('2', 'Hurt', ['Johnny Cash'])),
  );
});

/* ----------------------------------------------------------- autocomplete */

const PLAYLIST = [
  track('t1', 'Bohemian Rhapsody - 2011 Remaster', ['Queen'], 355_000),
  track('t2', 'Under Pressure', ['Queen', 'David Bowie'], 248_000),
  track('t3', 'Radio Ga Ga', ['Queen'], 348_000),
  track('t4', 'Heroes', ['David Bowie'], 371_000),
  track('t5', 'Space Oddity', ['David Bowie'], 315_000),
  track('t6', 'Boys Keep Swinging', ['David Bowie'], 203_000),
  track('t7', 'Take On Me', ['a-ha'], 225_000),
  track('t8', 'Bohemian Rhapsody', ['Queen'], 355_000), // duplicate entry
];

const idx = buildIndex(PLAYLIST);

test('index de-duplicates the same song listed twice', () => {
  assert.equal(idx.length, PLAYLIST.length - 1);
});

test('empty query returns nothing', () => {
  assert.deepEqual(search(idx, ''), []);
  assert.deepEqual(search(idx, '   '), []);
});

test('typing an artist lists that artist\'s songs in the playlist', () => {
  const names = search(idx, 'bowie', 10).map((e) => e.title);
  assert.deepEqual(new Set(names), new Set(['Under Pressure', 'Heroes', 'Space Oddity', 'Boys Keep Swinging']));
});

test('a partial artist name works as a prefix', () => {
  const names = search(idx, 'quee', 10).map((e) => e.title);
  assert.deepEqual(new Set(names), new Set(['Bohemian Rhapsody', 'Under Pressure', 'Radio Ga Ga']));
});

test('title prefix outranks other matches', () => {
  assert.equal(search(idx, 'space', 5)[0].title, 'Space Oddity');
  assert.equal(search(idx, 'bohem', 5)[0].title, 'Bohemian Rhapsody');
});

test('every typed token must match, so nonsense returns nothing', () => {
  assert.deepEqual(search(idx, 'bowie zzzz', 10), []);
  assert.deepEqual(search(idx, 'qqqq', 10), []);
});

test('artist plus title tokens can be mixed in one query', () => {
  const hits = search(idx, 'queen radio', 10).map((e) => e.title);
  assert.deepEqual(hits, ['Radio Ga Ga']);
});

test('accented and punctuated input still matches', () => {
  assert.equal(search(idx, 'a-ha', 5)[0].title, 'Take On Me');
});

test('search respects the result limit', () => {
  assert.ok(search(idx, 'e', 3).length <= 3);
});

/* -------------------------------------------------------------- game flow */

function newGame(opts = {}) {
  return createGame(PLAYLIST, {
    rounds: 3, anchorMode: 'random', wrongGuessAdvances: true, ...opts,
  });
}

test('a correct guess at stage 0 scores full points and ends the round', () => {
  const g = newGame();
  const round = startRound(g);
  const res = submitGuess(g, round.track);
  assert.equal(res.correct, true);
  assert.equal(res.points, 12);
  assert.equal(g.score, 12);
  assert.equal(round.over, true);
  assert.equal(round.won, true);
});

test('a wrong guess advances the ladder when that option is on', () => {
  const g = newGame({ wrongGuessAdvances: true });
  const round = startRound(g);
  const wrong = PLAYLIST.find((t) => answerKey(t) !== answerKey(round.track));
  submitGuess(g, wrong);
  assert.equal(round.stage, 1);
  assert.equal(round.over, false);
  assert.equal(round.guesses.length, 1);
});

test('a wrong guess does not advance the ladder when that option is off', () => {
  const g = newGame({ wrongGuessAdvances: false });
  const round = startRound(g);
  const wrong = PLAYLIST.find((t) => answerKey(t) !== answerKey(round.track));
  submitGuess(g, wrong);
  assert.equal(round.stage, 0);
});

test('the ladder stops at 10s and reports exhaustion', () => {
  const g = newGame({ wrongGuessAdvances: true });
  const round = startRound(g);
  const wrong = PLAYLIST.find((t) => answerKey(t) !== answerKey(round.track));
  let last;
  for (let i = 0; i < 20; i++) last = submitGuess(g, wrong);
  assert.equal(round.stage, MAX_STAGE);
  assert.equal(canExtend(round), false);
  assert.equal(extend(round), false);
  assert.equal(last.exhausted, true);
  assert.equal(round.over, false, 'player may keep guessing at 10s until they give up');
});

test('a late correct guess still scores, but less', () => {
  const g = newGame();
  const round = startRound(g);
  const wrong = PLAYLIST.find((t) => answerKey(t) !== answerKey(round.track));
  submitGuess(g, wrong);
  submitGuess(g, wrong);
  const res = submitGuess(g, round.track);
  assert.equal(res.correct, true);
  assert.equal(res.points, pointsFor(2));
  assert.ok(res.points < 12);
});

test('giving up records a loss worth nothing', () => {
  const g = newGame();
  const round = startRound(g);
  giveUp(g);
  assert.equal(round.over, true);
  assert.equal(round.won, false);
  assert.equal(g.score, 0);
  assert.equal(g.results.at(-1).points, 0);
});

test('guesses after the round is over are ignored', () => {
  const g = newGame();
  const round = startRound(g);
  submitGuess(g, round.track);
  const after = submitGuess(g, round.track);
  assert.equal(after.alreadyOver, true);
  assert.equal(g.score, 12, 'score must not be awarded twice');
});

test('a duplicate playlist entry of the answer counts as correct', () => {
  const g = createGame([PLAYLIST[0]], { rounds: 1, anchorMode: 'start', wrongGuessAdvances: true });
  startRound(g);
  // t8 is the same song as t1 without the remaster suffix
  assert.equal(submitGuess(g, PLAYLIST[7]).correct, true);
});
