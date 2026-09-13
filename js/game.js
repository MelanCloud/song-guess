/** Game rules: the reveal ladder, round state and scoring. */

import { answerKey } from './text.js';

/** 0.1s, 0.5s, 1s, then +1s up to 10s. */
export const LADDER = [100, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];

export const MAX_STAGE = LADDER.length - 1;

/** Fisher–Yates, using crypto for an unbiased shuffle. */
export function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deterministic 32-bit hash so a track always gets the same anchor. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Where the snippet window starts.
 *
 * 'start' is Heardle-style, but the first 100ms of a track is very often
 * silence or a fade-in, which makes the 0.1s round meaningless — so the
 * default drops into the body of the song instead.
 */
export function anchorFor(track, mode) {
  const longest = LADDER.at(-1);
  const latest = track.durationMs - longest - 500;
  if (mode === 'start' || latest <= 0) return 0;
  const frac = 0.15 + (hash(track.id) % 1000) / 1000 * 0.5; // 15%–65% in
  return Math.min(Math.round(track.durationMs * frac), latest);
}

/** Earlier guesses are worth more; giving up scores nothing. */
export function pointsFor(stageIndex) {
  return LADDER.length - stageIndex;
}

export function createGame(tracks, { rounds, anchorMode, wrongGuessAdvances }) {
  const order = shuffle(tracks).slice(0, Math.min(rounds, tracks.length));
  return {
    order,
    anchorMode,
    wrongGuessAdvances,
    index: 0,
    score: 0,
    results: [],
    round: null,
  };
}

export function startRound(game) {
  const track = game.order[game.index];
  game.round = {
    track,
    anchor: anchorFor(track, game.anchorMode),
    stage: 0,
    guesses: [],
    over: false,
    won: false,
  };
  return game.round;
}

export const currentDuration = (round) => LADDER[round.stage];
export const canExtend = (round) => round.stage < MAX_STAGE;

export function extend(round) {
  if (!canExtend(round)) return false;
  round.stage++;
  return true;
}

/**
 * Scores a guess. A wrong guess optionally burns a rung of the ladder,
 * otherwise you could brute-force the whole playlist at 0.1s.
 */
export function submitGuess(game, guessTrack) {
  const round = game.round;
  if (round.over) return { correct: false, alreadyOver: true };

  const correct = answerKey(guessTrack) === answerKey(round.track);
  round.guesses.push({ track: guessTrack, correct });

  if (correct) {
    round.over = true;
    round.won = true;
    const points = pointsFor(round.stage);
    game.score += points;
    game.results.push({ track: round.track, won: true, stage: round.stage, points });
    return { correct: true, points, stage: round.stage };
  }

  let exhausted = false;
  if (game.wrongGuessAdvances && !extend(round)) exhausted = true;

  return { correct: false, exhausted };
}

export function giveUp(game) {
  const round = game.round;
  if (round.over) return;
  round.over = true;
  round.won = false;
  game.results.push({ track: round.track, won: false, stage: round.stage, points: 0 });
}

export const hasNextRound = (game) => game.index < game.order.length - 1;

export function nextRound(game) {
  if (!hasNextRound(game)) return null;
  game.index++;
  return startRound(game);
}
