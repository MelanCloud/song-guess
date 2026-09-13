/**
 * Typeahead over the loaded playlist.
 *
 * Deliberately scoped to the playlist rather than all of Spotify: the point is
 * to show which songs the answer *could* be, so typing an artist narrows the
 * field to that artist's tracks in this playlist.
 */

import { normalize, stripVariant, tokens, answerKey } from './text.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Wraps token-initial matches in <mark>, on already-escaped text. */
function highlight(text, queryTokens) {
  if (!queryTokens.length) return escapeHtml(text);
  const parts = String(text).split(/(\s+)/);
  return parts
    .map((part) => {
      const norm = normalize(part);
      if (!norm) return escapeHtml(part);
      const hit = queryTokens.find((q) => norm.startsWith(q));
      if (!hit) return escapeHtml(part);
      // Map the normalized prefix length back onto the raw word, approximately.
      const cut = Math.min(part.length, hit.length);
      return `<mark>${escapeHtml(part.slice(0, cut))}</mark>${escapeHtml(part.slice(cut))}`;
    })
    .join('');
}

export function buildIndex(tracks) {
  const seen = new Set();
  const entries = [];
  for (const t of tracks) {
    const key = answerKey(t);
    if (seen.has(key)) continue; // a playlist can list the same song twice
    seen.add(key);

    const title = stripVariant(t.name) || t.name;
    const artistText = t.artists.join(' ');
    entries.push({
      track: t,
      title,
      artistText: t.artists.join(', '),
      normTitle: normalize(title),
      normArtist: normalize(artistText),
      titleTokens: tokens(title),
      artistTokens: tokens(artistText),
    });
  }
  entries.sort((a, b) => a.normTitle.localeCompare(b.normTitle));
  return entries;
}

function scoreEntry(entry, qTokens, qJoined) {
  // Every typed token must match something, or this is not a candidate.
  const all = entry.titleTokens.concat(entry.artistTokens);
  for (const q of qTokens) {
    if (!all.some((tok) => tok.startsWith(q))) return -1;
  }

  let score = 0;
  if (entry.normTitle.startsWith(qJoined)) score += 1000;
  if (entry.normArtist.startsWith(qJoined)) score += 600;
  if (entry.normTitle.includes(qJoined)) score += 120;
  if (entry.titleTokens.some((tok) => qTokens.some((q) => tok.startsWith(q)))) score += 300;
  if (entry.artistTokens.some((tok) => qTokens.some((q) => tok.startsWith(q)))) score += 200;
  score -= Math.min(entry.normTitle.length, 60) / 60; // prefer tighter titles
  return score;
}

export function search(index, query, limit = 8) {
  const qTokens = tokens(query);
  if (!qTokens.length) return [];
  const qJoined = qTokens.join(' ');

  const scored = [];
  for (const entry of index) {
    const score = scoreEntry(entry, qTokens, qJoined);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.normTitle.localeCompare(b.entry.normTitle));
  return scored.slice(0, limit).map((s) => s.entry);
}

export function createAutocomplete({ input, listbox, onSelect, limit = 8 }) {
  let index = [];
  let matches = [];
  let active = -1;
  let open = false;

  function close() {
    open = false;
    active = -1;
    listbox.hidden = true;
    listbox.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function render() {
    if (!matches.length) {
      close();
      return;
    }
    const qTokens = tokens(input.value);
    listbox.innerHTML = matches
      .map((m, i) => `
        <li id="ac-opt-${i}" role="option" class="ac-item${i === active ? ' is-active' : ''}"
            aria-selected="${i === active}" data-i="${i}">
          <span class="ac-title">${highlight(m.title, qTokens)}</span>
          <span class="ac-artist">${highlight(m.artistText, qTokens)}</span>
        </li>`)
      .join('');
    listbox.hidden = false;
    open = true;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `ac-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function move(delta) {
    if (!open || !matches.length) return;
    active = (active + delta + matches.length) % matches.length;
    render();
    listbox.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const entry = matches[i];
    if (!entry) return;
    input.value = `${entry.title} — ${entry.artistText}`;
    close();
    onSelect?.(entry.track);
  }

  input.addEventListener('input', () => {
    matches = search(index, input.value, limit);
    active = matches.length ? 0 : -1;
    render();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); close(); } }
    else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); choose(active); }
    }
  });

  listbox.addEventListener('mousedown', (e) => {
    // mousedown, not click: fires before the input's blur.
    const li = e.target.closest('.ac-item');
    if (!li) return;
    e.preventDefault();
    choose(Number(li.dataset.i));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => {
    if (input.value.trim()) {
      matches = search(index, input.value, limit);
      active = matches.length ? 0 : -1;
      render();
    }
  });

  return {
    setTracks(tracks) { index = buildIndex(tracks); close(); },
    /** Best single match, used when the player types and hits Enter blind. */
    resolve(text) { return search(index, text, 1)[0]?.track || null; },
    clear() { input.value = ''; matches = []; close(); },
    close,
  };
}
