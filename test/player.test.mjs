/**
 * player.js against a fake Web Playback SDK: how SDK errors are reported, and
 * whether snippet timing actually converges on its target.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location = { origin: 'http://127.0.0.1:8080' };
globalThis.localStorage = {
  getItem: (k) => (k === 'sg.tokens'
    ? JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 })
    : 'cid'),
  setItem() {}, removeItem() {},
};
globalThis.fetch = async () => new Response(null, { status: 204 });

/** Simulated one-way command latency of the real player. */
let FAKE_LAG = 90;

class FakePlayer {
  constructor() {
    this.listeners = {};
    this.position = 0;
    this.paused = true;
    this.resumedAt = 0;
    this.emitOnConnect = 'ready';
  }
  addListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, arg) { (this.listeners[ev] || []).forEach((f) => f(arg)); }
  async connect() {
    setTimeout(() => {
      if (this.emitOnConnect === 'ready') this.emit('ready', { device_id: 'dev-1' });
      else this.emit(this.emitOnConnect, { message: 'nope' });
    }, 0);
    return true;
  }
  async activateElement() {}
  async setVolume() {}
  async seek(ms) { this.position = ms; }
  async resume() { if (this.paused) { this.paused = false; this.resumedAt = Date.now(); } }
  async pause() {
    if (!this.paused) {
      this.position += Date.now() - this.resumedAt + FAKE_LAG;
      this.paused = true;
    }
  }
  async getCurrentState() {
    return {
      position: this.paused ? this.position : this.position + (Date.now() - this.resumedAt),
      paused: this.paused,
      loading: false,
    };
  }
}

let current;
globalThis.window = { Spotify: { Player: function () { current = new FakePlayer(); return current; } } };

const sdk = await import('../js/player.js');

/* ------------------------------------------------------------ SDK errors */

test('a free account gets a Premium-specific explanation', async () => {
  globalThis.window.Spotify.Player = function () {
    current = new FakePlayer();
    current.emitOnConnect = 'account_error';
    return current;
  };
  await assert.rejects(() => sdk.initPlayer({}), /Spotify Premium is required/);
});

test('an auth failure is reported as a rejected session', async () => {
  globalThis.window.Spotify.Player = function () {
    current = new FakePlayer();
    current.emitOnConnect = 'authentication_error';
    return current;
  };
  await assert.rejects(() => sdk.initPlayer({}), /Spotify rejected the session/);
});

test('an initialisation failure is reported', async () => {
  globalThis.window.Spotify.Player = function () {
    current = new FakePlayer();
    current.emitOnConnect = 'initialization_error';
    return current;
  };
  await assert.rejects(() => sdk.initPlayer({}), /Player failed to start/);
});

test('a refused connection is reported', async () => {
  globalThis.window.Spotify.Player = function () {
    current = new FakePlayer();
    current.connect = async () => false;
    return current;
  };
  await assert.rejects(() => sdk.initPlayer({}), /Could not connect/);
});

/* --------------------------------------------------------- snippet timing */

test('the player initialises once a device is ready', async () => {
  globalThis.window.Spotify.Player = function () { current = new FakePlayer(); return current; };
  assert.equal(await sdk.initPlayer({}), 'dev-1');
});

test('calibration pulls a 400ms snippet onto its target', async () => {
  await sdk.calibrate('spotify:track:x', 0);
  const measured = await sdk.playSnippet(0, 400);
  assert.ok(Math.abs(measured - 400) < 45,
    `after calibration a 400ms snippet measured ${measured}ms`);
});

test('a 0.1s snippet gets as close as the command latency allows', async () => {
  const measured = await sdk.playSnippet(0, 100);
  assert.ok(measured > 0, 'something must play');
  assert.ok(measured < 100 + FAKE_LAG,
    `0.1s snippet measured ${measured}ms, should not overshoot by a whole extra lag`);
});

test('a target shorter than the latency does not corrupt later, longer rungs', async () => {
  // The floor measurement from an impossible target must not inflate the lag
  // estimate, or every longer snippet afterwards would be cut short.
  for (let i = 0; i < 6; i++) await sdk.playSnippet(0, 100);
  const long = await sdk.playSnippet(0, 3000);
  assert.ok(Math.abs(long - 3000) < 120,
    `3s snippet measured ${long}ms after repeated 0.1s rounds`);
});

test('snippets re-anchor so each round starts from the same point', async () => {
  await sdk.cueTrack('spotify:track:y', 45_000);
  await sdk.playSnippet(45_000, 500);
  const state = await current.getCurrentState();
  assert.equal(state.position, 45_000, 'position must return to the anchor');
  assert.equal(state.paused, true);
});

test('a slower connection still converges', async () => {
  FAKE_LAG = 260;
  await sdk.calibrate('spotify:track:z', 0);
  const measured = await sdk.playSnippet(0, 2000);
  assert.ok(Math.abs(measured - 2000) < 150,
    `with 260ms latency a 2s snippet measured ${measured}ms`);
  FAKE_LAG = 90;
});
