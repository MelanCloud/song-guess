/**
 * Boots the real index.html + main.js in jsdom against a fake Spotify API and
 * a fake Web Playback SDK, then plays a full game through the DOM.
 *
 * This covers everything the unit tests cannot: module load order, event
 * wiring, the round loop, and the snippet timing calibration in player.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:8080';

/* ------------------------------------------------------------- fake data */

const ARTISTS = ['Queen', 'David Bowie', 'a-ha', 'Blondie', 'The Cure'];
const TRACKS = Array.from({ length: 24 }, (_, i) => ({
  id: String(i).padStart(22, 'x'),
  uri: `spotify:track:${String(i).padStart(22, 'x')}`,
  name: `Song Number ${i}`,
  type: 'track',
  duration_ms: 180_000 + i * 1000,
  is_playable: true,
  artists: [{ name: ARTISTS[i % ARTISTS.length] }],
  album: { name: `Album ${i}`, images: [{ url: 'http://img/big.jpg' }, { url: 'http://img/small.jpg' }] },
}));

// Things the loader must filter out.
const JUNK = [
  { is_local: true, item: { ...TRACKS[0], id: 'local1', name: 'Local File' } },
  { is_local: false, item: { ...TRACKS[1], id: 'blocked', name: 'Blocked', is_playable: false } },
  { is_local: false, item: { ...TRACKS[2], id: 'ep1', name: 'An Episode', type: 'episode' } },
  { is_local: false, item: null },
];

const calls = [];
/** Flipped on by the last test to exercise the editorial-playlist 404 path. */
let force404 = false;
/** Flipped on to exercise the not-owner-or-collaborator 403 path. */
let force403 = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(input, init = {}) {
  // api.js passes a URL object; real fetch accepts that, so normalise here.
  const url = String(input?.url ?? input);
  const method = init.method || 'GET';
  calls.push(`${method} ${url.replace('https://api.spotify.com/v1', '')}`);

  if (force404 && url.includes('/v1/playlists/')) {
    return Promise.resolve(json({ error: { status: 404, message: 'Not found.' } }, 404));
  }
  if (url.includes('/v1/me/player/play')) return Promise.resolve(new Response(null, { status: 204 }));
  if (url.endsWith('/v1/me/player')) return Promise.resolve(new Response(null, { status: 204 }));
  if (url.includes('/v1/me')) {
    // No `product`: Spotify stopped returning it to development-mode apps in Feb 2026.
    return Promise.resolve(json({ id: 'tester', display_name: 'Tester' }));
  }
  if (force403 && url.includes('/items')) {
    return Promise.resolve(json({ error: { status: 403, message: 'Forbidden' } }, 403));
  }
  // The endpoint removed in Feb 2026, so a regression back to it fails loudly.
  if (url.includes('/tracks')) {
    return Promise.resolve(json({ error: { status: 403, message: 'Forbidden' } }, 403));
  }
  if (url.includes('/items')) {
    return Promise.resolve(json({
      next: null,
      items: [...JUNK, ...TRACKS.map((t) => ({ is_local: false, item: t }))],
    }));
  }
  if (url.includes('/v1/playlists/')) {
    return Promise.resolve(json({
      id: 'p'.repeat(22),
      name: 'Test Playlist',
      images: [{ url: 'http://img/pl.jpg' }],
      owner: { display_name: 'Someone' },
      tracks: { total: TRACKS.length },
    }));
  }
  return Promise.resolve(json({ error: { message: `unrouted ${url}` } }, 404));
}

/* ---------------------------------------------- fake Web Playback SDK */

/** Simulated command latency, so calibration has something real to learn. */
const FAKE_LAG = 90;

class FakePlayer {
  constructor() {
    this.listeners = {};
    this.position = 0;
    this.paused = true;
    this.volume = 1;
    this.resumedAt = 0;
    this.activated = 0;
  }
  addListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, arg) { (this.listeners[ev] || []).forEach((f) => f(arg)); }
  async connect() {
    setTimeout(() => this.emit('ready', { device_id: 'fake-device' }), 0);
    return true;
  }
  async activateElement() { this.activated++; }
  async setVolume(v) { this.volume = v; }
  async seek(ms) { this.position = ms; }
  async resume() {
    if (this.paused) { this.paused = false; this.resumedAt = Date.now(); }
  }
  async pause() {
    if (!this.paused) {
      // Audio keeps flowing for FAKE_LAG ms after the command is issued.
      this.position += Date.now() - this.resumedAt + FAKE_LAG;
      this.paused = true;
    }
  }
  async getCurrentState() {
    const pos = this.paused ? this.position : this.position + (Date.now() - this.resumedAt);
    return { position: pos, paused: this.paused, loading: false };
  }
}

/* ------------------------------------------------------------ boot jsdom */

const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), {
  url: `${ORIGIN}/`,
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

// Pre-authorise so the app boots straight past the setup and login screens.
window.localStorage.setItem('sg.clientId', 'test-client-id');
window.localStorage.setItem('sg.tokens', JSON.stringify({
  access_token: 'test-access',
  refresh_token: 'test-refresh',
  expires_at: Date.now() + 3_600_000,
}));

let fakePlayer;
window.Spotify = { Player: function () { fakePlayer = new FakePlayer(); return fakePlayer; } };

// The app modules read these off the global scope.
Object.assign(globalThis, {
  window,
  document: doc,
  location: window.location,
  history: window.history,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  fetch: fakeFetch,
});

// Node 24 defines `navigator` as a getter-only global, so it needs replacing
// rather than assigning.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator, configurable: true, writable: true,
});

const $ = (id) => doc.getElementById(id);
const visible = () => [...doc.querySelectorAll('.screen')].find((s) => !s.hidden)?.id;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition the app reaches asynchronously. */
async function until(fn, label, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await tick(10);
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}
function key(el, k) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

// jsdom implements no layout, so scrollIntoView is missing; it exists in every
// real browser, so stub it rather than guarding the app code against it.
window.Element.prototype.scrollIntoView = function () {};

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error || e.message));

await import('../js/main.js');
await until(() => visible() === 'screen-playlist', 'the playlist screen after boot');

/* ----------------------------------------------------------------- tests */

test('boots to the playlist screen without throwing', () => {
  assert.deepEqual(errors, []);
  assert.equal(visible(), 'screen-playlist');
});

test('shows the signed-in user and the correct redirect URI', () => {
  assert.equal($('user-chip').textContent, 'Tester');
  assert.equal($('redirect-uri').textContent, `${ORIGIN}/callback`);
  assert.equal($('btn-logout').hidden, false);
});

test('rejects input that is not a playlist reference', async () => {
  $('playlist-input').value = 'not a playlist';
  fire($('form-playlist'), 'submit');
  await tick(20);
  assert.match($('playlist-status').textContent, /does not look like a playlist/);
  assert.equal($('playlist-status').classList.contains('is-error'), true);
});

test('loads a playlist and filters out unplayable entries', async () => {
  $('playlist-input').value = `https://open.spotify.com/playlist/${'p'.repeat(22)}?si=abc`;
  fire($('form-playlist'), 'submit');
  await until(() => !$('game-options').hidden, 'the options panel');

  assert.equal($('pl-name').textContent, 'Test Playlist');
  // 4 junk entries dropped: local file, region-blocked, episode, null.
  assert.match($('pl-sub').textContent, new RegExp(`^${TRACKS.length} playable tracks`));
  assert.match($('pl-sub').textContent, /by Someone/);
  assert.match($('pl-sub').textContent, /4 unplayable skipped/);
  assert.equal($('opt-rounds').value, '10');
  assert.ok(calls.some((c) => /^GET \/playlists\/p+\/items\?.*limit=50/.test(c)),
    'must load from /items, 50 per page');
  assert.ok(!calls.some((c) => c.includes('/tracks')), 'the removed /tracks endpoint must not be called');
});

test('starting a game boots the player and cues the first round', async () => {
  $('opt-rounds').value = '2';
  $('opt-advance').checked = true;
  fire($('btn-start'), 'click');

  await until(() => visible() === 'screen-game', 'the game screen');
  await until(() => !$('btn-play').disabled, 'the play button to be enabled after cueing');

  assert.equal($('loading').hidden, true, 'loading overlay must be dismissed');
  assert.equal($('round-label').textContent, 'Song 1 of 2');
  assert.equal($('score-label').textContent, 'Score 0');
  assert.ok(calls.includes('PUT /me/player'), 'playback should be transferred to our device');
  assert.ok(calls.some((c) => c.startsWith('PUT /me/player/play')), 'a track should be cued');
});

test('the ladder renders 0.1s to 10s with the first rung active', () => {
  const rungs = [...$('ladder').querySelectorAll('li')];
  assert.deepEqual(rungs.map((li) => li.textContent),
    ['0.1s', '0.5s', '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s']);
  assert.equal(rungs[0].className, 'is-current');
  assert.equal($('snippet-len').textContent, '0.1s');
});

test('playing the 0.1s snippet lands close to the target', async () => {
  fire($('btn-play'), 'click');
  await until(() => /^Played/.test($('snippet-hint').textContent), 'the snippet to finish');

  const measured = Number($('snippet-hint').textContent.match(/([\d.]+)s/)[1]) * 1000;
  assert.ok(measured > 0, 'something must actually play');
  assert.ok(Math.abs(measured - 100) < 60,
    `0.1s snippet measured ${measured}ms, expected within 60ms of 100ms`);
  assert.equal(fakePlayer.activated > 0, true, 'autoplay policy must be satisfied');
  assert.equal(fakePlayer.paused, true, 'playback must stop after the snippet');
});

test('More time advances the ladder and the displayed length', () => {
  fire($('btn-more'), 'click');
  assert.equal($('snippet-len').textContent, '0.5s');
  const rungs = [...$('ladder').querySelectorAll('li')];
  assert.equal(rungs[0].className, 'is-done');
  assert.equal(rungs[1].className, 'is-current');
  assert.match($('snippet-hint').textContent, /Unlocked 0\.5s/);
});

test('a longer snippet also lands close to its target', async () => {
  fire($('btn-more'), 'click'); // -> 1s
  fire($('btn-more'), 'click'); // -> 2s
  assert.equal($('snippet-len').textContent, '2s');

  fire($('btn-play'), 'click');
  await until(() => /^Played/.test($('snippet-hint').textContent), 'the 2s snippet', 8000);
  const measured = Number($('snippet-hint').textContent.match(/([\d.]+)s/)[1]) * 1000;
  assert.ok(Math.abs(measured - 2000) < 120,
    `2s snippet measured ${measured}ms, expected within 120ms of 2000ms`);
});

test('the autocomplete lists only this playlist and narrows by artist', async () => {
  const input = $('guess-input');
  input.value = 'queen';
  fire(input, 'input');

  const items = [...$('guess-list').querySelectorAll('.ac-item')];
  assert.ok(items.length > 0, 'dropdown should open');
  assert.equal($('guess-list').hidden, false);
  for (const li of items) {
    assert.match(li.querySelector('.ac-artist').textContent, /Queen/);
  }
  // Only songs that are actually in the playlist.
  const titles = items.map((li) => li.querySelector('.ac-title').textContent);
  for (const t of titles) assert.match(t, /^Song Number \d+$/);
  assert.ok(items[0].innerHTML.includes('<mark>'), 'matched text should be highlighted');
});

test('typing nonsense closes the dropdown', () => {
  const input = $('guess-input');
  input.value = 'zzzzqqq';
  fire(input, 'input');
  assert.equal($('guess-list').hidden, true);
});

test('keyboard navigation picks an option and fills the box', () => {
  const input = $('guess-input');
  input.value = 'song number 1';
  fire(input, 'input');
  const before = [...$('guess-list').querySelectorAll('.ac-item')].length;
  assert.ok(before > 1, 'expected several matches to navigate');

  key(input, 'ArrowDown');
  const active = $('guess-list').querySelector('.ac-item.is-active');
  assert.ok(active, 'arrow key should move the active option');
  const wanted = active.querySelector('.ac-title').textContent;

  key(input, 'Enter');
  assert.equal($('guess-list').hidden, true, 'Enter should close the dropdown');
  assert.ok(input.value.startsWith(wanted), `box should hold "${wanted}", got "${input.value}"`);
});

test('a guess matching nothing in the playlist is refused', () => {
  const input = $('guess-input');
  input.value = 'Some Song That Is Not Here';
  fire($('form-guess'), 'submit');
  assert.match($('snippet-hint').textContent, /No song in this playlist matches/);
  assert.equal($('guess-log').children.length, 0, 'a non-match must not count as a guess');
});

test('giving up reveals the answer and offers the next song', async () => {
  fire($('btn-giveup'), 'click');
  await tick(20);

  assert.equal($('reveal').hidden, false, 'reveal panel should appear');
  assert.equal($('form-guess').hidden, true, 'guess form should be hidden once the round ends');
  assert.equal($('rv-verdict').textContent, 'Gave up');
  assert.equal($('rv-verdict').className, 'rv-verdict lose');
  assert.match($('rv-title').textContent, /^Song Number \d+$/);
  assert.match($('rv-link').href, /^https:\/\/open\.spotify\.com\/track\//);
  assert.equal($('btn-next').textContent, 'Next song');
  assert.equal($('btn-play').disabled, true, 'play must be disabled after the round ends');
});

test('the next song resets the ladder and the guess box', async () => {
  const firstAnswer = $('rv-title').textContent;
  fire($('btn-next'), 'click');
  await until(() => $('round-label').textContent === 'Song 2 of 2', 'round 2');
  await until(() => !$('btn-play').disabled, 'round 2 to finish cueing');

  assert.equal($('reveal').hidden, true);
  assert.equal($('form-guess').hidden, false);
  assert.equal($('snippet-len').textContent, '0.1s');
  assert.equal($('guess-input').value, '', 'guess box should be cleared');
  assert.equal($('guess-log').children.length, 0, 'guess log should be cleared');
  assert.equal($('ladder').querySelector('li').className, 'is-current');
  assert.equal($('score-label').textContent, 'Score 0');
  assert.ok(firstAnswer);
});

test('finishing the last round shows the summary', async () => {
  fire($('btn-giveup'), 'click');
  await tick(20);
  assert.equal($('btn-next').textContent, 'See results');

  fire($('btn-next'), 'click');
  await until(() => visible() === 'screen-summary', 'the summary screen');

  assert.match($('sum-score').textContent, /^0 points · 0\/2 correct$/);
  const rows = [...$('sum-list').querySelectorAll('li')];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.querySelector('.no').textContent, 'missed');
});

/* ------------------------------------- scoring, with a deterministic shuffle */

test('a second game can be started from the summary', async () => {
  fire($('btn-newplaylist'), 'click');
  await tick(20);
  assert.equal(visible(), 'screen-playlist');
  assert.equal($('game-options').hidden, false, 'the loaded playlist should still be ready');

  // Pin the shuffle so the answers are predictable below.
  Object.defineProperty(globalThis, 'crypto', {
    value: { ...globalThis.crypto, getRandomValues: (arr) => arr.fill(0) },
    configurable: true, writable: true,
  });

  $('opt-rounds').value = '2';
  $('opt-advance').checked = false; // wrong guesses must not advance the ladder
  fire($('btn-start'), 'click');
  await until(() => visible() === 'screen-game', 'the second game');
  await until(() => !$('btn-play').disabled, 'the first round to cue');
  assert.equal($('round-label').textContent, 'Song 1 of 2');
  assert.equal($('score-label').textContent, 'Score 0');

  const { shuffle } = await import('../js/game.js');
  expectedOrder = shuffle([...TRACKS.keys()]).map((i) => TRACKS[i].name);
});

/**
 * The app shuffles its track list; with the RNG pinned above, running the same
 * shuffle here reproduces the order it picked. Must be computed after the stub
 * is installed, so it cannot live at module top level.
 */
let expectedOrder;

function guess(title) {
  $('guess-input').value = title;
  fire($('form-guess'), 'submit');
}

test('a wrong guess is logged and does not advance the ladder when disabled', () => {
  const answer = expectedOrder[0];
  const wrong = TRACKS.map((t) => t.name).find((n) => n !== answer);

  guess(wrong);

  assert.equal($('reveal').hidden, true, 'a wrong guess must not end the round');
  assert.equal($('guess-log').children.length, 1);
  assert.match($('guess-log').textContent, new RegExp(wrong));
  assert.equal($('snippet-len').textContent, '0.1s', 'ladder must stay put when the option is off');
  assert.equal($('guess-input').value, '', 'the box should clear after a guess');
});

test('the correct answer at 0.1s scores full points and reveals the track', () => {
  guess(expectedOrder[0]);

  assert.equal($('reveal').hidden, false);
  assert.equal($('rv-verdict').className, 'rv-verdict win');
  assert.match($('rv-verdict').textContent, /^Got it in 0\.1s · \+12$/);
  assert.equal($('rv-title').textContent, expectedOrder[0]);
  assert.equal($('score-label').textContent, 'Score 12');
});

test('the final summary totals both rounds', async () => {
  fire($('btn-next'), 'click');
  await until(() => $('round-label').textContent === 'Song 2 of 2', 'round 2');
  await until(() => !$('btn-play').disabled, 'round 2 to cue');

  guess(expectedOrder[1]);
  assert.match($('rv-verdict').textContent, /^Got it in 0\.1s · \+12$/);

  assert.equal($('btn-next').textContent, 'See results');
  fire($('btn-next'), 'click');
  await until(() => visible() === 'screen-summary', 'the summary');

  assert.match($('sum-score').textContent, /^24 points · 2\/2 correct$/);
  const rows = [...$('sum-list').querySelectorAll('li')];
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row.querySelector('.ok').textContent, /0\.1s · \+12/);
});

test('no uncaught errors were raised during the whole session', () => {
  assert.deepEqual(errors, []);
});

test('a 404 playlist explains the editorial-playlist restriction', async () => {
  fire($('btn-newplaylist'), 'click');
  await tick(20);
  force404 = true;

  $('playlist-input').value = `spotify:playlist:${'q'.repeat(22)}`;
  fire($('form-playlist'), 'submit');
  await until(() => $('playlist-status').classList.contains('is-error'), 'the 404 message');

  const msg = $('playlist-status').textContent;
  assert.match(msg, /404/);
  assert.match(msg, /Discover Weekly/);
  assert.match(msg, /you created or collaborate on/);
  assert.equal($('game-options').hidden, true, 'options must be hidden after a failed load');
  assert.deepEqual(errors, [], 'the 404 must not raise an uncaught error');
  force404 = false;
});

test('a 403 playlist explains the owner-or-collaborator rule and the workaround', async () => {
  force403 = true;
  $('playlist-input').value = `spotify:playlist:${'r'.repeat(22)}`;
  fire($('form-playlist'), 'submit');
  await until(() => /403 Forbidden/.test($('playlist-status').textContent), 'the 403 message');

  const msg = $('playlist-status').textContent;
  assert.match(msg, /you created or are a collaborator on/);
  assert.match(msg, /New playlist/);
  assert.equal($('playlist-status').classList.contains('is-error'), true);
  assert.equal($('game-options').hidden, true);
  assert.deepEqual(errors, []);
  force403 = false;
});
