/** App wiring: screens, auth handoff, playlist loading and the round loop. */

import * as auth from './auth.js';
import * as api from './api.js';
import * as sdk from './player.js';
import * as game from './game.js';
import { createAutocomplete } from './autocomplete.js';

const $ = (id) => document.getElementById(id);

const el = {
  screens: [...document.querySelectorAll('.screen')],
  userChip: $('user-chip'),
  logout: $('btn-logout'),

  redirectUri: $('redirect-uri'),
  copyRedirect: $('btn-copy-redirect'),
  formClient: $('form-client'),
  clientId: $('client-id'),

  login: $('btn-login'),
  changeClient: $('btn-change-client'),

  formPlaylist: $('form-playlist'),
  playlistInput: $('playlist-input'),
  plStatus: $('playlist-status'),
  plPreview: $('playlist-preview'),
  plArt: $('pl-art'),
  plName: $('pl-name'),
  plSub: $('pl-sub'),
  options: $('game-options'),
  optRounds: $('opt-rounds'),
  optAnchor: $('opt-anchor'),
  optAdvance: $('opt-advance'),
  start: $('btn-start'),

  roundLabel: $('round-label'),
  scoreLabel: $('score-label'),
  ladder: $('ladder'),
  play: $('btn-play'),
  snippetLen: $('snippet-len'),
  snippetHint: $('snippet-hint'),
  formGuess: $('form-guess'),
  guessInput: $('guess-input'),
  guessList: $('guess-list'),
  guessBtn: $('btn-guess'),
  more: $('btn-more'),
  giveup: $('btn-giveup'),
  guessLog: $('guess-log'),

  reveal: $('reveal'),
  rvArt: $('rv-art'),
  rvVerdict: $('rv-verdict'),
  rvTitle: $('rv-title'),
  rvArtist: $('rv-artist'),
  rvLink: $('rv-link'),
  next: $('btn-next'),

  sumScore: $('sum-score'),
  sumList: $('sum-list'),
  again: $('btn-again'),
  newPlaylist: $('btn-newplaylist'),

  errorText: $('error-text'),
  retry: $('btn-retry'),
  reset: $('btn-reset'),

  loading: $('loading'),
  loadingText: $('loading-text'),
};

const state = {
  tracks: [],
  playlist: null,
  g: null,
  playerReady: false,
  selected: null,
  selectedLabel: '',
  playing: false,
};

let ac;

/* -------------------------------------------------------------- helpers */

function show(id) {
  for (const s of el.screens) s.hidden = s.id !== id;
}

function loading(text) {
  el.loadingText.textContent = text || '';
  el.loading.hidden = !text;
}

function showError(err) {
  console.error(err);
  el.errorText.textContent = err?.message || String(err);
  loading(null);
  show('screen-error');
}

/** 100 -> "0.1s", 1000 -> "1s" */
function fmt(ms) {
  const s = ms / 1000;
  return (s < 1 ? s.toFixed(1) : String(s)) + 's';
}

function setHeader() {
  const on = auth.isLoggedIn();
  el.logout.hidden = !on;
  el.userChip.hidden = !on || !el.userChip.textContent;
}

/* ---------------------------------------------------------------- setup */

el.redirectUri.textContent = auth.REDIRECT_URI;

el.copyRedirect.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(auth.REDIRECT_URI);
    el.copyRedirect.textContent = 'Copied';
    setTimeout(() => { el.copyRedirect.textContent = 'Copy'; }, 1400);
  } catch {
    el.copyRedirect.textContent = 'Copy failed';
  }
});

el.formClient.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = el.clientId.value.trim();
  if (!id) return;
  auth.setClientId(id);
  show('screen-connect');
});

el.login.addEventListener('click', async () => {
  try {
    await auth.beginLogin();
  } catch (err) {
    showError(err);
  }
});

el.changeClient.addEventListener('click', () => {
  el.clientId.value = auth.getClientId();
  show('screen-setup');
});

el.logout.addEventListener('click', () => {
  auth.logout();
  location.reload();
});

el.reset.addEventListener('click', () => {
  auth.logout();
  auth.clearClientId();
  location.reload();
});

el.retry.addEventListener('click', () => {
  show(auth.isLoggedIn() ? 'screen-playlist' : 'screen-connect');
});

/* ------------------------------------------------------------- playlist */

function plStatus(msg, isError = false) {
  el.plStatus.hidden = !msg;
  el.plStatus.textContent = msg || '';
  el.plStatus.classList.toggle('is-error', isError);
}

el.formPlaylist.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = api.parsePlaylistId(el.playlistInput.value);
  if (!id) {
    plStatus('That does not look like a playlist link, URI or ID.', true);
    return;
  }

  el.plPreview.hidden = true;
  el.options.hidden = true;
  plStatus('Loading playlist…');

  try {
    // allSettled, not all: if both calls fail the second rejection would
    // otherwise go unhandled and surface as a console error.
    const [metaRes, tracksRes] = await Promise.allSettled([
      api.getPlaylist(id),
      api.getPlaylistTracks(id, (n) => plStatus(`Loaded ${n} tracks…`)),
    ]);
    if (metaRes.status === 'rejected') throw metaRes.reason;
    if (tracksRes.status === 'rejected') throw tracksRes.reason;
    const meta = metaRes.value;
    const { tracks, skipped } = tracksRes.value;

    if (tracks.length < 2) {
      plStatus('That playlist has fewer than 2 playable tracks.', true);
      return;
    }

    state.playlist = meta;
    state.tracks = tracks;

    el.plArt.src = meta.images?.[0]?.url || '';
    el.plName.textContent = meta.name;
    const owner = meta.owner?.display_name ? ` · by ${meta.owner.display_name}` : '';
    const dropped = skipped ? ` · ${skipped} unplayable skipped` : '';
    el.plSub.textContent = `${tracks.length} playable tracks${owner}${dropped}`;
    el.plPreview.hidden = false;

    el.optRounds.max = String(tracks.length);
    el.optRounds.value = String(Math.min(10, tracks.length));
    el.options.hidden = false;
    plStatus(null);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      plStatus(
        'Spotify returned 404 for that playlist.\n\n' +
        'Editorial and algorithmic playlists owned by Spotify (Discover Weekly, ' +
        'Today’s Top Hits, Release Radar…) are blocked for apps created after ' +
        'November 2024. Try a playlist created by a person, and make sure it is ' +
        'public or owned by you.',
        true,
      );
      return;
    }
    plStatus(err.message, true);
  }
});

/* ------------------------------------------------------------ game loop */

function renderLadder(round) {
  el.ladder.innerHTML = game.LADDER
    .map((ms, i) => {
      const cls = i === round.stage ? 'is-current' : i < round.stage ? 'is-done' : '';
      return `<li class="${cls}">${fmt(ms)}</li>`;
    })
    .join('');
}

function renderRound() {
  const g = state.g;
  const round = g.round;

  el.roundLabel.textContent = `Song ${g.index + 1} of ${g.order.length}`;
  el.scoreLabel.textContent = `Score ${g.score}`;
  renderLadder(round);

  el.snippetLen.textContent = fmt(game.currentDuration(round));
  el.snippetHint.textContent = round.over
    ? 'Round over'
    : 'Press play to hear the snippet';

  el.reveal.hidden = !round.over;
  el.formGuess.hidden = round.over;
  el.play.disabled = round.over || state.playing;
  el.more.disabled = round.over || !game.canExtend(round);
  el.giveup.disabled = round.over;

  el.guessLog.innerHTML = round.guesses
    .map((gs) => `<li class="is-wrong"><span class="mark-x">&times;</span>${escapeHtml(
      `${gs.track.name} — ${gs.track.artists.join(', ')}`)}</li>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clearGuessBox() {
  ac.clear();
  state.selected = null;
  state.selectedLabel = '';
}

async function beginRound(round) {
  clearGuessBox();
  renderRound();
  el.play.disabled = true;
  el.snippetHint.textContent = 'Cueing track…';
  try {
    await sdk.cueTrack(round.track.uri, round.anchor);
    el.snippetHint.textContent = 'Press play to hear the snippet';
  } catch (err) {
    el.snippetHint.textContent = 'Could not cue this track.';
    console.error(err);
  }
  el.play.disabled = round.over;
  el.guessInput.focus();
}

el.play.addEventListener('click', async () => {
  const round = state.g?.round;
  if (!round || round.over || state.playing) return;

  state.playing = true;
  el.play.disabled = true;
  el.play.classList.add('is-playing');

  const target = game.currentDuration(round);
  try {
    await sdk.activate();
    const measured = await sdk.playSnippet(round.anchor, target);
    el.snippetHint.textContent = measured
      ? `Played ${(measured / 1000).toFixed(2)}s`
      : 'Played';
  } catch (err) {
    el.snippetHint.textContent = 'Playback failed — try again.';
    console.error(err);
  } finally {
    state.playing = false;
    el.play.classList.remove('is-playing');
    el.play.disabled = round.over;
  }
});

el.more.addEventListener('click', () => {
  const round = state.g?.round;
  if (!round || round.over || !game.extend(round)) return;
  renderRound();
  el.snippetHint.textContent = `Unlocked ${fmt(game.currentDuration(round))} — press play`;
});

el.formGuess.addEventListener('submit', (e) => {
  e.preventDefault();
  const round = state.g?.round;
  if (!round || round.over) return;

  const typed = el.guessInput.value.trim();
  if (!typed) return;

  // Use the dropdown pick when the box still shows it, otherwise best match.
  const guess = (state.selected && typed === state.selectedLabel)
    ? state.selected
    : ac.resolve(typed);

  if (!guess) {
    el.snippetHint.textContent = 'No song in this playlist matches that — pick one from the list.';
    return;
  }

  const result = game.submitGuess(state.g, guess);
  clearGuessBox();

  if (result.correct) {
    finishRound(true);
    return;
  }

  renderRound();
  el.snippetHint.textContent = result.exhausted
    ? 'Wrong — no more time left. Guess again or give up.'
    : `Wrong — unlocked ${fmt(game.currentDuration(round))}`;
});

el.giveup.addEventListener('click', () => {
  if (!state.g?.round || state.g.round.over) return;
  game.giveUp(state.g);
  finishRound(false);
});

function finishRound(won) {
  const round = state.g.round;
  const t = round.track;

  sdk.stop().catch(() => {});

  el.rvArt.src = t.art || '';
  el.rvVerdict.textContent = won
    ? `Got it in ${fmt(game.LADDER[round.stage])} · +${game.pointsFor(round.stage)}`
    : 'Gave up';
  el.rvVerdict.className = `rv-verdict ${won ? 'win' : 'lose'}`;
  el.rvTitle.textContent = t.name;
  el.rvArtist.textContent = t.artists.join(', ');
  el.rvLink.href = `https://open.spotify.com/track/${t.id}`;

  el.next.textContent = game.hasNextRound(state.g) ? 'Next song' : 'See results';
  renderRound();
}

el.next.addEventListener('click', async () => {
  if (!game.hasNextRound(state.g)) {
    renderSummary();
    return;
  }
  const round = game.nextRound(state.g);
  await beginRound(round);
});

function renderSummary() {
  const g = state.g;
  const won = g.results.filter((r) => r.won).length;
  el.sumScore.textContent = `${g.score} points · ${won}/${g.results.length} correct`;
  el.sumList.innerHTML = g.results
    .map((r) => `
      <li>
        <span>${escapeHtml(`${r.track.name} — ${r.track.artists.join(', ')}`)}</span>
        <span class="${r.won ? 'ok' : 'no'}">${
          r.won ? `${fmt(game.LADDER[r.stage])} · +${r.points}` : 'missed'
        }</span>
      </li>`)
    .join('');
  show('screen-summary');
}

async function startGame() {
  try {
    if (!state.playerReady) {
      loading('Starting the Spotify player…');
      await sdk.initPlayer({ onFatal: showError });
      state.playerReady = true;
    }

    state.g = game.createGame(state.tracks, {
      rounds: Math.max(1, Math.min(Number(el.optRounds.value) || 10, state.tracks.length)),
      anchorMode: el.optAnchor.value,
      wrongGuessAdvances: el.optAdvance.checked,
    });

    ac.setTracks(state.tracks);

    // A silent warm-up so the very first 0.1s round is already well calibrated.
    loading('Calibrating snippet timing…');
    const first = state.g.order[0];
    await sdk.calibrate(first.uri, game.anchorFor(first, state.g.anchorMode));

    loading(null);
    show('screen-game');
    await beginRound(game.startRound(state.g));
  } catch (err) {
    showError(err);
  }
}

el.start.addEventListener('click', startGame);

el.again.addEventListener('click', () => {
  show('screen-game');
  startGame();
});

el.newPlaylist.addEventListener('click', () => {
  sdk.stop().catch(() => {});
  show('screen-playlist');
});

/* ----------------------------------------------------------------- boot */

ac = createAutocomplete({
  input: el.guessInput,
  listbox: el.guessList,
  onSelect: (track) => {
    state.selected = track;
    state.selectedLabel = el.guessInput.value;
  },
});

(async function boot() {
  try {
    if (await auth.handleRedirect()) {
      // fall through to the logged-in path below
    }
  } catch (err) {
    showError(err);
    return;
  }

  setHeader();

  if (!auth.getClientId()) {
    show('screen-setup');
    return;
  }
  if (!auth.isLoggedIn()) {
    show('screen-connect');
    return;
  }

  try {
    const me = await api.getMe();
    el.userChip.textContent = me.display_name || me.id;
    setHeader();
    if (me.product !== 'premium') {
      showError(new Error(
        `This account (${me.display_name || me.id}) is on Spotify ${me.product || 'free'}.\n\n` +
        'Spotify Premium is required: the Web Playback SDK will not play audio otherwise, ' +
        'and 30-second preview URLs were removed from the API in November 2024.'
      ));
      return;
    }
    show('screen-playlist');
  } catch (err) {
    showError(err);
  }
})();
