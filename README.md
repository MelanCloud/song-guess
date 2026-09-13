# Song Guess

A locally hosted guess-the-song game for any Spotify playlist. Paste a playlist,
it shuffles the tracks and plays a **0.1 second** snippet. Guess it, or ask for
more time — 0.5s, 1s, then +1s at a time up to 10s. Give up and the song is revealed.

The guess box is a typeahead over the playlist itself, so typing an artist
narrows the field to that artist's songs in the playlist.

---

## Requirements

| | |
|---|---|
| **Spotify Premium** | Required. See [Why Premium](#why-premium-is-required). |
| **Python 3.8+** *or* **Node 20+** | Only to serve the files. No dependencies either way. |
| **A desktop browser** | Chrome, Edge or Firefox. Spotify's player needs Widevine DRM. |

---

## Setup

### 1. Create a Spotify app

Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
and click **Create app**.

- **Name / description**: anything.
- **APIs used**: tick both **Web API** and **Web Playback SDK**.
- **Redirect URI**: exactly this, then press *Add* —

  ```
  http://127.0.0.1:8080/callback
  ```

  > `localhost` will be rejected. Spotify requires the explicit IP literal
  > `127.0.0.1` for loopback redirect URIs. The port and path must match exactly.

Save, then copy the app's **Client ID**.

### 2. Run it

```sh
python server.py        # or:  npm start
```

Open <http://127.0.0.1:8080>, paste the Client ID when asked, and connect.
The Client ID is stored in your browser's `localStorage` — there is no server
side and no secret involved (the app uses OAuth PKCE).

### 3. Playing with other people

A new Spotify app starts in **development mode**, which allows up to **25
users**. Every other player must:

1. have their own Spotify **Premium** account, and
2. be added by you under **Settings → User Management** in the dashboard
   (their Spotify account name and email).

They then browse to your machine's address on the LAN. Note that the redirect
URI is tied to `127.0.0.1:8080`, so the simplest setup is everyone taking a turn
on the host machine; for real LAN play each client needs its own registered
redirect URI and HTTPS, which is out of scope here.

---

## How a round works

1. A snippet plays. The first is **0.1s**.
2. Type a guess — the dropdown lists only songs from this playlist.
3. **More time** unlocks the next length: `0.1 → 0.5 → 1 → 2 → 3 … → 10s`.
4. A wrong guess also unlocks the next length (toggleable before you start,
   otherwise you could brute-force the whole playlist at 0.1s).
5. At 10s there is no more time to ask for: guess, or **Give up** to reveal.

Scoring rewards guessing early — 12 points at 0.1s down to 1 point at 10s,
0 for a give-up.

### Snippet start point

By default the snippet window starts **somewhere inside the song** (a fixed,
per-track position between 15% and 65% in), not at the very beginning. The first
100ms of a track is very often silence or a fade-in, which makes a 0.1s round
meaningless. Switch to **At the very beginning** in the options for Heardle-style
play. The window always grows from the same anchor, so a longer snippet is
always strictly more information.

---

## Known limitations

These are Spotify platform constraints, not bugs in the app.

### Why Premium is required

Spotify **removed 30-second `preview_url` MP3s** from the Web API on
[27 November 2024](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
for newly created apps. That was how games like Heardle played clips without
Premium. The only remaining way to play a full track in a browser is the
**Web Playback SDK**, which refuses to play audio on a free account.

If you sign in with a free account the app tells you so on the spot rather than
failing silently at the first snippet.

### Spotify's own playlists return 404

The same API change blocked **Spotify-owned editorial and algorithmic
playlists** for new apps — Discover Weekly, Release Radar, Today's Top Hits,
Daily Mix and anything else where the owner is Spotify. These return `404`.

Use a playlist created by a person. The app detects this case and explains it
instead of showing a bare 404.

### Snippet timing is close, not sample-exact

`resume()` and `pause()` are asynchronous commands to Spotify's player, so a
naive "play, wait 100ms, pause" overshoots badly and inconsistently.

Instead the app measures what actually played — the SDK reports an exact
playback position — and learns a lag compensation that converges over the first
few plays. A silent calibration pass runs before round one to seed it. The
snippet length actually heard is shown under the play button.

Expect roughly ±30ms at the 0.1s rung on a decent connection. Sample-accurate
trimming is not possible through the SDK; the audio is DRM-protected and cannot
be routed through Web Audio.

### Other notes

- Local files, podcast episodes and region-blocked tracks are filtered out of
  the playlist; the count of skipped tracks is shown when you load it.
- The same song listed twice, or a remaster of it, counts as one answer.

---

## Tests

```sh
npm test          # or:  node --test
```

33 tests covering the ladder, scoring, the round state machine, anchor
selection, text normalisation and the autocomplete ranking, plus a static check
that every element id `main.js` binds to actually exists in `index.html`.

There is no test for live playback — that needs a real Premium session and a
browser.

## Project layout

```
index.html          markup for all five screens
styles.css
server.py           static server, no dependencies
server.js           the same, for Node
js/
  main.js           screen routing, round loop, event wiring
  auth.js           OAuth PKCE: login, token refresh, storage
  api.js            Spotify Web API: playlists, pagination, playback
  player.js         Web Playback SDK + calibrated snippet playback
  game.js           the ladder, shuffle, anchors, scoring
  autocomplete.js   playlist-scoped typeahead
  text.js           shared normalisation for search and answer matching
test/
  logic.test.mjs    game rules, text matching, autocomplete ranking
  dom.test.mjs      markup/script contract
```
