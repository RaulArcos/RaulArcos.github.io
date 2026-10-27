# RaulArcos.github.io

Personal portfolio with an always-visible **Racing Lab**: Cádiz City, Spa-Francorchamps, Noob GP, the Legacy circuit, best-lap ghosts and non-colliding live cars.

## Quick path

1. Run `python -m http.server 8000` from the repository root.
2. Open <http://127.0.0.1:8000/>, scroll to the Racing Lab (or use **Race on this site**), choose a track and press **Start**.
3. To test live cars, open a second tab/browser on the same circuit with another name. Other cars are gold; an unfocused player's car is parked and labeled **PAUSED**.
4. Run `node --test tests/*.test.cjs` for the automated checks.

**Backend:** <https://api.ircopilot.com/racing/api/health> is deployed on the owner's VPS. `racing-config.js` connects to it by default. Website publishing remains manual; these local website edits are not automatically pushed to GitHub Pages.

## What to expect

| Feature | Behavior |
| --- | --- |
| Tracks | Roads are 60/58/78/80 world units wide (Cádiz/Spa/Noob/Legacy). Cádiz has sea; other circuits have grass in previews and gameplay. |
| Difficulty | Noob GP: Easy; Cádiz City: Medium; Spa-Francorchamps: Hard. Geometry, widths and record IDs are unchanged. |
| Phone UI | Full-viewport game, grouped multi-touch controls, collapsible leaderboard, larger targets and safe-area-aware layout. Landscape offers a wider track view. |
| Track previews | Draw before Play, and repair after DOM refreshes. An external HTML template mounts into an empty React-owned slot to avoid ownership conflicts. |
| Live cars | Same-origin tabs use BroadcastChannel; separate browsers/devices use the VPS HTTPS relay. Cars are visual and do not collide. |
| Smooth motion | Other cars render from a 350ms client-side snapshot buffer with bounded jitter prediction; your own controls stay immediate. Server updates remain at the existing rate. |
| Visibility | Occupied starts choose another lane; gold rings and labels keep peers visible even when cars overlap. |
| Activity | Counts mean driving sessions, not unique authenticated people. Zero and unknown counts leave the bubble empty and hidden. Local-only observations say **this browser**. |
| Live boards | Refresh every 5 seconds while activity is known, every 15 seconds when idle/unknown; hidden tabs suspend board polling. In-flight reads are not duplicated. |
| Records | Fresh v3 track IDs keep wider-road scores separate from archived layouts. No invented target times or reference laps. |
| iRacing | Static identity/profile link only; ratings/results are not connected. |

For same-browser tab sharing, use exactly the same origin in both tabs—do not mix `localhost` and `127.0.0.1`. The server relay also supports separate browsers. Both players must press **Start** on the same track. Quit removes a car; stale sessions expire after 15 seconds.

## Files and load order

`index.html` loads `racing-config.js`, `racing-core.js`, `racing-live.js`, `racing-game.js`, then `racing-lab.js`, with versioned URLs. `racing-lab.css` is in the head. The inert `#racing-lab-template` is outside `<x-dc>`; the runtime mounts it at `#racing-lab-slot`.

To disable network play explicitly, set `window.RACING_API_URL = ''` before loading `racing-config.js`. Local driving and same-origin tab sharing remain available.

## Verification and operations

| Command | Purpose |
| --- | --- |
| `node --test tests/*.test.cjs` | Isolated core, game, page, HTTP server and transport regressions; unit tests do not write to the deployed backend. |
| `node scripts/check-racing-browser.cjs --help` | Real Chrome/Edge CDP test setup and options. |
| `node scripts/check-racing-browser.cjs --isolated` | Two separate browser contexts, proving VPS relay rather than local BroadcastChannel. Requires an isolated browser debugging endpoint. |
| `node scripts/check-mobile-browser.cjs --help` | Phone/tablet/desktop EN/ES and touch-check setup; offline racing data, no VPS writes. Run separately from the desktop checker. |
| `node --check racing-lab.js` | Page-script syntax. |

Real desktop Chrome checks cover previews before Play, preview repair, separate spawns, peer movement, rendered names, Quit and React root health. Phone/tablet Chrome emulation passes, including native multi-touch and independent release. Actual iPhone/Safari and Android-device usability still needs manual checking; see [mobile readiness and device checklist](docs/mobile-readiness.md).

See [game details](docs/racing-game.md) and [backend configuration and API](server/README.md). Scores and positions are community submissions, not authoritative or cheat-proof race results.

Smoothing is browser-side: it does not raise the existing 200ms live-position update rate or change the VPS service/limits. More simultaneous racers still add normal server traffic; this is not a maximum-capacity benchmark. Card data refreshes every 5 seconds with known racers, otherwise every 15 seconds; hidden documents do not poll. A newly arriving remote racer is discovered on the next idle presence check.

See [security and hosting boundaries](SECURITY.md) for public-data limits and defensive hosting guidance. Private audit and deployment details are not part of the public source. Weekly play/countdowns are removed from the browser; historical weekly data/API compatibility is retained rather than deleting records.
