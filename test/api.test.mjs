/**
 * api.js and auth.js in isolation. Both read browser globals at import time,
 * so those are stubbed before the modules load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'http://127.0.0.1:8080';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

globalThis.location = { origin: ORIGIN, href: `${ORIGIN}/` };
globalThis.history = { replaceState() {} };
globalThis.localStorage = memoryStorage();
globalThis.sessionStorage = memoryStorage();

let routes = [];
let requests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  requests.push({ url, method: init.method || 'GET', body: init.body?.toString() });
  const route = routes.find((r) => r.match(url, init));
  if (!route) throw new Error(`no route for ${init.method || 'GET'} ${url}`);
  return route.reply();
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const api = await import('../js/api.js');
const auth = await import('../js/auth.js');

function reset() {
  routes = [];
  requests = [];
  localStorage.clear();
  auth.setClientId('cid');
}

function login(expiresInMs = 3_600_000) {
  localStorage.setItem('sg.tokens', JSON.stringify({
    access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Date.now() + expiresInMs,
  }));
}

/* --------------------------------------------------------- playlist ids */

test('parsePlaylistId accepts every form a user might paste', () => {
  const id = '37i9dQZF1DXcBWIGoYBM5M';
  assert.equal(api.parsePlaylistId(id), id);
  assert.equal(api.parsePlaylistId(`spotify:playlist:${id}`), id);
  assert.equal(api.parsePlaylistId(`https://open.spotify.com/playlist/${id}`), id);
  assert.equal(api.parsePlaylistId(`https://open.spotify.com/playlist/${id}?si=abc123`), id);
  assert.equal(api.parsePlaylistId(`  https://open.spotify.com/playlist/${id}  `), id);
  assert.equal(api.parsePlaylistId(`https://open.spotify.com/intl-de/playlist/${id}`), id);
});

test('parsePlaylistId rejects anything else', () => {
  for (const bad of ['', '   ', null, undefined, 'hello', 'spotify:album:37i9dQZF1DXcBWIGoYBM5M',
    'https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M', 'short']) {
    assert.equal(api.parsePlaylistId(bad), null, `should reject: ${bad}`);
  }
});

/* ------------------------------------------------------------- requests */

test('a valid token is sent straight through without refreshing', async () => {
  reset(); login();
  routes = [{ match: (u) => u.endsWith('/me'), reply: () => json({ id: 'me' }) }];
  await api.getMe();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.spotify.com/v1/me');
});

test('an expiring token is refreshed before the call', async () => {
  reset();
  login(30_000); // inside the 60s refresh window
  routes = [
    { match: (u) => u.includes('accounts.spotify.com'), reply: () => json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }) },
    { match: (u) => u.endsWith('/me'), reply: () => json({ id: 'me' }) },
  ];
  await api.getMe();

  assert.match(requests[0].url, /accounts\.spotify\.com/);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.match(requests[0].body, /refresh_token=refresh-1/);
  const stored = JSON.parse(localStorage.getItem('sg.tokens'));
  assert.equal(stored.access_token, 'access-2');
  assert.equal(stored.refresh_token, 'refresh-2');
});

test('a refresh that omits a new refresh token keeps the old one', async () => {
  reset(); login(30_000);
  routes = [
    { match: (u) => u.includes('accounts.spotify.com'), reply: () => json({ access_token: 'access-2', expires_in: 3600 }) },
    { match: (u) => u.endsWith('/me'), reply: () => json({ id: 'me' }) },
  ];
  await api.getMe();
  assert.equal(JSON.parse(localStorage.getItem('sg.tokens')).refresh_token, 'refresh-1');
});

test('a rejected refresh logs the user out rather than looping', async () => {
  reset(); login(30_000);
  routes = [{ match: (u) => u.includes('accounts.spotify.com'), reply: () => json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400) }];
  await assert.rejects(() => api.getMe(), /Refresh token revoked/);
  assert.equal(auth.isLoggedIn(), false, 'a dead refresh token must not be kept');
});

test('a 429 is retried once after the Retry-After delay', async () => {
  reset(); login();
  let n = 0;
  routes = [{
    match: (u) => u.endsWith('/me'),
    reply: () => (++n === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : json({ id: 'me' })),
  }];
  const me = await api.getMe();
  assert.equal(me.id, 'me');
  assert.equal(n, 2, 'should have retried exactly once');
});

test('an API error surfaces Spotify\'s own message', async () => {
  reset(); login();
  routes = [{ match: (u) => u.includes('/playlists/'), reply: () => json({ error: { status: 404, message: 'Resource not found' } }, 404) }];
  await assert.rejects(
    () => api.getPlaylist('x'.repeat(22)),
    (err) => {
      assert.ok(err instanceof api.ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.message, 'Resource not found');
      return true;
    },
  );
});

test('a 204 response is treated as success, not as empty JSON', async () => {
  reset(); login();
  routes = [{ match: (u) => u.includes('/me/player'), reply: () => new Response(null, { status: 204 }) }];
  assert.equal(await api.transferPlayback('dev'), null);
});

test('Retry-After: 0 retries immediately instead of waiting a default', async () => {
  reset(); login();
  let n = 0;
  routes = [{
    match: (u) => u.endsWith('/me'),
    reply: () => (++n === 1
      ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
      : json({ id: 'me' })),
  }];
  const started = Date.now();
  await api.getMe();
  assert.ok(Date.now() - started < 900, 'a zero Retry-After must not fall back to the 2s default');
});

test('a missing Retry-After still falls back to a sane delay', async () => {
  reset(); login();
  let n = 0;
  routes = [{
    match: (u) => u.endsWith('/me'),
    reply: () => (++n === 1 ? new Response('', { status: 429 }) : json({ id: 'me' })),
  }];
  const started = Date.now();
  await api.getMe();
  assert.ok(Date.now() - started > 1500, 'no header should back off, not hammer');
});

/* ------------------------------------------- Feb 2026 playlist migration */

const entry = (i, key = 'item') => ({
  is_local: false,
  [key]: {
    id: `t${i}`, uri: `spotify:track:t${i}`, name: `T${i}`, duration_ms: 200_000,
    type: 'track', is_playable: true, artists: [{ name: 'A' }], album: { name: 'Al', images: [] },
  },
});

test('playlist items load from /items, 50 at a time, following next', async () => {
  reset(); login();
  routes = [{
    match: (u) => u.includes('/items'),
    reply: () => {
      const offset = Number(new URL(requests.at(-1).url).searchParams.get('offset'));
      const count = offset === 0 ? 50 : 20;
      return json({
        items: Array.from({ length: count }, (_, i) => entry(offset + i)),
        next: offset === 0 ? 'more' : null,
      });
    },
  }];

  const { tracks } = await api.getPlaylistTracks('p'.repeat(22));

  assert.equal(tracks.length, 70);
  assert.equal(new Set(tracks.map((t) => t.id)).size, 70, 'pages must not overlap or skip');
  assert.deepEqual(requests.map((r) => new URL(r.url).searchParams.get('offset')), ['0', '50']);
  for (const r of requests) {
    assert.match(r.url, /\/playlists\/p+\/items\?/);
    assert.doesNotMatch(r.url, /\/tracks/);
    assert.equal(new URL(r.url).searchParams.get('limit'), '50', 'the /items endpoint caps pages at 50');
  }
});

test('an entry still under the deprecated `track` key is read as well', async () => {
  reset(); login();
  routes = [{ match: (u) => u.includes('/items'), reply: () => json({ items: [entry(1, 'track')], next: null }) }];
  const { tracks, skipped } = await api.getPlaylistTracks('p'.repeat(22));
  assert.equal(tracks.length, 1);
  assert.equal(skipped, 0);
});

test('playlist metadata asks for the renamed items field, not tracks', async () => {
  reset(); login();
  routes = [{ match: (u) => u.includes('/playlists/'), reply: () => json({ id: 'p', name: 'P' }) }];
  await api.getPlaylist('p'.repeat(22));
  const fields = new URL(requests[0].url).searchParams.get('fields');
  assert.match(fields, /items\(total\)/);
  assert.doesNotMatch(fields, /tracks/);
});
