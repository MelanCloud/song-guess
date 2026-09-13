/** Thin Spotify Web API wrapper: token refresh, rate limits, readable errors. */

import { getAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body, query, retry = true } = {}) {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 204 No Content is the success case for most player endpoints.
  if (res.status === 204) return null;

  if (res.status === 429 && retry) {
    // Retry-After: 0 is valid and means "go now", so a plain `|| 2` would be wrong.
    const header = res.headers.get('Retry-After');
    const secs = header === null ? 2 : Number(header);
    await sleep((Number.isFinite(secs) ? secs : 2) * 1000 + 250);
    return request(path, { method, body, query, retry: false });
  }

  if (res.ok) {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  let payload = {};
  try {
    payload = JSON.parse(await res.text());
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(res.status, payload?.error?.message || res.statusText, path);
}

export class ApiError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

/* ------------------------------------------------------------------ user */

export const getMe = () => request('/me');

/* -------------------------------------------------------------- playlist */

/** Accepts a share link, a spotify: URI, or a bare 22-char ID. */
export function parsePlaylistId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9]{22}$/.test(raw)) return raw;
  const m = raw.match(/playlist[/:]([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}

export function getPlaylist(id) {
  return request(`/playlists/${id}`, {
    query: { fields: 'id,name,description,images,owner(display_name),tracks(total)', market: 'from_token' },
  });
}

const TRACK_FIELDS =
  'next,items(is_local,track(id,uri,name,duration_ms,is_playable,type,artists(name),album(name,images)))';

/**
 * Fetches every playable track, following pagination.
 * Filters out local files, podcast episodes and region-blocked tracks —
 * all of which would break playback mid-round.
 */
export async function getPlaylistTracks(id, onProgress) {
  const tracks = [];
  let offset = 0;
  let skipped = 0;

  for (;;) {
    const page = await request(`/playlists/${id}/tracks`, {
      query: {
        fields: TRACK_FIELDS,
        limit: 100,
        offset,
        market: 'from_token',
        additional_types: 'track',
      },
    });

    const items = page?.items || [];
    for (const item of items) {
      const t = item?.track;
      if (!t || item.is_local || t.type !== 'track' || !t.id || t.is_playable === false) {
        skipped++;
        continue;
      }
      tracks.push({
        id: t.id,
        uri: t.uri,
        name: t.name,
        durationMs: t.duration_ms,
        artists: (t.artists || []).map((a) => a.name),
        album: t.album?.name || '',
        art: t.album?.images?.[0]?.url || '',
        artSmall: t.album?.images?.at(-1)?.url || '',
      });
    }

    onProgress?.(tracks.length);
    if (!page?.next) break;
    offset += 100;
  }

  return { tracks, skipped };
}

/* ---------------------------------------------------------------- player */

export function transferPlayback(deviceId, play = false) {
  return request('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } });
}

export function startPlayback(deviceId, uri, positionMs = 0) {
  return request('/me/player/play', {
    method: 'PUT',
    query: { device_id: deviceId },
    body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) },
  });
}
