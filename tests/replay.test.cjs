'use strict';
// Anti-tamper replay verification: honest laps from the real physics pass; edited speed, time,
// position, direction or sampling fail, both in racing-core.js and through the public API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../racing-core.js');
const { createServer, loadConfig } = require('../server/server.cjs');

const ORIGIN = 'https://raularcos.github.io';
const normAngle = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// Pure-pursuit driver; returns the first completed lap exactly as the browser would submit it.
function honestLap(track, { power = 1, vScale = 1 } = {}) {
  const base = Core.PHYS.MAX_POWER;
  Core.PHYS.MAX_POWER = base * power;
  try {
    const s = Core.createSession({ track }), p = track.points, n = p.length;
    let idx = n - 8;
    for (let k = 0; k < 120 * 120; k++) {
      const c = s.car;
      let best = Infinity, bi = idx;
      for (let d = -3; d <= 6; d++) { const j = (idx + d + n) % n, dd = Math.hypot(p[j][0] - c.x, p[j][1] - c.y); if (dd < best) { best = dd; bi = j; } }
      idx = bi;
      const sp = Math.hypot(c.vx, c.vy), tg = p[(idx + Math.round(3 + sp * 3)) % n];
      const err = normAngle(Math.atan2(tg[0] - c.x, -(tg[1] - c.y)) - c.angle);
      const h1 = Math.atan2(p[(idx + 4) % n][0] - p[idx][0], -(p[(idx + 4) % n][1] - p[idx][1]));
      const h2 = Math.atan2(p[(idx + 12) % n][0] - p[(idx + 8) % n][0], -(p[(idx + 12) % n][1] - p[(idx + 8) % n][1]));
      const vmax = Math.max(0.5, 1.4 - Math.abs(normAngle(h2 - h1)) * 0.6 * 2.6) * vScale;
      const e2 = err - c.angVel * 8;
      const ev = s.step({ up: sp < vmax, down: false, left: e2 < -0.02, right: e2 > 0.02 });
      if (ev && ev.type === 'lap') return Core.sanitizeGhost({ ms: ev.ms, frames: ev.frames }, track);
    }
  } finally { Core.PHYS.MAX_POWER = base; }
  throw new Error('bot did not finish a lap');
}

const laps = new Map(Core.tracks.map(t => [t.id, honestLap(t)]));
const retime = (frames, k) => frames.map(f => [Math.round(f[0] * k), f[1], f[2], f[3]]);

for (const track of Core.tracks) {
  test(`${track.id}: honest laps pass, including wall-scraping driving`, () => {
    const lap = laps.get(track.id);
    assert.equal(Core.verifyLapReplay(track, lap.ms, lap.frames), null);
    const wild = honestLap(track, { vScale: 1.6 });
    assert.equal(Core.verifyLapReplay(track, wild.ms, wild.frames), null);
  });

  test(`${track.id}: speed hacks, time edits, teleports, sparse or reversed replays fail`, () => {
    const lap = laps.get(track.id), f = lap.frames, ms = lap.ms;
    const hacked = honestLap(track, { power: 2, vScale: 2 });
    assert.equal(Core.verifyLapReplay(track, hacked.ms, hacked.frames), 'too_fast');
    const fast = retime(f, 0.8), fastMs = fast[fast.length - 1][0];
    assert.equal(Core.verifyLapReplay(track, fastMs, fast), 'too_fast');
    const mid = f.length >> 1;
    assert.equal(Core.verifyLapReplay(track, ms, f.filter((_, i) => i < mid - 3 || i > mid + 3)), 'sparse_replay');
    const off = f.map((x, i) => (i === mid ? [x[0], Math.min(900, x[1] + track.width), x[2], x[3]] : x));
    assert.ok(['off_track', 'too_fast'].includes(Core.verifyLapReplay(track, ms, off)));
    const reversed = f.slice().reverse().map(x => [ms - x[0], x[1], x[2], x[3]]);
    assert.equal(Core.verifyLapReplay(track, ms, reversed), 'missed_checkpoint');
    const late = f.slice(3).map(x => [x[0] - f[3][0], x[1], x[2], x[3]]);
    assert.equal(Core.verifyLapReplay(track, late[late.length - 1][0], late), 'not_at_line');
    assert.equal(Core.verifyLapReplay(track, track.minLapMs - 1, f), 'too_fast');
  });
}

test('legacy and unknown tracks are never replay-verified as current laps', () => {
  assert.equal(Core.verifyLapReplay(null, 10000, laps.get('noob-gp-v3').frames), 'unknown_track');
  assert.equal(Core.verifyLapReplay({ legacy: true, points: [] }, 10000, []), 'unknown_track');
});

test('API stores an honest lap, rejects a hacked one with 422 and archived tracks with 400', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'racing-replay-'));
  const server = createServer(Object.assign(loadConfig({}), { dataDir, allowedOrigins: [ORIGIN], logger: () => {} }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/api/laps', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const track = Core.trackById('noob-gp-v3'), honest = laps.get(track.id), hacked = honestLap(track, { power: 2, vScale: 2 });
    let r = await post({ trackId: track.id, challengeId: null, name: 'Hacker', ms: hacked.ms, frames: hacked.frames });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: 'implausible_lap', message: 'lap replay rejected: too_fast' });
    r = await post({ trackId: 'noob-gp-v2', challengeId: null, name: 'Old', ms: honest.ms, frames: honest.frames });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_track');
    r = await post({ trackId: track.id, challengeId: null, name: 'Honest', ms: honest.ms, frames: honest.frames });
    assert.deepEqual(await r.json(), { saved: true });
    const board = await (await fetch(base + '/api/leaderboard?track=noob-gp-v3')).json();
    assert.deepEqual(board.entries.map(e => e.name), ['Honest']);
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
