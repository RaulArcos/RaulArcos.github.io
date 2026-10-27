# Racing Lab frontend

Dependency-free canvas racing with personal ghosts and live peer cars. Static files can stay on GitHub Pages; the default HTTPS backend is `https://api.ircopilot.com/racing`.

## Load order and DOM ownership

Load `racing-config.js`, `racing-core.js`, `racing-live.js`, `racing-game.js`, then `racing-lab.js`. The page uses versioned asset URLs; bump the version when changing the deployed client.

The DC/React template owns an **empty** `#racing-lab-slot`. `#racing-lab-template` is inert markup outside `<x-dc>`. Only `racing-lab.js` owns its cloned section and SVGs. It never modifies the source `<x-dc>` before boot. This prevents React from trying to remove externally replaced children.

Previews render before Play and repair on added or removed elements. The Lab stays visible across language changes and remounts without duplicating timers or listeners. Unknown activity spans are empty and hidden, including in the static template.

## Public game entry

| Call | Result |
| --- | --- |
| `rahOpenRace()` | Photo-origin menu, default Cádiz; expanded if the photo is off-screen. |
| `rahOpenRace(trackId)` | Expanded menu with the requested active track or `legacy`; unknown IDs fall back to Cádiz. |
| `rahOpenRace(trackId, true)` | Deprecated second argument is ignored: opens free play on the requested track, not a weekly mode. |

The Lab is permanently visible. The hero/nav are ordinary scroll anchors; there is no Show/Hide control. No driving keys are captured before Start. Escape/Quit closes the dialog and restores opener focus; Tab is trapped inside the dialog.

## Tracks and timing

| Active ID | Name | Road width |
| --- | --- | --- |
| `cadiz-city-v3` | Cádiz City |60 |
| `spa-francorchamps-v3` | Spa-Francorchamps |58 |
| `noob-gp-v3` | Noob GP |78 |
| `legacy` | Legacy Circuit |80 |

Cádiz is a hand-drawn playable coastline interpretation, not a surveyed map. Sea/land colors and labels identify La Caleta, Genovés, Puerta de Tierra, Playa Victoria and Cortadura. Other tracks have green grass/field stripes, both in previews and gameplay. The Cádiz neck has enough separation for the wider road; Spa/Noob centerlines are preserved.

`RacingLabCore.tracks` exposes ID/name/difficulty/description, a closed point ring without a duplicate endpoint, width, sector indices, bounds, spawn, length, controls and minimum lap time. All coordinates fit a 900×560 world. Tests cover non-crossing geometry, physical road clearance, minimum car-radius curvature, bounds and actual timed multi-lap driving.

New-track sectors must be crossed forward in order. Minimum lap time is at least 5 seconds and scales with track length; supported laps end at 180 seconds. Physics uses 120Hz simulation with interpolated gate crossing. Legacy retains its wall-clock timing rules. Blur/hidden tabs pause driving and release keys; peer cars still render when the paused tab is visible.

Weekly selection, page cards and countdowns are removed. Existing weekly records and archived core/API helpers remain for compatibility; nothing is deleted or mixed into free-play records. Difficulty labels are Noob GP Easy, Cádiz City Medium and Spa Hard; track geometry, widths and IDs are unchanged.

## Scores and ghosts

Local keys use `rah-racing-v4:scores:<track[@week]>` and `rah-racing-v4:ghost:<track[@week]>:<NAME>`. Names are normalized and rendered as text. Only a strictly faster valid lap replaces a best or ghost. Cards show the fastest available real free-play result and label its local/community source.

Ghosts contain `[elapsedMs,x,y,angle]`, sampled at least 80ms apart, capped at 2252 frames—enough for the full supported 180-second lap. Shape, finite values, monotonic times, bounds and first/final timestamps are checked. Angles use canonical zero for stable JSON roundtrips. Corrupt/blocked storage does not stop play.

The ghost is **YOUR BEST (THIS DEVICE)**, not an invented reference lap. Remote ghosts are stored by the API but are not automatically downloaded by the game.

Every width-changing layout has a new ID. Earlier v2/v1/original records are untouched. Legacy uses separate local key `rah-racing-lb-wide-v2` and Firebase path `/rah-lb-wide-v2.json`, leaving older buckets intact. Name/auth cache keys stay unchanged. Firebase rules have not been changed by this implementation.

## Live cars

`racing-live.js` exposes browser `RacingLive` and CommonJS `createLiveClient` for tests. Same-origin tabs discover existing rooms through BroadcastChannel; different browser contexts/devices exchange five-Hz snapshots through the VPS. Remote failures do not stop local play.

States are validated, capped, sequenced and expire after 15 seconds. Gold cars use time-based visual interpolation and do not collide. Parked/paused cars remain visible but are excluded from driving counts. Quit removes the room; stale updates cannot reverse a newer leave. Local observations are labeled **this browser**, not fabricated global counts.

Occupied starts use another lane. Remote discovery is asynchronous: a stable session-ID tie-break can move a stationary, still-overlapping newcomer after the first server snapshot. Moving players are not teleported. Gold outlines and below-car names remain visible if positions overlap anyway.

The API default is configured in `racing-config.js`; an explicit prior `window.RACING_API_URL = ''` disables it. Only HTTPS is accepted, except HTTP localhost for tests. Requests omit credentials, disallow redirects, time out after 6 seconds and cap JSON response size. Score requests and live-car requests have separate server rate limits.

## Verification

```sh
node --test tests/*.test.cjs
node --check racing-core.js
node --check racing-live.js
node --check racing-game.js
node --check racing-lab.js
node scripts/check-racing-browser.cjs --help
```

The browser checker uses native CDP/WebSocket without Playwright. Start an isolated Chrome/Edge with a disposable profile and a localhost remote-debugging port; never attach a human profile. `BROWSER_CDP_URL` selects the endpoint (default 9222); `RACING_PREVIEW_URL` selects the page (default 127.0.0.1:8000). `--isolated` creates separate browser contexts to prove server relay with no cross-context BroadcastChannel; `--screenshot` saves `.atl/racing-browser.png`.

It checks preview presence/repair **before Play**, separate cars, real key-driven movement, actual canvas labels, Quit and both uncaught and caught React errors. Desktop checks have run in real Chrome. Touch-device usability remains a manual check. Native/outside code review has not been claimed.

References: [Cádiz municipal city map](https://turismo.cadiz.es/es/documento/plano-de-la-ciudad-de-c%C3%A1diz-cadiz-city-map-esping), [Spa official map](https://www.spa-francorchamps.be/assets/e70cff50-ae5d-4aaa-896b-54c8a953a357/all-plan-acces.pdf).

## Smooth motion without a faster server tick

`RacingLabCore.createPeerInterpolator()` is a visual-only buffer used by the renderer. It holds at most 12 timestamped snapshots per peer, plays 350ms behind receipt time, and interpolates positions/shortest-angle turns by elapsed time rather than frame count. Your own physics, input response, scores and raw network peer coordinates are unchanged.

The buffer can predict at most 120ms (capped at 200 world units/second) across a brief packet gap, then holds instead of drifting indefinitely. Paused peers settle at their final pose. Duplicate/out-of-order inputs are ignored; large teleports or gaps over 1 second reset the visual history. Buffers are discarded when peers leave or the game closes.

The 200ms publish/poll timer, `racing-live.js`, server code, Docker limits and VPS deployment are unchanged. This adds browser rendering work, not a higher network update frequency. The trade-off is about 350ms of display latency for other cars. Very poor connections can still pause; this does not claim unlimited player capacity.

Tests compare 30Hz/144Hz sampling, continuous motion between 200ms inputs, angle wrap, pause, bounded prediction, stale data, reset and immutable raw inputs. The real Chrome checker also feeds a private synthetic peer at 200ms and measures actual canvas-frame movement; that probe never publishes a fake peer to the VPS. Separate-context checks still prove real HTTPS relay.

## Activity-aware leaderboards

Visible track cards and the open menu/game board refresh every 5 seconds while activity is known, otherwise every 15 seconds. Local observations can immediately activate the fast cadence; remote arrivals are detected on the next idle presence check (up to 15 seconds plus network latency). Zero and unknown activity leave badges empty and hidden, never `0 racing`.

There is no countdown or one-second page timer. Hidden documents suspend leaderboard timers; closing/destroying the UI removes them. Per-scope in-flight guards prevent repeated pending reads. A successful personal-best submission still requests its board immediately. Browser API failures retain the existing local fallback, without inventing activity.

This increases only the requested active leaderboard read frequency; the 200ms live-position cadence and deployed backend are unchanged. A visible page uses one presence read and three track-board reads per cycle; the open game/menu adds its selected board. Multiple viewers and shared-IP rate limits still matter; this is not a load-capacity guarantee.

See [security and hosting boundaries](../SECURITY.md) for public-data limits and generic defensive hosting guidance.

## Phones and tablets

The mobile game is full-viewport and safe-area aware, with grouped steering/throttle/brake targets, a separately toggled leaderboard, a 16px name field and capped high-DPI canvas. Touch pointers are captured independently and released on up/cancel/lost capture or blur. The page scroll lock and listeners are cleaned up on Quit. Desktop keyboard behavior and physics are preserved. See [mobile readiness](mobile-readiness.md) for emulation results and the still-required physical-device checklist.
