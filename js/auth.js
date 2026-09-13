/**
 * Spotify Authorization Code flow with PKCE.
 *
 * PKCE means no client secret, so the whole app can stay static — nothing
 * sensitive ever lives on the server.
 */

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

// Must match the Spotify dashboard entry byte for byte.
export const REDIRECT_URI = `${location.origin}/callback`;

const SCOPES = [
  'streaming',                    // Web Playback SDK
  'user-read-email',              // required by the SDK to verify Premium
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',   // start/transfer playback on our device
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

const KEY = {
  clientId: 'sg.clientId',
  verifier: 'sg.pkceVerifier',
  state: 'sg.oauthState',
  tokens: 'sg.tokens',
};

/* ------------------------------------------------------------------ utils */

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 64) {
  const a = new Uint8Array(byteLength);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function sha256Challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/* -------------------------------------------------------------- client id */

export function getClientId() {
  return localStorage.getItem(KEY.clientId) || '';
}

export function setClientId(id) {
  localStorage.setItem(KEY.clientId, String(id).trim());
}

export function clearClientId() {
  localStorage.removeItem(KEY.clientId);
}

/* ---------------------------------------------------------------- tokens */

function readTokens() {
  try {
    return JSON.parse(localStorage.getItem(KEY.tokens) || 'null');
  } catch {
    return null;
  }
}

function writeTokens(t) {
  localStorage.setItem(KEY.tokens, JSON.stringify(t));
}

export function isLoggedIn() {
  const t = readTokens();
  return Boolean(t && t.refresh_token);
}

export function logout() {
  localStorage.removeItem(KEY.tokens);
  localStorage.removeItem(KEY.verifier);
  localStorage.removeItem(KEY.state);
}

/* ------------------------------------------------------------------ flow */

export async function beginLogin() {
  const clientId = getClientId();
  if (!clientId) throw new Error('No Client ID set.');

  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(KEY.verifier, verifier);
  sessionStorage.setItem(KEY.state, state);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await sha256Challenge(verifier),
    state,
    scope: SCOPES,
  });

  location.assign(`${AUTH_URL}?${params}`);
}

/**
 * If the current URL is an OAuth redirect, finish the exchange.
 * Returns true when a login just completed.
 */
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  if (!code && !error) return false;

  // Clean the URL regardless of outcome so a refresh doesn't retry a used code.
  history.replaceState({}, '', '/');

  if (error) throw new Error(`Spotify denied the login: ${error}`);

  const expected = sessionStorage.getItem(KEY.state);
  const verifier = sessionStorage.getItem(KEY.verifier);
  sessionStorage.removeItem(KEY.state);
  sessionStorage.removeItem(KEY.verifier);

  if (!expected || state !== expected) throw new Error('OAuth state mismatch — login aborted.');
  if (!verifier) throw new Error('Missing PKCE verifier — start the login again.');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: getClientId(),
      code_verifier: verifier,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(describeTokenError(data));
  }

  writeTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return true;
}

let refreshInFlight = null;

/** Returns a valid access token, refreshing when it is close to expiring. */
export async function getAccessToken() {
  const t = readTokens();
  if (!t) throw new Error('Not logged in.');
  if (t.access_token && Date.now() < t.expires_at - 60_000) return t.access_token;

  if (!refreshInFlight) {
    refreshInFlight = refresh(t.refresh_token).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: getClientId(),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logout();
    throw new Error(describeTokenError(data));
  }

  writeTokens({
    access_token: data.access_token,
    // Spotify only sometimes rotates the refresh token.
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

function describeTokenError(data) {
  const desc = data.error_description || data.error || 'unknown error';
  if (/redirect uri/i.test(desc)) {
    return `${desc}\n\nRegister exactly this redirect URI in your Spotify app settings:\n${REDIRECT_URI}`;
  }
  if (/invalid client/i.test(desc)) {
    return `${desc}\n\nCheck that the Client ID is correct and that the app exists.`;
  }
  return desc;
}
