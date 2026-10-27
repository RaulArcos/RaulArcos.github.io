'use strict';
// Racing Lab core: tracks, weekly challenge, session timing, ghosts, persistence, API client, config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const Core = require(path.join(ROOT, 'racing-core.js'));
const DAY = 86400000;

// ── helpers ────────────────────────────────────────────────────────────────
function fakeStorage(opts = {}) {
  const m = new Map();
  return {
    m,
    getItem(k) { if (opts.failGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (opts.failSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}
const res200 = body => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
const normAngle = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// Pure-pursuit driver over the public session API (plays the track the way a person would).
function drive(track, opts = {}) {
  const s = Core.createSession({ track }), p = track.points, n = p.length;
  const maxSteps = opts.maxSteps || 120 * 80, vScale = opts.vScale || 1;
  let idx = n - 8;
  const events = [];
  for (let k = 0; k < maxSteps && events.filter(e => e.type === 'lap').length < (opts.laps || 1); k++) {
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
    if (ev) events.push(ev);
  }
  return { events, session: s };
}
// Moves the car (teleport) and gives it a velocity; used to script exact gate crossings.
function place(s, x, y, vx = 0, vy = 0) { Object.assign(s.car, { x, y, vx, vy, power: 0, reverse: 0, angVel: 0 }); }

// ── tracks ─────────────────────────────────────────────────────────────────
test('exposes the three agreed tracks with the L7 fields', () => {
  assert.deepEqual(Core.tracks.map(t => t.id), ['cadiz-city-v3', 'spa-francorchamps-v3', 'noob-gp-v3']);
  for (const t of Core.tracks) {
    assert.equal(typeof t.name, 'string'); assert.ok(t.name.length > 0);
    assert.ok(['Easy', 'Medium', 'Hard'].includes(t.difficulty));
    assert.ok(t.description.length > 20);
    assert.ok(Array.isArray(t.points) && t.points.length >= 60);
    assert.ok(t.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
    assert.ok(t.width >= 40 && t.width <= 85);
    assert.ok(Array.isArray(t.sectors) && t.sectors.length === 3);
  }
  assert.equal(Core.trackById('noob-gp-v3').name, 'Noob GP');
  assert.equal(Core.trackById('legacy'), null);
});

for (const track of Core.tracks) {
  test(`${track.id}: smooth, non-self-crossing, inside the 900x560 world`, () => {
    const a = Core.analyzeTrack(track), pts = track.points, n = pts.length;
    assert.equal(a.selfIntersections, 0);
    assert.ok(a.minClearance >= track.width, `clearance ${a.minClearance}`);
    assert.ok(a.minRadius >= Core.CAR_R * 2, `radius ${a.minRadius}`);
    assert.ok(a.maxSegTurn < 0.9, `max turn per segment ${a.maxSegTurn}`);
    // evenly spaced samples, ring closed without a repeated first point
    const seg = pts.map((p, i) => Math.hypot(pts[(i + 1) % n][0] - p[0], pts[(i + 1) % n][1] - p[1]));
    assert.ok(Math.max(...seg) / Math.min(...seg) < 1.15);
    assert.notDeepEqual(pts[0], pts[n - 1]);
    // the road (centerline ± half width) and the view bounds stay inside the world
    const r = track.width / 2, b = track.bounds;
    assert.ok(a.minX - r >= 0 && a.minY - r >= 0 && a.maxX + r <= Core.WORLD.width && a.maxY + r <= Core.WORLD.height);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= Core.WORLD.width && b.y + b.h <= Core.WORLD.height);
    assert.ok(b.x <= a.minX - r && b.y <= a.minY - r && b.x + b.w >= a.maxX + r && b.y + b.h >= a.maxY + r);
    assert.ok(Math.abs(track.length - a.length) < 1);
  });

  test(`${track.id}: gates, spawn and minimum lap time are sane`, () => {
    const pts = track.points, n = pts.length;
    const idx = [0, ...track.sectors];
    assert.deepEqual([...track.sectors].sort((x, y) => x - y), track.sectors);
    assert.equal(new Set(idx).size, 4);
    assert.ok(track.sectors.every(i => i >= 4 && i <= n - 10));
    for (const i of idx) {
      const g = Core.makeGate(pts, i, track.width);
      // a move along the track through the point crosses the gate forwards, exactly once
      const fwd = Core.gateCrossing(pts[i][0] - g.dirX * 4, pts[i][1] - g.dirY * 4, pts[i][0] + g.dirX * 4, pts[i][1] + g.dirY * 4, g);
      assert.ok(fwd && fwd.forward);
      const back = Core.gateCrossing(pts[i][0] + g.dirX * 4, pts[i][1] + g.dirY * 4, pts[i][0] - g.dirX * 4, pts[i][1] - g.dirY * 4, g);
      assert.ok(back && !back.forward);
      // no other part of the circuit touches this gate
      for (let j = 0; j < n; j++) {
        if (Math.min((j - i + n) % n, (i - j + n) % n) <= 1) continue;
        assert.ok(!Core.segsIntersect(g.x1, g.y1, g.x2, g.y2, pts[j][0], pts[j][1], pts[(j + 1) % n][0], pts[(j + 1) % n][1]), `gate ${i} hits segment ${j}`);
      }
    }
    // spawn: on the road, facing along it, behind the line on a straight with run-up
    const sp = track.spawn, near = Core.nearestOnRing(pts, sp.x, sp.y);
    assert.ok(near.dist < 1);
    const ahead = pts[(n - 7) % n], want = Math.atan2(ahead[0] - sp.x, -(ahead[1] - sp.y));
    assert.ok(Math.abs(normAngle(sp.angle - want)) < 0.15);
    assert.ok(Math.hypot(sp.x - pts[0][0], sp.y - pts[0][1]) > 100);
    assert.ok(track.minLapMs >= 5000);
    assert.ok(Math.abs(track.minLapMs - track.length / Core.TOP_SPEED_PPS * 700) < 5);
  });

  test(`${track.id}: a driver completes timed, recordable laps`, () => {
    const { events, session } = drive(track, { laps: 2, maxSteps: 120 * 120 });
    assert.equal(events[0].type, 'start');
    const laps = events.filter(e => e.type === 'lap');
    assert.equal(laps.length, 2, JSON.stringify(events.map(e => e.type + (e.reason || ''))));
    assert.deepEqual(events.filter(e => e.type === 'invalid'), []);
    for (const lap of laps) {
      assert.ok(lap.ms >= track.minLapMs && lap.ms < 80000, `lap ${lap.ms}`);
      assert.equal(Number.isInteger(lap.ms), true);
      const g = Core.sanitizeGhost({ ms: lap.ms, frames: lap.frames }, track);
      assert.ok(g, 'recorded frames are a valid ghost');
      assert.ok(lap.frames.length <= Core.MAX_FRAMES);
      for (let i = 1; i < lap.frames.length - 1; i++) assert.ok(lap.frames[i][0] - lap.frames[i - 1][0] >= Core.FRAME_INTERVAL_MS - 1);
    }
    assert.equal(session.lapCount, 2);
    // deterministic: same inputs → same times and frames
    const again = drive(track, { laps: 2, maxSteps: 120 * 120 });
    assert.deepEqual(again.events.filter(e => e.type === 'lap').map(e => [e.ms, e.frames]), laps.map(e => [e.ms, e.frames]));
  });
}

// ── slow laps: every supported lap length keeps its ghost (B1) ───────────────
const SERVER_MAX_FRAMES = 4000;   // server/server.cjs LIMITS.maxFrames

test('the frame cap covers every supported lap length and stays within the server limit', () => {
  assert.equal(Core.MAX_LAP_MS, 180000);
  assert.ok(Core.MAX_FRAMES >= Math.ceil(Core.MAX_LAP_MS / Core.FRAME_INTERVAL_MS) + 2, `MAX_FRAMES ${Core.MAX_FRAMES}`);
  assert.ok(Core.MAX_FRAMES <= SERVER_MAX_FRAMES);
});

for (const [label, vScale, lo, hi] of [['about 100 s', 0.25, 92000, 107000], ['about 174 s', 0.14, 170000, 180000]]) {
  test(`a real slow valid lap (${label}, generated by driving) keeps a complete ghost, score and API submission`, async () => {
    const track = Core.tracks[2];
    const lap = drive(track, { vScale, maxSteps: 120 * 200 }).events.find(e => e.type === 'lap');
    assert.ok(lap, 'the slow driver completed a lap');
    assert.ok(lap.ms >= lo && lap.ms <= hi, `lap ${lap.ms}`);
    assert.ok(lap.frames, `a ${lap.ms} ms lap must still record its frames`);
    assert.equal(lap.frames[0][0], 0);
    assert.equal(lap.frames[lap.frames.length - 1][0], lap.ms);
    assert.ok(lap.frames.length > 1000 && lap.frames.length <= Core.MAX_FRAMES, `frames ${lap.frames.length}`);
    for (let i = 1; i < lap.frames.length - 1; i++) assert.ok(lap.frames[i][0] - lap.frames[i - 1][0] >= Core.FRAME_INTERVAL_MS - 1);
    assert.deepEqual(Core.sanitizeGhost({ ms: lap.ms, frames: lap.frames }, track), { ms: lap.ms, frames: lap.frames });
    // device: score and ghost are both stored
    const st = fakeStorage();
    const res = Core.recordLap(st, { trackId: track.id, challengeId: null, name: 'Ana', ms: lap.ms, frames: lap.frames });
    assert.deepEqual([res.score.improved, res.ghost.improved, res.ghost.persisted], [true, true, true]);
    assert.equal(Core.loadGhost(st, track.id, null, 'Ana').frames.length, lap.frames.length);
    // API: the very same frames are posted, inside the server's size limits
    const calls = [];
    const api = Core.createApi('https://api.test', { fetch: async (url, init) => { calls.push([url, init]); return res200({ saved: true }); } });
    assert.equal(await api.submit({ trackId: track.id, challengeId: null, name: 'Ana', ms: lap.ms, frames: lap.frames }), 'saved');
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body.frames, lap.frames);
    assert.ok(body.frames.length <= SERVER_MAX_FRAMES);
    assert.ok(Buffer.byteLength(calls[0][1].body) < 400 * 1024, 'fits the default server body limit');
  });
}

test('a real lap just over MAX_LAP_MS is not a supported lap: no score, no ghost, nothing sent', async () => {
  const track = Core.tracks[2];
  const lap = drive(track, { vScale: 0.135, maxSteps: 120 * 220 }).events.find(e => e.type === 'lap');
  assert.ok(lap && lap.ms > Core.MAX_LAP_MS && lap.ms < Core.MAX_LAP_MS + 10000, `lap ${lap && lap.ms}`);
  assert.ok(lap.frames.length <= Core.MAX_FRAMES);                         // still bounded
  assert.equal(Core.sanitizeGhost({ ms: lap.ms, frames: lap.frames }, track), null);
  const st = fakeStorage();
  const res = Core.recordLap(st, { trackId: track.id, challengeId: null, name: 'Ana', ms: lap.ms, frames: lap.frames });
  assert.deepEqual([res.score.improved, res.ghost.improved], [false, false]);
  const calls = [];
  const api = Core.createApi('https://api.test', { fetch: async (...a) => { calls.push(a); return res200({ saved: true }); } });
  assert.equal(await api.submit({ trackId: track.id, challengeId: null, name: 'Ana', ms: lap.ms, frames: lap.frames }), 'skipped');
  assert.equal(calls.length, 0);
});

test('recorder at the densest sampling covers a lap of exactly MAX_LAP_MS (first frame 0, last frame = lap time)', () => {
  const track = Core.tracks[1], n = track.points.length, r = Core.createRecorder();
  // Capacity test only: positions walk the real centerline; the frame timing is the densest the recorder allows.
  const at = i => track.points[i % n];
  r.begin(at(0)[0], at(0)[1], 0);
  let i = 0;
  for (let t = Core.FRAME_INTERVAL_MS; t < Core.MAX_LAP_MS; t += Core.FRAME_INTERVAL_MS) { i++; r.sample(t, at(i)[0], at(i)[1], 0.5); }
  assert.equal(r.overflowed, false);
  const f = r.finish(Core.MAX_LAP_MS, at(i + 1)[0], at(i + 1)[1], 0.5);
  assert.ok(f, 'a lap of exactly MAX_LAP_MS records');
  assert.equal(f[0][0], 0);
  assert.equal(f[f.length - 1][0], Core.MAX_LAP_MS);
  assert.ok(f.length <= Core.MAX_FRAMES && f.length >= Core.MAX_LAP_MS / Core.FRAME_INTERVAL_MS);
  assert.deepEqual(Core.sanitizeGhost({ ms: Core.MAX_LAP_MS, frames: f }, track).ms, Core.MAX_LAP_MS);
  // same at the session's own 120 Hz cadence
  const r2 = Core.createRecorder(); r2.begin(at(0)[0], at(0)[1], 0);
  for (let k = 1; k * Core.STEP_MS < Core.MAX_LAP_MS; k++) r2.sample(k * Core.STEP_MS, at(k)[0], at(k)[1], 0);
  const f2 = r2.finish(Core.MAX_LAP_MS, at(0)[0], at(0)[1], 0);
  assert.ok(f2 && f2.length <= Core.MAX_FRAMES && f2[f2.length - 1][0] === Core.MAX_LAP_MS);
  // beyond the supported length the recorder stays bounded and gives up
  const r3 = Core.createRecorder(); r3.begin(1, 1, 0);
  for (let t = Core.FRAME_INTERVAL_MS; t < 3 * Core.MAX_LAP_MS; t += Core.FRAME_INTERVAL_MS) r3.sample(t, 1, 1, 0);
  assert.ok(r3.length <= Core.MAX_FRAMES);
  assert.equal(r3.finish(3 * Core.MAX_LAP_MS, 1, 1, 0), null);
});

// ── weekly challenge ───────────────────────────────────────────────────────
test('weeklyChallenge: UTC Monday boundaries', () => {
  const wk = d => Core.weeklyChallenge(d);
  assert.equal(wk('2026-10-19T00:00:00.000Z').id, '2026-10-19');          // Monday 00:00 starts the week
  assert.equal(wk('2026-10-18T23:59:59.999Z').id, '2026-10-12');          // the ms before is still last week
  assert.equal(wk('2026-10-25T23:59:59.999Z').id, '2026-10-19');          // Sunday night
  assert.equal(wk('2026-10-26T00:00:00.000Z').id, '2026-10-26');
  for (let d = 0; d < 7; d++) assert.equal(wk(Date.UTC(2026, 9, 19 + d, 13, 5)).id, '2026-10-19');
  const c = wk(new Date('2026-10-22T10:00:00Z'));
  assert.equal(c.startsAt, '2026-10-19T00:00:00.000Z');
  assert.equal(c.endsAt, '2026-10-26T00:00:00.000Z');
  assert.equal(c.endsAtMs - c.startsAtMs, 7 * DAY);
  assert.deepEqual(Object.keys(c).slice(0, 4), ['id', 'trackId', 'startsAt', 'endsAt']);
});

test('weeklyChallenge: year, leap-day and timezone-offset boundaries', () => {
  assert.equal(Core.weeklyChallenge('2026-12-31T23:59:59Z').id, '2026-12-28');
  assert.equal(Core.weeklyChallenge('2027-01-01T00:00:00Z').id, '2026-12-28');   // new year, same UTC week
  assert.equal(Core.weeklyChallenge('2027-01-03T23:59:59Z').id, '2026-12-28');
  assert.equal(Core.weeklyChallenge('2027-01-04T00:00:00Z').id, '2027-01-04');
  assert.equal(Core.weeklyChallenge('2024-02-29T12:00:00Z').id, '2024-02-26');   // leap day (Thursday)
  assert.equal(Core.weeklyChallenge('2024-03-04T00:00:00Z').id, '2024-03-04');
  assert.equal(Core.weeklyChallenge('2021-01-01T00:00:00Z').id, '2020-12-28');
  // Sunday 23:30 UTC is still last week even though it is already Monday in UTC+2
  assert.equal(Core.weeklyChallenge('2026-10-26T01:30:00+02:00').id, '2026-10-19');
  assert.equal(Core.weeklyChallenge('2026-10-25T23:30:00-05:00').id, '2026-10-26');
  assert.equal(Core.weeklyChallenge(undefined).id, Core.weeklyChallenge(Date.now()).id);
});

test('weeklyChallenge: track rotation is deterministic and matches the API contract', () => {
  const ids = Core.TRACK_IDS;
  const at = (y, m, d) => Core.weeklyChallenge(Date.UTC(y, m - 1, d));
  assert.equal(at(2026, 1, 5).trackId, ids[0]);
  assert.equal(at(2026, 1, 12).trackId, ids[1]);
  assert.equal(at(2026, 1, 19).trackId, ids[2]);
  assert.equal(at(2026, 1, 26).trackId, ids[0]);
  assert.equal(at(2025, 12, 29).trackId, ids[2]);          // weeks before the origin wrap backwards
  assert.equal(at(2026, 10, 19).trackId, ids[((41 % 3) + 3) % 3]);
  assert.equal(at(2026, 10, 22).trackId, at(2026, 10, 19).trackId);
  const seen = new Set(); for (let w = 0; w < 6; w++) seen.add(at(2026, 3, 2 + 7 * w).trackId);
  assert.equal(seen.size, 3);
});

test('weeklyChallenge: invalid input throws, ids validate', () => {
  assert.throws(() => Core.weeklyChallenge('not a date'), RangeError);
  assert.throws(() => Core.weeklyChallenge(NaN), RangeError);
  assert.throws(() => Core.weeklyChallenge({}), RangeError);
  assert.equal(Core.isChallengeId('2026-10-19'), true);
  assert.equal(Core.isChallengeId('2026-10-20'), false);      // not a Monday
  assert.equal(Core.isChallengeId('2026-02-30'), false);
  assert.equal(Core.isChallengeId('../etc'), false);
  assert.equal(Core.isChallengeId(null), false);
});

// ── names ──────────────────────────────────────────────────────────────────
test('cleanName: text-only, bounded, no control or bidi characters', () => {
  assert.equal(Core.cleanName('  Raul  Arcos '), 'Raul Arcos');
  const html = Core.cleanName('<img src=x onerror=alert(1)>');
  assert.ok(!/[<>=()]/.test(html));
  assert.equal(Core.cleanName('A\u0000B\u202eC\u200bD\n'), 'ABCD');
  assert.equal(Core.cleanName('__proto__'), 'proto__');
  assert.equal(Core.cleanName('x'.repeat(50)).length, 20);
  assert.equal(Array.from(Core.cleanName('😀😀😀😀ABC')).length <= 20, true);
  assert.equal(Core.cleanName(42), '');
  assert.equal(Core.cleanName('   '), '');
  assert.equal(Core.nameKey('raul'), 'RAUL');
});

// ── recorder and ghost playback ────────────────────────────────────────────
test('recorder samples at bounded intervals and ends exactly on the lap time', () => {
  const r = Core.createRecorder();
  r.begin(10, 20, 0);
  for (let t = 1; t <= 1000; t++) r.sample(t, 10 + t, 20, 0.5);        // 1 ms ticks
  const f = r.finish(1000, 1010.04, 20, 0.5);
  assert.equal(f[0][0], 0);
  assert.equal(f[f.length - 1][0], 1000);
  assert.ok(f.length <= 1000 / Core.FRAME_INTERVAL_MS + 3);
  for (let i = 1; i < f.length; i++) assert.ok(f[i][0] > f[i - 1][0]);
  assert.deepEqual(f[f.length - 1], [1000, 1010, 20, 0.5]);
});

test('recorder never stores more than MAX_FRAMES and drops overlong laps', () => {
  const r = Core.createRecorder();
  r.begin(0, 0, 0);
  for (let i = 1; i < 5000; i++) r.sample(i * Core.FRAME_INTERVAL_MS, i % 800, 5, 0);
  assert.ok(r.length <= Core.MAX_FRAMES);
  assert.ok(r.overflowed);
  assert.equal(r.finish(5000 * Core.FRAME_INTERVAL_MS, 1, 1, 0), null);
  r.begin(0, 0, 0);                                                     // a fresh lap records again
  assert.equal(r.overflowed, false);
  assert.equal(r.finish(8000, 3, 3, 0).length, 2);
});

test('ghostAt interpolates position and takes the short way round the angle', () => {
  const frames = [[0, 0, 0, 3.0], [1000, 100, 50, -3.0], [2000, 100, 150, -3.0]];
  const mid = Core.ghostAt(frames, 500);
  assert.ok(Math.abs(mid.x - 50) < 1e-9 && Math.abs(mid.y - 25) < 1e-9);
  assert.ok(Math.abs(Math.abs(mid.angle) - Math.PI) < 0.2);              // 3.0 → -3.0 passes through π, not 0
  assert.deepEqual(Core.ghostAt(frames, -10), { x: 0, y: 0, angle: 3 });
  assert.deepEqual(Core.ghostAt(frames, 2000), { x: 100, y: 150, angle: -3 });
  assert.deepEqual(Core.ghostAt(frames, 99999), { x: 100, y: 150, angle: -3 });
  assert.equal(Core.ghostAt(frames, 1500).y, 100);
  assert.equal(Core.ghostAt([], 5), null);
  assert.equal(Core.ghostAt(null, 5), null);
});

test('ghost replay matches the recorded lap at the same lap time', () => {
  const track = Core.tracks[0];
  const { events } = drive(track, { laps: 1 });
  const lap = events.find(e => e.type === 'lap');
  const pos = Core.ghostAt(lap.frames, lap.ms / 2);
  const mid = lap.frames.find(f => f[0] >= lap.ms / 2 - 80);
  assert.ok(Math.hypot(pos.x - mid[1], pos.y - mid[2]) < 40);
  const end = Core.ghostAt(lap.frames, lap.ms);
  const fin = Core.makeGate(track.points, 0, track.width);
  assert.ok(Math.hypot(end.x - track.points[0][0], end.y - track.points[0][1]) < track.width / 2);
  assert.ok(Math.abs((end.x - track.points[0][0]) * fin.dirX + (end.y - track.points[0][1]) * fin.dirY) < 4);
});

// ── session timing and lap validity ────────────────────────────────────────
function startedSession(track) {
  const s = Core.createSession({ track }), g = s.finishGate, p0 = track.points[0];
  place(s, p0[0] - g.dirX * 1.0, p0[1] - g.dirY * 1.0, g.dirX * 3, g.dirY * 3);    // crosses the line this step
  const ev = s.step({});
  assert.equal(ev.type, 'start');
  return s;
}

test('lap time uses the sub-step crossing instant, not the step grid', () => {
  const track = Core.tracks[1], p0 = track.points[0];
  const s = startedSession(track), g = s.finishGate;
  const t1 = s.lapStart;
  s.nextSector = s.gates.length;                                          // pretend all sectors were taken
  for (let i = 0; i < 1500; i++) s.step({});                              // ~12.5 s of idle simulation
  place(s, p0[0] - g.dirX * 0.5, p0[1] - g.dirY * 0.5, g.dirX * 3, g.dirY * 3);
  s.car.angle = s.track.spawn.angle;
  const before = s.simMs, ev = s.step({});
  assert.equal(ev.type, 'lap');
  const t2 = s.lapStart;
  assert.ok(Math.abs((t2 - t1) - ev.ms) <= 0.5);
  assert.ok(t2 > before && t2 < before + Core.STEP_MS + 1e-9);            // inside the step it happened in
  assert.ok(ev.ms > 12000 && ev.ms < 13000);
  assert.ok(ev.ms === Math.round(t2 - t1));
});

test('shortcut (missing sectors) and too-fast laps are invalid and restart timing', () => {
  const track = Core.tracks[0], p0 = track.points[0];
  const s = startedSession(track), g = s.finishGate;
  for (let i = 0; i < 1500; i++) s.step({});
  place(s, p0[0] - g.dirX * 0.5, p0[1] - g.dirY * 0.5, g.dirX * 3, g.dirY * 3);
  const ev = s.step({});
  assert.deepEqual([ev.type, ev.reason], ['invalid', 'shortcut']);
  assert.equal(s.lapCount, 0);
  assert.ok(s.elapsed() < Core.STEP_MS);                                   // timing restarted on the line
  s.nextSector = s.gates.length;                                          // all sectors but far too fast
  for (let i = 0; i < 100; i++) s.step({});
  place(s, p0[0] - g.dirX * 0.5, p0[1] - g.dirY * 0.5, g.dirX * 3, g.dirY * 3);
  const ev2 = s.step({});
  assert.deepEqual([ev2.type, ev2.reason], ['invalid', 'slow']);
  assert.equal(s.lapCount, 0);
});

test('sector gates must be taken in order, forwards only', () => {
  const track = Core.tracks[2], pts = track.points;
  const s = startedSession(track);
  const cross = (i, back) => {
    const g = s.gates[i], c = pts[track.sectors[i]], d = back ? -1 : 1;
    place(s, c[0] - g.dirX * d, c[1] - g.dirY * d, g.dirX * 3 * d, g.dirY * 3 * d);
    s.step({});
  };
  cross(1); assert.equal(s.nextSector, 0);          // sector 2 first: ignored
  cross(0, true); assert.equal(s.nextSector, 0);    // backwards through sector 1: ignored
  cross(0); assert.equal(s.nextSector, 1);
  cross(2); assert.equal(s.nextSector, 1);
  cross(1); assert.equal(s.nextSector, 2);
  cross(2); assert.equal(s.nextSector, 3);
});

test('backing over the line and re-crossing neither restarts nor double counts', () => {
  const track = Core.tracks[0], p0 = track.points[0];
  const s = startedSession(track), g = s.finishGate;
  s.nextSector = s.gates.length;
  for (let i = 0; i < 1500; i++) s.step({});
  const start = s.lapStart;
  place(s, p0[0] + g.dirX * 0.5, p0[1] + g.dirY * 0.5, -g.dirX * 3, -g.dirY * 3);
  assert.equal(s.step({}), null);                                          // backwards across the line
  place(s, p0[0] - g.dirX * 0.5, p0[1] - g.dirY * 0.5, g.dirX * 3, g.dirY * 3);
  assert.equal(s.step({}), null);                                          // forwards again: ignored
  assert.equal(s.lapStart, start);
  assert.equal(s.lapCount, 0);
});

test('legacy rules: 200-step cooldown, any-order sectors, wall clock, 5 s minimum', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([450 + 300 * Math.cos(i / 40 * 2 * Math.PI), 280 + 180 * Math.sin(i / 40 * 2 * Math.PI)]);
  let wall = 1000;
  const track = { id: 'legacy', legacy: true, points: pts, width: 58, sectors: [10, 20, 30], startIndex: 0, minLapMs: 5000,
    bounds: { x: 0, y: 0, w: 900, h: 560 }, spawn: { x: pts[1][0], y: pts[1][1], angle: 0 } };
  const s = Core.createSession({ track, wallNow: () => wall });
  const g = s.finishGate, p0 = pts[0];
  const shove = (back) => { const d = back ? -1 : 1; place(s, p0[0] - g.dirX * 3 * d, p0[1] - g.dirY * 3 * d, g.dirX * 12 * d, g.dirY * 12 * d); return s.step({}); };
  assert.equal(shove(), null);                                             // inside the first 200 steps: ignored
  for (let i = 0; i < 200; i++) s.step({});
  assert.deepEqual(shove(), { type: 'start' });
  assert.equal(s.elapsed(), 0);
  [30, 10, 20].forEach(i => { const sg = s.gates[track.sectors.indexOf(i)], c = pts[i]; place(s, c[0] - sg.dirX * 3, c[1] - sg.dirY * 3, sg.dirX * 12, sg.dirY * 12); s.step({}); });
  assert.equal(s.sectorsOk.size, 3);                                       // any order
  wall += 4000; assert.equal(shove().reason, 'slow');                      // under 5 s: invalid
  s.sectorsOk.add(0); s.sectorsOk.add(1); s.sectorsOk.add(2);
  wall += 6000.5;
  const ev = shove();
  assert.deepEqual([ev.type, ev.ms, ev.lap, ev.frames], ['lap', 6000.5, 1, null]);
  wall += 3000; s.shiftClock(2000);                                         // a 2 s pause is cut out of the lap clock
  assert.equal(s.elapsed(), 1000);
});

// ── persistence ────────────────────────────────────────────────────────────
function bestLap(track) {
  const lap = drive(track, { laps: 1 }).events.find(e => e.type === 'lap');
  return { ms: lap.ms, frames: lap.frames };
}
const fasterLap = (lap, less) => {
  const f = lap.frames.filter(r => r[0] < lap.ms - less - Core.FRAME_INTERVAL_MS).map(r => r.slice());
  const last = lap.frames[lap.frames.length - 1];
  f.push([lap.ms - less, last[1], last[2], last[3]]);
  return { ms: lap.ms - less, frames: f };
};
const sloweredLap = (lap, extra) => {
  const f = lap.frames.map(r => r.slice());
  f[f.length - 1][0] += extra;
  return { ms: lap.ms + extra, frames: f };
};

test('scores: only strictly faster laps replace a best; boards are sorted and capped', () => {
  const st = fakeStorage();
  const r1 = Core.recordScore(st, 'cadiz-city-v3', null, 'Ana', 30000);
  assert.deepEqual(r1, { improved: true, persisted: true, best: 30000 });
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'ANA', 30001).improved, false);
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'ana', 30000).improved, false);   // equal
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'ana', 29999).improved, true);
  Core.recordScore(st, 'cadiz-city-v3', null, 'Bob', 25000);
  assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', null), [{ name: 'Bob', ms: 25000 }, { name: 'ana', ms: 29999 }]);
  assert.deepEqual(Core.recordScore(st, 'cadiz-city-v3', null, '', 20000), { improved: false, persisted: false, best: null });
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'Eve', 500).improved, false);      // below the sanity floor
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'Eve', NaN).improved, false);
  for (let i = 0; i < 130; i++) Core.recordScore(st, 'noob-gp-v3', null, 'P' + i, 20000 + i);
  const board = Core.loadScores(st, 'noob-gp-v3', null);
  assert.equal(board.length, 100);
  assert.equal(board[0].name, 'P0');
});

test('scores are isolated per track, per weekly challenge and from free play; legacy storage is never touched', () => {
  const st = fakeStorage();
  st.setItem('rah-racing-lb-wide-v2', '{"OLD":12345}'); st.setItem('rah-race-last', 'OLD');
  Core.recordScore(st, 'cadiz-city-v3', null, 'Ana', 30000);
  Core.recordScore(st, 'cadiz-city-v3', '2026-10-19', 'Ana', 28000);
  Core.recordScore(st, 'spa-francorchamps-v3', '2026-10-19', 'Ana', 27000);
  Core.recordScore(st, 'cadiz-city-v3', '2026-10-26', 'Ana', 26000);
  assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', null).map(e => e.ms), [30000]);
  assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', '2026-10-19').map(e => e.ms), [28000]);
  assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', '2026-10-26').map(e => e.ms), [26000]);
  assert.deepEqual(Core.loadScores(st, 'spa-francorchamps-v3', '2026-10-19').map(e => e.ms), [27000]);
  assert.deepEqual(Core.loadScores(st, 'spa-francorchamps-v3', null), []);
  assert.deepEqual(Core.loadScores(st, 'noob-gp-v3', '2026-10-19'), []);
  assert.equal(new Set([null, '2026-10-19', '2026-10-26'].map(c => Core.scoresKey(Core.scopeOf('cadiz-city-v3', c)))).size, 3);
  assert.throws(() => Core.recordScore(st, 'legacy', null, 'Ana', 30000), RangeError);
  assert.throws(() => Core.loadScores(st, 'legacy', null), RangeError);
  assert.throws(() => Core.scopeOf('cadiz-city-v3', '../../x'), RangeError);
  assert.equal(st.getItem('rah-racing-lb-wide-v2'), '{"OLD":12345}');
  assert.equal(st.getItem('rah-race-last'), 'OLD');
  assert.ok([...st.m.keys()].every(k => k === 'rah-racing-lb-wide-v2' || k === 'rah-race-last' || k.startsWith(Core.STORE_PREFIX + ':')));
});

test('corrupt or hostile storage contents are ignored, never thrown', () => {
  const st = fakeStorage();
  const key = Core.scoresKey('cadiz-city-v3');
  for (const raw of ['not json', '{', 'null', '42', '"x"', '[]', '{"entries":"x"}', '{"entries":{"a":1}}']) {
    st.setItem(key, raw);
    assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', null), [], raw);
  }
  st.setItem(key, JSON.stringify({ entries: [null, 7, { name: 1, ms: 20000 }, { name: 'Ok', ms: -5 }, { name: 'Ok', ms: 'x' },
    { name: 'Ok', ms: 1e12 }, { name: '__proto__', ms: 21000 }, { name: '<b>', ms: 22000 }, { name: 'Good', ms: 23000 }, { name: 'good', ms: 24000 }] }));
  const rows = Core.loadScores(st, 'cadiz-city-v3', null);
  assert.deepEqual(rows.map(r => r.ms), [21000, 22000, 23000]);
  assert.ok(rows.every(r => /^[\p{L}\p{N} _.\-]+$/u.test(r.name)));
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  // a corrupt board is replaced cleanly by the next valid score
  st.setItem(key, 'garbage');
  assert.equal(Core.recordScore(st, 'cadiz-city-v3', null, 'Ana', 30000).persisted, true);
  assert.equal(Core.loadScores(st, 'cadiz-city-v3', null).length, 1);
});

test('storage that throws (private mode, quota, blocked) is tolerated', () => {
  for (const st of [fakeStorage({ failGet: true, failSet: true }), fakeStorage({ failSet: true }), null, undefined, {}]) {
    assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', null), []);
    const r = Core.recordScore(st, 'cadiz-city-v3', null, 'Ana', 30000);
    assert.equal(r.persisted, false);
    assert.equal(Core.loadGhost(st, 'cadiz-city-v3', null, 'Ana'), null);
    const lap = bestLap(Core.tracks[0]);
    const res = Core.recordLap(st, { trackId: 'cadiz-city-v3', challengeId: null, name: 'Ana', ms: lap.ms, frames: lap.frames });
    assert.equal(res.ghost.persisted, false);
  }
});

test('ghost: kept only when strictly faster, per player, track and challenge', () => {
  const track = Core.tracks[0], lap = bestLap(track), st = fakeStorage();
  const save = (ch, name, l) => Core.saveGhostIfBetter(st, track.id, ch, name, l.ms, l.frames);
  const first = save(null, 'Ana', lap);
  assert.equal(first.improved, true);
  assert.equal(first.persisted, true);
  const stored = () => JSON.parse(st.getItem(Core.ghostKey(Core.scopeOf(track.id, null), 'Ana')));
  assert.equal(stored().ms, lap.ms);
  const slower = save(null, 'ana', sloweredLap(lap, 400));
  assert.equal(slower.improved, false);
  assert.equal(slower.ghost.ms, lap.ms);
  assert.equal(stored().ms, lap.ms);
  assert.equal(save(null, 'Ana', lap).improved, false);                    // same time
  const faster = save(null, 'Ana', fasterLap(lap, 100));
  assert.equal(faster.improved, true);
  assert.equal(stored().ms, lap.ms - 100);
  assert.equal(Core.loadGhost(st, track.id, null, 'Ana').ms, lap.ms - 100);
  assert.equal(Core.loadGhost(st, track.id, null, 'Bob'), null);
  assert.equal(Core.loadGhost(st, track.id, '2026-10-19', 'Ana'), null);
  assert.equal(Core.loadGhost(st, 'spa-francorchamps-v3', null, 'Ana'), null);
  assert.equal(save('2026-10-19', 'Ana', sloweredLap(lap, 900)).improved, true);   // separate scope
  const keys = [...st.m.keys()].length;
  assert.deepEqual(Core.saveGhostIfBetter(st, 'legacy', null, 'Ana', lap.ms, lap.frames), { improved: false, persisted: false, ghost: null });
  assert.equal(st.m.size, keys);
});

test('ghost: a corrupt stored ghost is replaced, invalid candidates are refused', () => {
  const track = Core.tracks[0], lap = bestLap(track), st = fakeStorage();
  const key = Core.ghostKey(Core.scopeOf(track.id, null), 'Ana');
  st.setItem(key, '{"ms":1,"frames":"x"}');
  assert.equal(Core.loadGhost(st, track.id, null, 'Ana'), null);
  assert.equal(Core.saveGhostIfBetter(st, track.id, null, 'Ana', lap.ms, lap.frames).improved, true);
  const bad = (mutate) => { const f = lap.frames.map(r => r.slice()); const ms = mutate(f) || lap.ms; return Core.sanitizeGhost({ ms, frames: f }, track); };
  assert.equal(bad(f => { f[3][1] = 5000; }), null);                       // outside the world
  assert.equal(bad(f => { f[4][0] = f[2][0]; }), null);                    // time not increasing
  assert.equal(bad(f => { f[2][3] = NaN; }), null);
  assert.equal(bad(f => { f[0][0] = 5; }), null);                          // must start at 0
  assert.equal(bad(f => lap.ms + 50), null);                               // last frame ≠ lap time
  assert.equal(bad(() => track.minLapMs - 1), null);
  assert.equal(Core.sanitizeGhost({ ms: lap.ms, frames: lap.frames.slice(0, 1) }, track), null);
  assert.equal(Core.sanitizeGhost({ ms: lap.ms, frames: new Array(Core.MAX_FRAMES + 1).fill([0, 1, 1, 0]) }, track), null);
  assert.equal(Core.sanitizeGhost({ ms: lap.ms, frames: [[0, 1], [lap.ms, 1]] }, track), null);
  assert.equal(Core.sanitizeGhost(null, track), null);
  const ok = bad(() => 0);
  assert.equal(ok && ok.ms, lap.ms);
  assert.equal(Core.saveGhostIfBetter(st, track.id, null, 'Ana', lap.ms - 1000, [[0, 1, 1, 0], [lap.ms - 1000, 9999, 1, 0]]).improved, false);
});

test('recordLap saves score and ghost together and does not touch a better ghost', () => {
  const track = Core.tracks[1], lap = bestLap(track), st = fakeStorage();
  const a = Core.recordLap(st, { trackId: track.id, challengeId: '2026-10-19', name: 'Ana', ms: lap.ms, frames: lap.frames });
  assert.deepEqual([a.score.improved, a.ghost.improved], [true, true]);
  const slow = sloweredLap(lap, 1000);
  const b = Core.recordLap(st, { trackId: track.id, challengeId: '2026-10-19', name: 'Ana', ms: slow.ms, frames: slow.frames });
  assert.deepEqual([b.score.improved, b.ghost.improved], [false, false]);
  assert.equal(Core.loadGhost(st, track.id, '2026-10-19', 'Ana').ms, lap.ms);
  const c = Core.recordLap(st, { trackId: track.id, challengeId: null, name: 'Ana', ms: lap.ms, frames: null });   // frames dropped (too long)
  assert.deepEqual([c.score.improved, c.ghost.improved, c.ghost.persisted], [true, false, false]);
});

// ── API client ─────────────────────────────────────────────────────────────
function res(status, body, textOverride) {
  return { ok: status >= 200 && status < 300, status, async text() { return textOverride !== undefined ? textOverride : JSON.stringify(body); } };
}

test('normalizeApiUrl accepts https (and localhost http) and strips everything else', () => {
  const n = Core.normalizeApiUrl;
  assert.equal(n('https://racing.example.com'), 'https://racing.example.com');
  assert.equal(n('  https://racing.example.com/  '), 'https://racing.example.com');
  assert.equal(n('https://racing.example.com///?x=1#frag'), 'https://racing.example.com');
  assert.equal(n('https://racing.example.com/lab/'), 'https://racing.example.com/lab');
  assert.equal(n('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(n('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const bad of ['', '   ', 'http://racing.example.com', 'ftp://x.test', 'javascript:alert(1)', 'https://user:pw@x.test', 'racing.example.com', null, undefined, 5, {}]) assert.equal(n(bad), '', String(bad));
  assert.equal(Core.createApi(''), null);
  assert.equal(Core.createApi('http://x.test'), null);
});

test('api.leaderboard: builds the contract URL, sanitizes untrusted entries', async () => {
  const calls = [];
  const api = Core.createApi('https://api.test/', { fetch: async (url, init) => {
    calls.push([url, init]);
    return res(200, { entries: [{ name: '<script>alert(1)</script>', ms: 31000 }, { name: 'Zed', ms: 29000 }, { name: 'Zed', ms: 40000 },
      { name: 'Nope', ms: 'fast' }, { name: 'Neg', ms: -1 }, null, { name: 'x'.repeat(200), ms: 35000 }] });
  } });
  const rows = await api.leaderboard('cadiz-city-v3', null);
  assert.equal(calls[0][0], 'https://api.test/api/leaderboard?track=cadiz-city-v3');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.deepEqual(rows.map(r => r.ms), [29000, 31000, 35000]);
  assert.ok(rows.every(r => /^[\p{L}\p{N} _.\-]+$/u.test(r.name) && r.name.length <= 20));
  await api.leaderboard('spa-francorchamps-v3', '2026-10-19');
  assert.equal(calls[1][0], 'https://api.test/api/leaderboard?track=spa-francorchamps-v3&challenge=2026-10-19');
  const n = calls.length;
  assert.equal(await api.leaderboard('legacy', null), null);               // legacy never goes to the API
  assert.equal(await api.leaderboard('cadiz-city-v3', 'x&y=1'), null);
  assert.equal(calls.length, n);
});

test('api.leaderboard: failures, bad JSON, wrong shapes, oversize bodies and timeouts yield null', async () => {
  const mk = f => Core.createApi('https://api.test', { fetch: f, timeoutMs: 30 });
  assert.equal(await mk(async () => res(500, {})).leaderboard('noob-gp-v3'), null);
  assert.equal(await mk(async () => { throw new Error('offline'); }).leaderboard('noob-gp-v3'), null);
  assert.equal(await mk(async () => res(200, null, '<html>')).leaderboard('noob-gp-v3'), null);
  assert.equal(await mk(async () => res(200, null, 'null')).leaderboard('noob-gp-v3'), null);
  assert.deepEqual(await mk(async () => res(200, { entries: 'x' })).leaderboard('noob-gp-v3'), []);
  assert.equal(await mk(async () => res(200, null, ' '.repeat(300000) + '{}')).leaderboard('noob-gp-v3'), null);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const t0 = Date.now();
  assert.equal(await mk(hang).leaderboard('noob-gp-v3'), null);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await mk(async () => res(200, {})).health(), true);
  assert.equal(await mk(async () => res(503, {})).health(), false);
});

test('api.submit: exact payload, only new tracks, honest outcomes', async () => {
  const track = Core.tracks[2], lap = bestLap(track), calls = [];
  let reply = res(200, { saved: true });
  const api = Core.createApi('https://api.test', { fetch: async (url, init) => { calls.push([url, init]); return reply; } });
  const lapArg = { trackId: track.id, challengeId: '2026-10-19', name: 'Ana <3', ms: lap.ms, frames: lap.frames };
  assert.equal(await api.submit(lapArg), 'saved');
  const [url, init] = calls[0], body = JSON.parse(init.body);
  assert.equal(url, 'https://api.test/api/laps');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(body), ['trackId', 'challengeId', 'name', 'ms', 'frames']);
  assert.deepEqual([body.trackId, body.challengeId, body.name, body.ms], [track.id, '2026-10-19', 'Ana 3', lap.ms]);
  assert.deepEqual(body.frames, lap.frames);
  assert.equal(await api.submit({ ...lapArg, challengeId: null }), 'saved');
  assert.equal(JSON.parse(calls[1][1].body).challengeId, null);
  reply = res(200, { saved: 'yes' }); assert.equal(await api.submit(lapArg), 'not-saved');
  reply = res(200, { saved: false }); assert.equal(await api.submit(lapArg), 'not-saved');
  reply = res(400, { error: 'x' }); assert.equal(await api.submit(lapArg), 'not-saved');
  reply = res(429, {}); assert.equal(await api.submit(lapArg), 'unavailable');
  reply = res(502, {}); assert.equal(await api.submit(lapArg), 'unavailable');
  const n = calls.length;
  assert.equal(await api.submit({ ...lapArg, trackId: 'legacy' }), 'skipped');
  assert.equal(await api.submit({ ...lapArg, frames: null }), 'skipped');
  assert.equal(await api.submit({ ...lapArg, name: '!!!' }), 'skipped');
  assert.equal(await api.submit({ ...lapArg, challengeId: 'bad' }), 'skipped');
  assert.equal(await api.submit({ ...lapArg, ms: lap.ms + 50 }), 'skipped');
  assert.equal(calls.length, n);
  const dead = Core.createApi('https://api.test', { fetch: async () => { throw new Error('down'); } });
  assert.equal(await dead.submit(lapArg), 'unavailable');
});

// ── config file ────────────────────────────────────────────────────────────
test('racing-config.js defaults to deployed HTTPS API and keeps explicit overrides', () => {
  const src = fs.readFileSync(path.join(ROOT, 'racing-config.js'), 'utf8');
  const run = (pre) => { const w = { ...pre }; vm.runInNewContext(src, { window: w }); return w.RACING_API_URL; };
  assert.equal(run({}), 'https://api.ircopilot.com/racing');
  assert.equal(run({ RACING_API_URL: 'https://api.test' }), 'https://api.test');
  assert.equal(run({ RACING_API_URL: 12 }), 'https://api.ircopilot.com/racing');
  assert.equal(run({ RACING_API_URL: '' }), '');
  assert.equal(Core.createApi(run({})).base, 'https://api.ircopilot.com/racing');
  assert.equal(Core.createApi(run({RACING_API_URL:''})), null);
});

test('the core also installs window.RacingLabCore when loaded as a browser script', () => {
  const w = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'racing-core.js'), 'utf8'), { window: w });
  assert.deepEqual(Array.from(w.RacingLabCore.tracks, t => t.id), Core.TRACK_IDS);
  assert.equal(typeof w.RacingLabCore.weeklyChallenge, 'function');
});

// Geometry-changing layouts get fresh storage namespaces, while Noob GP is only a rename.
test('refined tracks isolate old scores and retain Sierra geometry exactly', () => {
  const crypto = require('node:crypto');
  const {name, points} = Core.trackById('noob-gp-v3');
  assert.equal(name, 'Noob GP');
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(points)).digest('hex'), '0cb54b1d9b2c61e59b351fdff850abb0c1aabae366d3b999dcf94f037e3414d2');
  const st = fakeStorage(); Core.recordScore(st, 'cadiz-sprint', null, 'Old', 12000);
  assert.deepEqual(Core.loadScores(st, 'cadiz-city-v3', null), []);
  assert.deepEqual(Core.loadScores(st, 'cadiz-sprint', null), [{name:'Old',ms:12000}]);
});


test('all active roads are wider and preserve Spa/Noob centerlines', () => {
  assert.equal(Core.trackById('cadiz-city-v3').width,60);
  assert.equal(Core.trackById('spa-francorchamps-v3').width,58);
  assert.equal(Core.trackById('noob-gp-v3').width,78);
  const crypto=require('node:crypto');
  const hash=t=>crypto.createHash('sha256').update(JSON.stringify(t.points)).digest('hex');
  assert.equal(hash(Core.trackById('spa-francorchamps-v3')),'76fc7151ea16c4f9b6ac7f4cc75ddb40b192a02e1559bf6ea641d90cc799a10f');
  assert.equal(hash(Core.trackById('noob-gp-v3')),'0cb54b1d9b2c61e59b351fdff850abb0c1aabae366d3b999dcf94f037e3414d2');
  assert.ok(Core.trackById('cadiz-city-v3').geography.includes('La Caleta'));
});


test('ghost angles use canonical zero so a saved replay matches its JSON payload', () => {
  const t=Core.tracks[0],p=t.points[0];
  const ghost=Core.sanitizeGhost({ms:30000,frames:[[0,p[0],p[1],-0],[30000,p[0],p[1],0]]},t);
  assert.ok(ghost);assert.equal(Object.is(ghost.frames[0][3],-0),false);
  assert.deepEqual(JSON.parse(JSON.stringify(ghost)),ghost);
});
