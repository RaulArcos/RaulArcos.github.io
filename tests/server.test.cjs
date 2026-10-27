'use strict';
// Public-HTTP tests for the optional Racing Lab API. Every test starts a fresh
// loopback server on an ephemeral port with an isolated temp data directory and
// only observes behaviour through the public API (reopening a server on the same
// directory proves persistence).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, loadConfig } = require('../server/server.cjs');

const ORIGIN = 'https://raularcos.github.io';
// Wednesday 2026-01-14 -> weekly id 2026-01-12, one week after origin => spa-francorchamps-v3.
const NOW = Date.UTC(2026, 0, 14, 12, 0, 0);
const WEEK = '2026-01-12';
const WEEK_TRACK = 'spa-francorchamps-v3';

const dirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'racing-lab-test-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function start(dataDir, overrides = {}) {
  const clock = { now: NOW };
  const config = Object.assign(loadConfig({}), {
    host: '127.0.0.1',
    port: 0,
    dataDir: dataDir || tempDir(),
    allowedOrigins: [ORIGIN],
    now: () => clock.now,
    logger: () => {},
    writeRateLimit: 10000,
    readRateLimit: 10000
  }, overrides);
  const server = createServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = {
    server,
    clock,
    dataDir: config.dataDir,
    port: server.address().port,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    req: (method, url, opts) => request(server.address().port, method, url, opts)
  };
  return api;
}

function request(port, method, url, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('request timeout')));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

function frames(ms, { n = 50 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? ms : Math.round((ms * i) / (n - 1));
    out.push([t, 100 + (i * 10) % 700, 100 + (i * 7) % 400, (i % 628) / 100]);
  }
  out[0][0] = 0;
  return out;
}

function lap(over = {}) {
  const ms = over.ms === undefined ? 60000 : over.ms;
  return Object.assign({ trackId: 'cadiz-city-v3', challengeId: null, name: 'RaulArcos2', ms, frames: frames(ms) }, over);
}

const WRITE = { headers: { origin: ORIGIN, 'content-type': 'application/json' } };
const post = (api, body, extra) => api.req('POST', '/api/laps', Object.assign({ body }, WRITE, extra));
const board = async (api, track, challenge) => (await api.req('GET', `/api/leaderboard?track=${track}${challenge ? `&challenge=${challenge}` : ''}`));

test('health reports ok without leaking details', async () => {
  const api = await start();
  try {
    const r = await api.req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, verified: false });
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  } finally { await api.close(); }
});

test('routing: unknown path 404, wrong method 405, JSON error shape', async () => {
  const api = await start();
  try {
    const a = await api.req('GET', '/nope');
    assert.equal(a.status, 404);
    assert.equal(a.json.error, 'not_found');
    const b = await api.req('DELETE', '/api/laps');
    assert.equal(b.status, 405);
    assert.equal(b.json.error, 'method_not_allowed');
    const c = await api.req('GET', '/api/laps');
    assert.equal(c.status, 405);
  } finally { await api.close(); }
});

test('empty leaderboard, then submit, ghost, and strictly-faster replacement', async () => {
  const api = await start();
  try {
    let r = await board(api, 'cadiz-city-v3');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { entries: [], verified: false });

    r = await post(api, lap({ ms: 60000 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { saved: true });
    r = await board(api, 'cadiz-city-v3');
    assert.deepEqual(r.json.entries, [{ name: 'RaulArcos2', ms: 60000 }]);

    const slower = await post(api, lap({ ms: 61000 }));
    assert.deepEqual(slower.json, { saved: false });
    const equal = await post(api, lap({ ms: 60000, frames: frames(60000, { n: 20 }) }));
    assert.deepEqual(equal.json, { saved: false });
    let g = await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2');
    assert.equal(g.json.ms, 60000);
    assert.equal(g.json.frames.length, 50);

    const faster = await post(api, lap({ ms: 59000, frames: frames(59000, { n: 30 }) }));
    assert.deepEqual(faster.json, { saved: true });
    r = await board(api, 'cadiz-city-v3');
    assert.deepEqual(r.json.entries, [{ name: 'RaulArcos2', ms: 59000 }]);
    g = await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2');
    assert.equal(g.status, 200);
    assert.equal(g.json.ms, 59000);
    assert.equal(g.json.frames.length, 30);
    assert.deepEqual(Object.keys(g.json).sort(), ['frames', 'ms']);
  } finally { await api.close(); }
});

test('leaderboard sorts fastest first and name matching is case-insensitive per driver', async () => {
  const api = await start();
  try {
    await post(api, lap({ name: 'Slow', ms: 90000 }));
    await post(api, lap({ name: 'Fast', ms: 50000 }));
    await post(api, lap({ name: 'Mid', ms: 70000 }));
    await post(api, lap({ name: 'fast', ms: 49000 }));
    const r = await board(api, 'cadiz-city-v3');
    assert.deepEqual(r.json.entries, [
      { name: 'fast', ms: 49000 }, { name: 'Mid', ms: 70000 }, { name: 'Slow', ms: 90000 }
    ]);
    const g = await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=FAST');
    assert.equal(g.json.ms, 49000);
  } finally { await api.close(); }
});

test('tracks are isolated and legacy/unknown tracks are rejected', async () => {
  const api = await start();
  try {
    await post(api, lap({ trackId: 'cadiz-city-v3', ms: 60000 }));
    await post(api, lap({ trackId: 'noob-gp-v3', ms: 80000 }));
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, [{ name: 'RaulArcos2', ms: 60000 }]);
    assert.deepEqual((await board(api, 'noob-gp-v3')).json.entries, [{ name: 'RaulArcos2', ms: 80000 }]);
    assert.deepEqual((await board(api, 'spa-francorchamps-v3')).json.entries, []);
    for (const id of ['legacy', 'default', 'circuit', '__proto__', 'constructor', '../x', '']) {
      const w = await post(api, lap({ trackId: id }));
      assert.equal(w.status, 400, id);
      assert.equal(w.json.error, 'invalid_track');
      const r = await board(api, encodeURIComponent(id));
      assert.equal(r.status, 400, id);
    }
    const g = await api.req('GET', '/api/ghost?track=legacy&name=RaulArcos2');
    assert.equal(g.status, 400);
    assert.equal((await api.req('GET', '/api/leaderboard')).status, 400);
  } finally { await api.close(); }
});

test('weekly challenge: separate board, rotation, wrong/expired/future/malformed ids rejected', async () => {
  const api = await start();
  try {
    await post(api, lap({ trackId: WEEK_TRACK, ms: 70000 }));
    const ok = await post(api, lap({ trackId: WEEK_TRACK, challengeId: WEEK, ms: 65000 }));
    assert.deepEqual(ok.json, { saved: true });
    assert.deepEqual((await board(api, WEEK_TRACK)).json.entries, [{ name: 'RaulArcos2', ms: 70000 }]);
    assert.deepEqual((await board(api, WEEK_TRACK, WEEK)).json.entries, [{ name: 'RaulArcos2', ms: 65000 }]);
    // Slower weekly does not touch the free board or the weekly board.
    assert.deepEqual((await post(api, lap({ trackId: WEEK_TRACK, challengeId: WEEK, ms: 66000 }))).json, { saved: false });
    assert.equal((await api.req('GET', `/api/ghost?track=${WEEK_TRACK}&name=RaulArcos2&challenge=${WEEK}`)).json.ms, 65000);
    assert.equal((await api.req('GET', `/api/ghost?track=${WEEK_TRACK}&name=RaulArcos2`)).json.ms, 70000);

    const wrongTrack = await post(api, lap({ trackId: 'cadiz-city-v3', challengeId: WEEK }));
    assert.equal(wrongTrack.status, 400);
    assert.equal(wrongTrack.json.error, 'invalid_challenge');
    const expired = await post(api, lap({ trackId: 'cadiz-city-v3', challengeId: '2026-01-05' }));
    assert.equal(expired.status, 409);
    assert.equal(expired.json.error, 'challenge_expired');
    for (const bad of ['2026-01-13', '2026-01-19', '2025-12-29', 'abc', '2026-02-30', '2026-1-12', 'free', 12, {}, '__proto__']) {
      const r = await post(api, lap({ trackId: WEEK_TRACK, challengeId: bad }));
      assert.ok(r.status === 400 || r.status === 409, String(bad));
      assert.equal(r.json.saved, undefined);
    }
    for (const bad of ['2026-01-13', 'zzz', '2026-01-26']) {
      const r = await board(api, WEEK_TRACK, bad);
      assert.equal(r.status, 400, bad);
    }
    // Rotation: week 2026-01-05 -> cadiz, 01-19 -> sierra, 01-26 -> cadiz again.
    api.clock.now = Date.UTC(2026, 0, 5, 0, 0, 0);
    assert.deepEqual((await post(api, lap({ trackId: 'cadiz-city-v3', challengeId: '2026-01-05' }))).json, { saved: true });
    api.clock.now = Date.UTC(2026, 0, 25, 23, 59, 59);
    assert.deepEqual((await post(api, lap({ trackId: 'noob-gp-v3', challengeId: '2026-01-19' }))).json, { saved: true });
    api.clock.now = Date.UTC(2026, 0, 26, 0, 0, 0);
    assert.equal((await post(api, lap({ trackId: 'noob-gp-v3', challengeId: '2026-01-19' }))).status, 409);
    assert.deepEqual((await post(api, lap({ trackId: 'cadiz-city-v3', challengeId: '2026-01-26' }))).json, { saved: true });
    // Past weeks stay readable.
    assert.equal((await board(api, 'noob-gp-v3', '2026-01-19')).json.entries.length, 1);
    // Before the origin nothing is valid.
    api.clock.now = Date.UTC(2025, 11, 31);
    assert.equal((await post(api, lap({ challengeId: '2025-12-29' }))).status, 400);
  } finally { await api.close(); }
});

test('payload validation rejects bad values with exact codes and stores nothing', async () => {
  const api = await start();
  try {
    const f = frames(60000);
    const bad = (mut) => { const l = lap(); mut(l); return l; };
    const cases = [
      ['name missing', bad((l) => { delete l.name; }), 'invalid_name'],
      ['name empty', lap({ name: '   ' }), 'invalid_name'],
      ['name html', lap({ name: '<img src=x onerror=1>' }), 'invalid_name'],
      ['name too long', lap({ name: 'a'.repeat(25) }), 'invalid_name'],
      ['name number', lap({ name: 7 }), 'invalid_name'],
      ['name proto', lap({ name: '__proto__' }), 'invalid_name'],
      ['name control', lap({ name: 'ab\u0000c' }), 'invalid_name'],
      ['ms string', lap({ ms: '60000' }), 'invalid_time'],
      ['ms null', lap({ ms: null }), 'invalid_time'],
      ['ms too fast', lap({ ms: 4999, frames: frames(4999) }), 'invalid_time'],
      ['ms too slow', lap({ ms: 180001, frames: frames(180001) }), 'invalid_time'],
      ['ms negative', lap({ ms: -60000 }), 'invalid_time'],
      ['frames not array', lap({ frames: 'x' }), 'invalid_frames'],
      ['frames too few', lap({ frames: [[0, 1, 1, 0]] }), 'invalid_frames'],
      ['frames too many', lap({ frames: frames(60000, { n: 4001 }) }), 'invalid_frames'],
      ['frame wrong arity', lap({ frames: f.map((x, i) => (i === 5 ? [x[0], x[1], x[2]] : x)) }), 'invalid_frames'],
      ['frame string number', lap({ frames: f.map((x, i) => (i === 5 ? [x[0], '10', x[2], x[3]] : x)) }), 'invalid_frames'],
      ['frame null', lap({ frames: f.map((x, i) => (i === 5 ? null : x)) }), 'invalid_frames'],
      ['x out of bounds', lap({ frames: f.map((x, i) => (i === 5 ? [x[0], 901, x[2], x[3]] : x)) }), 'invalid_frames'],
      ['y out of bounds', lap({ frames: f.map((x, i) => (i === 5 ? [x[0], x[1], -1, x[3]] : x)) }), 'invalid_frames'],
      ['angle huge', lap({ frames: f.map((x, i) => (i === 5 ? [x[0], x[1], x[2], 1e9] : x)) }), 'invalid_frames'],
      ['time goes backwards', lap({ frames: f.map((x, i) => (i === 5 ? [x[0] - 100000, x[1], x[2], x[3]] : x)) }), 'invalid_frames'],
      ['first frame not 0', lap({ frames: f.map((x, i) => (i === 0 ? [5, x[1], x[2], x[3]] : x)) }), 'invalid_frames'],
      ['last frame not ms', lap({ frames: f.map((x, i) => (i === f.length - 1 ? [59000, x[1], x[2], x[3]] : x)) }), 'invalid_frames'],
      ['trackId not string', lap({ trackId: ['cadiz-city-v3'] }), 'invalid_track']
    ];
    for (const [label, body, code] of cases) {
      const r = await post(api, body);
      assert.equal(r.status, 400, label);
      assert.equal(r.json.error, code, label);
      assert.equal(typeof r.json.message, 'string');
      assert.doesNotMatch(r.text, /\bat .*\.(c?js):\d+/, label);
    }
    for (const raw of ['not json', '[]', 'null', '"x"', '{"a":']) {
      const r = await post(api, undefined, { raw });
      assert.equal(r.status, 400, raw);
      assert.equal(r.json.error, 'invalid_json', raw);
    }
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, []);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2')).status, 404);
  } finally { await api.close(); }
});

test('boundary values are accepted: 5000ms, 180000ms, 4000 samples, 900x560 corners', async () => {
  const api = await start();
  try {
    const edge = frames(5000);
    edge[1] = [edge[1][0], 0, 0, -3.14];
    edge[2] = [edge[2][0], 900, 560, 3.14];
    assert.deepEqual((await post(api, lap({ name: 'Min', ms: 5000, frames: edge }))).json, { saved: true });
    assert.deepEqual((await post(api, lap({ name: 'Max', ms: 180000 }))).json, { saved: true });
    assert.deepEqual((await post(api, lap({ name: 'Dense', ms: 90000, frames: frames(90000, { n: 4000 }) }))).json, { saved: true });
  } finally { await api.close(); }
});

test('rejected, slower and unauthorized writes leave persisted public data unchanged after reopen', async () => {
  const dir = tempDir();
  let api = await start(dir);
  try {
    await post(api, lap({ ms: 60000 }));
  } finally { await api.close(); }

  api = await start(dir);
  try {
    const before = [(await board(api, 'cadiz-city-v3')).text, (await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2')).text];
    assert.equal(JSON.parse(before[0]).entries[0].ms, 60000);
    await post(api, lap({ ms: 61000 }));
    await post(api, lap({ ms: 1 }));
    await post(api, lap({ ms: 50000, name: '<b>x</b>' }));
    await post(api, lap({ ms: 50000 }), { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    await post(api, lap({ ms: 50000 }), { headers: { 'content-type': 'application/json' } });
    await post(api, lap({ ms: 50000 }), { headers: { origin: ORIGIN, 'content-type': 'text/plain' } });
    await api.close();
    api = await start(dir);
    const after = [(await board(api, 'cadiz-city-v3')).text, (await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2')).text];
    assert.deepEqual(after, before);
    // Strictly faster persists across restarts.
    await post(api, lap({ ms: 55000 }));
    await api.close();
    api = await start(dir);
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, [{ name: 'RaulArcos2', ms: 55000 }]);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=RaulArcos2')).json.ms, 55000);
  } finally { await api.close(); }
});

test('origin policy: only configured origins may write; CORS headers and preflight', async () => {
  const api = await start();
  try {
    const evil = await post(api, lap(), { headers: { origin: 'https://evil.example', 'content-type': 'application/json' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error, 'origin_not_allowed');
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
    const none = await post(api, lap(), { headers: { 'content-type': 'application/json' } });
    assert.equal(none.status, 403);
    const nullOrigin = await post(api, lap(), { headers: { origin: 'null', 'content-type': 'application/json' } });
    assert.equal(nullOrigin.status, 403);
    const prefix = await post(api, lap(), { headers: { origin: ORIGIN + '.evil.example', 'content-type': 'application/json' } });
    assert.equal(prefix.status, 403);
    const type = await post(api, lap(), { headers: { origin: ORIGIN, 'content-type': 'text/plain' } });
    assert.equal(type.status, 415);
    assert.equal(type.json.error, 'unsupported_media_type');

    const ok = await post(api, lap());
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
    assert.match(ok.headers.vary, /Origin/i);

    const read = await api.req('GET', '/api/leaderboard?track=cadiz-city-v3', { headers: { origin: ORIGIN } });
    assert.equal(read.headers['access-control-allow-origin'], ORIGIN);
    const readEvil = await api.req('GET', '/api/leaderboard?track=cadiz-city-v3', { headers: { origin: 'https://evil.example' } });
    assert.equal(readEvil.headers['access-control-allow-origin'], undefined);

    const pre = await api.req('OPTIONS', '/api/laps', { headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN);
    assert.match(pre.headers['access-control-allow-methods'], /POST/);
    const preEvil = await api.req('OPTIONS', '/api/laps', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preEvil.status, 403);
    assert.equal(preEvil.headers['access-control-allow-origin'], undefined);
  } finally { await api.close(); }
});

test('no configured origins means all browser writes are refused', async () => {
  const api = await start(null, { allowedOrigins: [] });
  try {
    assert.equal((await post(api, lap())).status, 403);
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, []);
  } finally { await api.close(); }
});

test('payload limit returns 413 and stores nothing', async () => {
  const api = await start(null, { maxBodyBytes: 2048 });
  try {
    const big = await post(api, lap({ frames: frames(60000, { n: 500 }) }));
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'payload_too_large');
    const chunked = await api.req('POST', '/api/laps', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, raw: '{"x":"' + 'a'.repeat(5000) + '"}' });
    assert.equal(chunked.status, 413);
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, []);
    // Server still healthy afterwards.
    assert.equal((await api.req('GET', '/api/health')).status, 200);
  } finally { await api.close(); }
});

test('default body limit accepts a 4000-sample lap and rejects a 2MB body', async () => {
  const api = await start();
  try {
    const r = await post(api, lap({ ms: 100000, frames: frames(100000, { n: 4000 }) }));
    assert.equal(r.status, 200);
    const huge = await api.req('POST', '/api/laps', { headers: { origin: ORIGIN, 'content-type': 'application/json' }, raw: JSON.stringify({ pad: 'a'.repeat(2 * 1024 * 1024) }) });
    assert.equal(huge.status, 413);
  } finally { await api.close(); }
});

test('write rate limit returns 429 with Retry-After; reads use a separate bucket', async () => {
  const api = await start(null, { writeRateLimit: 3, readRateLimit: 5, rateWindowMs: 60000 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(api, lap({ ms: 60000 - i }))).status, 200);
    const limited = await post(api, lap({ ms: 50000 }));
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    for (let i = 0; i < 5; i++) assert.equal((await board(api, 'cadiz-city-v3')).status, 200);
    assert.equal((await board(api, 'cadiz-city-v3')).status, 429);
  } finally { await api.close(); }
});

test('rate limit window resets with time', async () => {
  const api = await start(null, { writeRateLimit: 1, rateWindowMs: 1000 });
  try {
    assert.equal((await post(api, lap({ ms: 60000 }))).status, 200);
    assert.equal((await post(api, lap({ ms: 59000 }))).status, 429);
    api.clock.now += 1500;
    assert.equal((await post(api, lap({ ms: 59000 }))).status, 200);
  } finally { await api.close(); }
});

test('X-Forwarded-For is ignored unless the peer is an explicit trusted proxy', async () => {
  let api = await start(null, { writeRateLimit: 1 });
  try {
    const h = (ip) => ({ headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip } });
    assert.equal((await post(api, lap({ ms: 60000 }), h('1.1.1.1'))).status, 200);
    assert.equal((await post(api, lap({ ms: 59000 }), h('2.2.2.2'))).status, 429);
  } finally { await api.close(); }

  api = await start(null, { writeRateLimit: 1, trustedProxies: ['127.0.0.1', '::1'] });
  try {
    const h = (ip) => ({ headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip } });
    assert.equal((await post(api, lap({ ms: 60000 }), h('1.1.1.1'))).status, 200);
    assert.equal((await post(api, lap({ ms: 59000 }), h('2.2.2.2'))).status, 200);
    assert.equal((await post(api, lap({ ms: 58000 }), h('2.2.2.2'))).status, 429);
    // The rightmost untrusted hop wins, so a client-supplied prefix cannot dodge the limit.
    assert.equal((await post(api, lap({ ms: 57000 }), h('9.9.9.9, 2.2.2.2'))).status, 429);
  } finally { await api.close(); }
});

test('concurrent submissions never lose a best score', async () => {
  const api = await start();
  try {
    const names = Array.from({ length: 25 }, (_, i) => `Driver${i}`);
    const results = await Promise.all(names.map((name, i) => post(api, lap({ name, ms: 60000 + i * 10 }))));
    assert.ok(results.every((r) => r.json.saved === true));
    assert.equal((await board(api, 'cadiz-city-v3')).json.entries.length, 25);

    // Same driver, 30 racing times in parallel: only the fastest may remain.
    const times = Array.from({ length: 30 }, (_, i) => 70000 - i * 100);
    const shuffled = times.map((t, i) => times[(i * 7) % times.length]);
    await Promise.all(shuffled.map((ms) => post(api, lap({ name: 'Same', ms }))));
    const e = (await board(api, 'cadiz-city-v3')).json.entries.find((x) => x.name === 'Same');
    assert.equal(e.ms, Math.min(...times));
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=Same')).json.ms, Math.min(...times));

    await api.close();
    const again = await start(api.dataDir);
    try {
      const after = (await board(again, 'cadiz-city-v3')).json.entries;
      assert.equal(after.length, 26);
      assert.equal(after.find((x) => x.name === 'Same').ms, Math.min(...times));
    } finally { await again.close(); }
  } finally { await api.close().catch(() => {}); }
});

test('record cap refuses new drivers but still allows improvements; expired weeklies are pruned first', async () => {
  const api = await start(null, { maxRecords: 2 });
  try {
    assert.equal((await post(api, lap({ name: 'A', ms: 60000 }))).status, 200);
    assert.equal((await post(api, lap({ name: 'B', ms: 61000 }))).status, 200);
    const full = await post(api, lap({ name: 'C', ms: 62000 }));
    assert.equal(full.status, 503);
    assert.equal(full.json.error, 'storage_full');
    assert.deepEqual((await post(api, lap({ name: 'B', ms: 60500 }))).json, { saved: true });
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries.map((x) => x.name), ['A', 'B']);
  } finally { await api.close(); }

  const dir = tempDir();
  const w = await start(dir, { maxRecords: 2 });
  try {
    assert.equal((await post(w, lap({ trackId: WEEK_TRACK, challengeId: WEEK, name: 'A' }))).status, 200);
    assert.equal((await post(w, lap({ name: 'B' }))).status, 200);
    w.clock.now = Date.UTC(2026, 0, 21);
    assert.equal((await post(w, lap({ name: 'C' }))).status, 200);
    assert.deepEqual((await board(w, WEEK_TRACK, WEEK)).json.entries, []);
    assert.deepEqual((await board(w, 'cadiz-city-v3')).json.entries.map((x) => x.name), ['B', 'C']);
  } finally { await w.close(); }
});

test('hostile names and query strings are inert', async () => {
  const api = await start();
  try {
    assert.deepEqual((await post(api, lap({ name: 'constructor', ms: 60000 }))).json, { saved: true });
    assert.deepEqual((await post(api, lap({ name: 'toString', ms: 60000 }))).json, { saved: true });
    assert.deepEqual((await post(api, JSON.parse('{"__proto__":{"polluted":1},"trackId":"cadiz-city-v3","challengeId":null,"name":"Ok","ms":60000,"frames":' + JSON.stringify(frames(60000)) + '}'))).json, { saved: true });
    assert.equal({}.polluted, undefined);
    const entries = (await board(api, 'cadiz-city-v3')).json.entries;
    assert.deepEqual(entries.map((x) => x.name).sort(), ['Ok', 'constructor', 'toString']);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=hasOwnProperty')).status, 404);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=' + encodeURIComponent('../../etc/passwd'))).status, 400);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3')).status, 400);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=Nobody')).status, 404);
    assert.equal((await api.req('GET', '/api/ghost?track=cadiz-city-v3&name=Nobody')).json.error, 'not_found');
    // Names never leak raw HTML; only the allow-listed charset can reach responses.
    for (const e of entries) assert.doesNotMatch(e.name, /[<>&"']/);
  } finally { await api.close(); }
});

test('corrupt data files are ignored on load and never crash the API', async () => {
  const dir = tempDir();
  let api = await start(dir);
  try { await post(api, lap({ ms: 60000 })); } finally { await api.close(); }
  const recDir = path.join(dir, 'records');
  fs.writeFileSync(path.join(recDir, 'a'.repeat(64) + '.json'), '{broken');
  fs.writeFileSync(path.join(recDir, 'b'.repeat(64) + '.json'), JSON.stringify({ trackId: 'legacy', name: 'x', ms: 1 }));
  fs.writeFileSync(path.join(recDir, 'stray.tmp'), 'junk');
  api = await start(dir);
  try {
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, [{ name: 'RaulArcos2', ms: 60000 }]);
  } finally { await api.close(); }
});

test('server errors are bounded JSON without stack traces', async () => {
  const dir = tempDir();
  const api = await start(dir);
  try {
    await post(api, lap({ ms: 60000 }));
    // Make persistence fail: replace the records directory with a file.
    fs.rmSync(path.join(dir, 'records'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'records'), 'not a directory');
    const r = await post(api, lap({ ms: 50000 }));
    assert.equal(r.status, 500);
    assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message']);
    assert.equal(r.json.error, 'internal_error');
    assert.doesNotMatch(r.text, /ENOENT|ENOTDIR|\.cjs|node:|[A-Za-z]:\\|\/tmp/);
    // A failed write must not change the public result.
    assert.deepEqual((await board(api, 'cadiz-city-v3')).json.entries, [{ name: 'RaulArcos2', ms: 60000 }]);
  } finally { await api.close(); }
});

test('loadConfig parses environment safely and rejects unsafe values', () => {
  const c = loadConfig({
    RACING_PORT: '9000', RACING_HOST: '127.0.0.1', RACING_DATA_DIR: path.join(os.tmpdir(), 'rl-x'),
    RACING_ALLOWED_ORIGINS: 'https://a.example, https://b.example/', RACING_TRUSTED_PROXIES: '127.0.0.1'
  });
  assert.equal(c.port, 9000);
  assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.deepEqual(c.trustedProxies, ['127.0.0.1']);
  const d = loadConfig({});
  assert.equal(d.host, '127.0.0.1');
  assert.deepEqual(d.allowedOrigins, []);
  assert.deepEqual(d.trustedProxies, []);
  assert.equal(path.isAbsolute(d.dataDir), true);
  assert.throws(() => loadConfig({ RACING_ALLOWED_ORIGINS: '*' }), /RACING_ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({ RACING_ALLOWED_ORIGINS: 'https://a.example/path' }), /RACING_ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({ RACING_PORT: 'abc' }), /RACING_PORT/);
  assert.throws(() => loadConfig({ RACING_PORT: '70000' }), /RACING_PORT/);
  assert.throws(() => loadConfig({ RACING_MAX_RECORDS: '0' }), /RACING_MAX_RECORDS/);
});

test('requiring the module does not listen, and the entry process starts, serves and stops', async () => {
  const { spawn } = require('node:child_process');
  const dir = tempDir();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.cjs')], {
    env: { PATH: process.env.PATH, RACING_PORT: '0', RACING_DATA_DIR: dir, RACING_ALLOWED_ORIGINS: ORIGIN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('entry did not report listening')), 10000);
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/listening on 127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
      child.on('exit', (code) => { clearTimeout(t); reject(new Error('entry exited ' + code)); });
    });
    const r = await request(port, 'GET', '/api/health');
    assert.equal(r.status, 200);
  } finally {
    child.kill();
  }
});
