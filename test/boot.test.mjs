/**
 * The three ways the app can come up: unconfigured, logged out, and logged in
 * with an account that cannot play.
 *
 * main.js reads the DOM at module-eval time, so each case needs its own jsdom
 * and its own module instance — hence the cache-busting query on the import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8080';

let boots = 0;

async function boot({ clientId, tokens, me, url = `${ORIGIN}/`, session, router }) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;

  if (clientId) window.localStorage.setItem('sg.clientId', clientId);
  if (tokens) window.localStorage.setItem('sg.tokens', JSON.stringify(tokens));
  for (const [k, v] of Object.entries(session || {})) window.sessionStorage.setItem(k, v);
  window.Element.prototype.scrollIntoView = function () {};
  window.Spotify = { Player: function () { return { addListener() {}, connect: async () => false }; } };

  Object.assign(globalThis, {
    window,
    document: doc,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    fetch: router || (async () => new Response(JSON.stringify(me || {}), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator, configurable: true, writable: true,
  });

  await import(`../js/main.js?boot=${++boots}`);

  const visible = () => [...doc.querySelectorAll('.screen')].find((s) => !s.hidden)?.id;
  for (let i = 0; i < 200 && !visible(); i++) await new Promise((r) => setTimeout(r, 10));
  return { doc, window, visible, $: (id) => doc.getElementById(id) };
}

test('with no Client ID it opens on the setup instructions', async () => {
  const { visible, $ } = await boot({});
  assert.equal(visible(), 'screen-setup');
  assert.equal($('redirect-uri').textContent, `${ORIGIN}/callback`,
    'the setup screen must show the exact URI Spotify requires');
  assert.match($('screen-setup').textContent, /Premium is required/);
  assert.equal($('btn-logout').hidden, true);
});

test('with a Client ID but no session it asks you to connect', async () => {
  const { visible, $ } = await boot({ clientId: 'cid' });
  assert.equal(visible(), 'screen-connect');
  assert.equal($('btn-login').hidden, false);
});

test('a free account is rejected up front with an explanation', async () => {
  const { visible, $ } = await boot({
    clientId: 'cid',
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
    me: { id: 'freeuser', display_name: 'Free User', product: 'free' },
  });

  assert.equal(visible(), 'screen-error');
  const text = $('error-text').textContent;
  assert.match(text, /Free User/);
  assert.match(text, /Spotify free/);
  assert.match(text, /Premium is required/);
  assert.match(text, /preview URLs were removed/,
    'should explain why a free account cannot work at all');
});

/* ------------------------------------------------------- OAuth redirect */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('returning from Spotify exchanges the code and starts the app', async () => {
  const seen = [];
  const { visible, window, $ } = await boot({
    clientId: 'cid',
    url: `${ORIGIN}/callback?code=THE_CODE&state=THE_STATE`,
    session: { 'sg.oauthState': 'THE_STATE', 'sg.pkceVerifier': 'THE_VERIFIER' },
    router: async (input, init = {}) => {
      const url = String(input?.url ?? input);
      seen.push({ url, body: init.body?.toString() });
      if (url.includes('accounts.spotify.com')) {
        return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      }
      // No `product`: Spotify stopped returning it to development-mode apps.
      return json({ id: 'u', display_name: 'Player One' });
    },
  });

  const exchange = seen.find((r) => r.url.includes('accounts.spotify.com'));
  assert.ok(exchange, 'the authorization code must be exchanged for a token');
  assert.match(exchange.body, /grant_type=authorization_code/);
  assert.match(exchange.body, /code=THE_CODE/);
  assert.match(exchange.body, /code_verifier=THE_VERIFIER/);
  assert.match(exchange.body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A8080%2Fcallback/);

  const stored = JSON.parse(window.localStorage.getItem('sg.tokens'));
  assert.equal(stored.access_token, 'new-access');
  assert.equal(stored.refresh_token, 'new-refresh');

  assert.equal(visible(), 'screen-playlist', 'a completed login lands on the playlist screen');
  assert.equal($('user-chip').textContent, 'Player One');
  assert.equal(window.location.search, '', 'the code must be stripped from the URL');
  assert.equal(window.sessionStorage.getItem('sg.pkceVerifier'), null,
    'the PKCE verifier must not be left behind');
});

test('a mismatched state is refused instead of exchanged', async () => {
  let exchanged = false;
  const { visible, $ } = await boot({
    clientId: 'cid',
    url: `${ORIGIN}/callback?code=THE_CODE&state=ATTACKER`,
    session: { 'sg.oauthState': 'THE_STATE', 'sg.pkceVerifier': 'THE_VERIFIER' },
    router: async (input) => {
      if (String(input).includes('accounts.spotify.com')) exchanged = true;
      return json({});
    },
  });

  assert.equal(exchanged, false, 'a forged state must never reach the token endpoint');
  assert.equal(visible(), 'screen-error');
  assert.match($('error-text').textContent, /state mismatch/i);
});

test('a denied authorisation is reported rather than swallowed', async () => {
  const { visible, $ } = await boot({
    clientId: 'cid',
    url: `${ORIGIN}/callback?error=access_denied`,
    router: async () => json({}),
  });
  assert.equal(visible(), 'screen-error');
  assert.match($('error-text').textContent, /access_denied/);
});

test('a redirect-URI mismatch explains how to fix the dashboard', async () => {
  const { $ } = await boot({
    clientId: 'cid',
    url: `${ORIGIN}/callback?code=C&state=S`,
    session: { 'sg.oauthState': 'S', 'sg.pkceVerifier': 'V' },
    router: async () => json({ error: 'invalid_grant', error_description: 'Invalid redirect URI' }, 400),
  });
  const text = $('error-text').textContent;
  assert.match(text, /Invalid redirect URI/);
  assert.match(text, /http:\/\/127\.0\.0\.1:8080\/callback/,
    'the error should tell the user exactly what to register');
});

test('a profile without the product field is not mistaken for a free account', async () => {
  // Since Feb 2026 /me omits `product` for development-mode apps, so its absence
  // must not block a Premium user; the SDK rejects free accounts on its own.
  const { visible, $ } = await boot({
    clientId: 'cid',
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
    me: { id: 'u', display_name: 'Premium Person' },
  });
  assert.equal(visible(), 'screen-playlist');
  assert.equal($('user-chip').textContent, 'Premium Person');
});
