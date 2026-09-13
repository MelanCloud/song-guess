/**
 * Web Playback SDK wrapper with self-calibrating snippet playback.
 *
 * Timing note: resume() and pause() are asynchronous commands to Spotify's
 * player, so a naive "resume, setTimeout(100), pause" overshoots badly. We
 * instead measure what actually played (the SDK reports an exact playback
 * position) and learn a lag compensation, so short snippets converge onto
 * their target within a few plays.
 */

import { getAccessToken } from './auth.js';
import * as api from './api.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

let player = null;
let deviceId = null;
let volume = 0.8;

/** Learned ms that keep playing after we issue pause(). */
let lagMs = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function loadSdk() {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => reject(new Error('Could not load the Spotify Web Playback SDK.'));
    document.head.appendChild(s);
  });
}

/**
 * Boots the SDK and waits for a device id.
 * `onFatal` fires for errors that end the session (e.g. non-Premium account).
 */
export async function initPlayer({ onFatal } = {}) {
  if (deviceId) return deviceId;
  await loadSdk();

  player = new window.Spotify.Player({
    name: 'Song Guess',
    getOAuthToken: (cb) => {
      getAccessToken().then(cb).catch(() => cb(''));
    },
    volume,
  });

  const ready = new Promise((resolve, reject) => {
    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      resolve(device_id);
    });
    player.addListener('initialization_error', ({ message }) =>
      reject(new Error(`Player failed to start: ${message}`)));
    player.addListener('authentication_error', ({ message }) =>
      reject(new Error(`Spotify rejected the session: ${message}`)));
    player.addListener('account_error', () =>
      reject(new Error(
        'This Spotify account cannot use the Web Playback SDK. ' +
        'Spotify Premium is required to play full tracks in the browser.'
      )));
    setTimeout(() => reject(new Error('Timed out waiting for the Spotify player to start.')), 20_000);
  });

  player.addListener('not_ready', () => { deviceId = null; });
  player.addListener('playback_error', ({ message }) => {
    onFatal?.(new Error(`Playback error: ${message}`));
  });

  const connected = await player.connect();
  if (!connected) throw new Error('Could not connect to Spotify playback.');

  const id = await ready;
  await api.transferPlayback(id, false).catch(() => {});
  return id;
}

/** Satisfies browser autoplay policy — must run inside a user gesture. */
export async function activate() {
  try {
    await player?.activateElement?.();
  } catch {
    /* not all browsers expose this */
  }
}

async function positionMs() {
  const state = await player.getCurrentState();
  return state ? state.position : null;
}

/**
 * Cues a track at `anchorMs` and leaves it paused and silent, ready to play.
 * Loading is the slow part, so doing it up front keeps snippet timing tight.
 */
export async function cueTrack(uri, anchorMs) {
  await player.setVolume(0);
  await api.startPlayback(deviceId, uri, anchorMs);

  // Wait for the track to actually be loaded before pausing, otherwise the
  // pause can race the load and the seek lands nowhere.
  for (let i = 0; i < 40; i++) {
    const state = await player.getCurrentState();
    if (state && !state.loading) break;
    await sleep(50);
  }

  await player.pause();
  await player.seek(anchorMs);
  await player.setVolume(volume);
}

/**
 * Plays exactly `targetMs` of audio starting at `anchorMs`, then re-cues.
 * Returns the measured length actually heard.
 */
export async function playSnippet(anchorMs, targetMs) {
  await player.seek(anchorMs);
  await player.setVolume(volume);

  const wait = Math.max(0, targetMs - lagMs);
  await player.resume();
  if (wait > 0) await sleep(wait);
  await player.pause();

  const end = await positionMs();
  await player.seek(anchorMs);

  if (end == null) return null;

  const measured = end - anchorMs;
  // Ignore nonsense readings (seek races, state lag).
  if (measured <= 0 || measured > targetMs + 3000) return null;

  // Only learn from a snippet we actually timed. When `wait` clamps to zero the
  // target is shorter than the round-trip itself, so the measurement reports the
  // floor of what this connection can do, not our lag - feeding it back would
  // inflate the estimate and then overshoot every longer rung.
  if (wait > 0) lagMs = clamp(lagMs + (measured - targetMs) * 0.6, 0, 400);

  return measured;
}

/**
 * Plays a silent snippet to seed the lag estimate, so the very first 0.1s
 * round is already close instead of wildly long.
 */
export async function calibrate(uri, anchorMs) {
  const saved = volume;
  try {
    await player.setVolume(0);
    volume = 0;
    await cueTrack(uri, anchorMs);
    await playSnippet(anchorMs, 400);
    await playSnippet(anchorMs, 400);
  } catch {
    /* calibration is best-effort */
  } finally {
    volume = saved;
    await player.setVolume(saved).catch(() => {});
  }
}

export async function stop() {
  try {
    await player?.pause();
  } catch {
    /* already stopped */
  }
}
