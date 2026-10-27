# Racing Lab backend

A dependency-free Node service for shared best laps, stored ghosts, activity counts and non-colliding live car positions. The website endpoint is configured separately in `racing-config.js`; the game still works locally if the service is unavailable or explicitly disabled.

**Community data is unverified.** Origin guards, validation and rate limits are not authentication or cheat-proof race verification. Clients can craft positions/laps; peer cars never affect another player's physics.

## Quick path

```sh
curl http://127.0.0.1:8787/api/health
node --test tests/server.test.cjs tests/presence.test.cjs tests/racing-live.test.cjs
node server/server.cjs --help
```

For an isolated local service:

```sh
RACING_ALLOWED_ORIGINS=http://127.0.0.1:8000 node server/server.cjs
```

Keep test data outside any static web root. Unit tests use temporary directories and loopback ports, not production records. `require('./server.cjs')` exports `createServer`, `loadConfig`, `weeklyChallenge`, `parseChallengeId` and `TRACK_IDS` without listening.

## Hosting guidance

Static hosting publishes the browser files only; this Node service needs separate hosting. Place persistent data outside any static web root. For containers, use a non-root identity, read-only application/root filesystem, dedicated data volume, resource limits and a private application network. Expose only an HTTPS reverse proxy, not the API or administration ports directly.

Configure the reverse proxy to strip any public path prefix before forwarding to the API. Trust only the exact proxy peer addresses that actually provide forwarded client identities. Keep application networks separate and preserve verified administrative access during changes. Do not restart unrelated applications as part of a racing update.

The public source does not include a host-specific deployment/upgrade command. Prepare environment-specific backups, health checks and rollback procedures before deployment. See [security and hosting boundaries](../SECURITY.md).

## Configuration

| Variable | Local default | Meaning |
| --- | --- | --- |
| `RACING_HOST` | `127.0.0.1` | Loopback by default. Use `0.0.0.0` only where an isolated hosting network requires it. |
| `RACING_PORT` | `8787` | `0` selects an ephemeral test port. |
| `RACING_DATA_DIR` | `~/.racing-lab-data` | Persistent directory outside static hosting; never supplied by requests. |
| `RACING_ALLOWED_ORIGINS` | empty | Bare HTTP(S) origins; no wildcard. Empty refuses every POST. Set only the origins that should submit community data. |
| `RACING_TRUSTED_PROXIES` | empty | Exact proxy peer IPs allowed to supply `X-Forwarded-For`; rightmost untrusted hop is used. |
| `RACING_MAX_BODY_BYTES` | `409600` | Score payload cap; live-car payloads have a stricter 4096-byte cap. |
| `RACING_MAX_RECORDS` | `1000` | Durable driver-record cap. |
| `RACING_WRITE_RATE_LIMIT` | `20` | Score POST budget per IP/window. |
| `RACING_READ_RATE_LIMIT` | `240` | Ordinary GET budget per IP/window. |
| `RACING_RATE_WINDOW_MS` | `60000` | Fixed-window duration. |

The API needs no account credentials to operate. Never copy private keys or other credentials into its source or data folder.

## API

A public base may include a prefix such as `/racing`; configure the proxy to strip it. Internally the routes below start with `/api`.
Responses are JSON with `Cache-Control: no-store`. Errors contain `{error,message}` without stack traces.
POST requires an allowed `Origin` and `Content-Type: application/json`. CORS headers are returned only for allowed origins. These guards block other websites acting through a browser, not scripts that forge an Origin.

| Route | Contract |
| --- | --- |
| `GET /api/health` | `{ok:true,verified:false}` |
| `GET /api/leaderboard?track=<id>&challenge=<optional Monday>` | `{entries:[{name,ms}],verified:false}`, top 50 fastest records |
| `POST /api/laps` | `{trackId,challengeId:null|string,name,ms,frames:[[elapsedMs,x,y,angle],...]}` → `{saved:boolean}` |
| `GET /api/ghost?track=<id>&name=<name>&challenge=<optional>` | `{ms,frames}` or 404 |
| `GET /api/presence` | `{counts:{trackId:number,...}}`; counts sessions currently driving |
| `POST /api/presence` | Legacy heartbeat `{sessionId,trackId,active,sequence}` → `{ok:true}` |
| `GET /api/racers?track=<id>` | `{racers:[...]}`, at most50 visible/parked peers; no IP data |
| `POST /api/racers` | `{sessionId,sequence,trackId,name,x,y,angle,driving,leaving?}` → `{ok:true}` |

### Scores and archived layouts

Active rotation: `cadiz-city-v3`, `spa-francorchamps-v3`, `noob-gp-v3`. Previous v2/v1/original rotations remain readable in their own namespaces; only the current layout can submit to the current weekly challenge. Free play is separate. No record migration or deletion is caused by a layout change.

Names contain letters/numbers first, then letters/numbers/spaces/`._-`, up to24 characters for scores. Identity is case-insensitive. Lap times are finite 5000–180000ms; there are 2–4000 finite samples, first at 0, final within 1 ms of the lap time, monotonic timestamps and 900×560 world bounds. A slower or rejected lap does not write.

Data is one atomic file per driver/track/challenge (`temp`, fsync, rename) and a synchronous single-process index. Do not run multiple writers on the same directory. When the record cap is reached, expired weekly records may be pruned; otherwise new drivers receive 503 while existing records can still improve. Corrupt records are skipped.

Legacy lap scores remain Firebase-backed in `/rah-lb-wide-v2`; earlier Firebase/local buckets are untouched. Legacy cars can still use the live relay.

### Live positions and limits

Live sessions use random 32-character lowercase hex IDs and increasing positive safe-integer sequences. Position, finite angle (±π), boolean state, name (up to 20 characters) and track are validated. State expires after 15 seconds. Leave tombstones prevent stale updates undoing a leave. The map is memory-only and capped at 2000 entries; restart clears positions, not scores.

The browser sends snapshots at five Hz, including parked heartbeats. Live reads/writes each have a separate 1200/minute/IP budget. Old activity-only heartbeats use 120/minute and 45-second expiry. This does not consume score-submission budgets. Rate-limit identity ignores forwarded IPs unless the immediate peer is explicitly trusted.

## Checks and limitations

Real independent HTTP clients exercise validation, persistence, concurrent bests, activity expiry and position relay. Real Chrome with `--isolated` browser contexts exercises the public HTTPS relay without BroadcastChannel. Production health checks, existing-route preservation and source identity must be verified separately for each deployment.

Desktop Chrome rendering, preview repair, movement, visible peer labels and Quit have been checked. Touch usability and an independent outside code review remain separate from these functional checks. The service is single-process and community/unverified; rate-limit state resets after restart.
