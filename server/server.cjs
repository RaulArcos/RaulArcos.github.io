'use strict';
// Racing Lab community score/ghost API. Plain Node, no dependencies.
// Scores are community submissions and are NOT verified or cheat-proof.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Keep track order and archived weekly-challenge rotation aligned with racing-core.js.
const TRACK_IDS = ['cadiz-city-v3', 'spa-francorchamps-v3', 'noob-gp-v3'];
const ARCHIVED_ROTATIONS = [
  ['cadiz-city-v2', 'spa-francorchamps-v2', 'noob-gp-v2'],
  ['cadiz-city-v1', 'spa-francorchamps-v1', 'sierra-gp'],
  ['cadiz-sprint', 'harbor-technical', 'sierra-gp'],
];
const ALL_TRACK_IDS = [...new Set([...TRACK_IDS, ...ARCHIVED_ROTATIONS.flat()])];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_ORIGIN = Date.UTC(2026, 0, 5); // Monday
const WORLD = { width: 900, height: 560 };
const LIMITS = { minMs: 5000, maxMs: 180000, maxFrames: 4000, maxAngle: 1000, maxName: 24, boardSize: 50 };
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,23}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// After refusing an oversized body we discard (not store) up to this much so the client can read the 413.
const DRAIN_LIMIT = 8 * 1024 * 1024;
const FILE_RE = /^[0-9a-f]{64}\.json$/;

// ---------- weekly challenges ----------

function weeklyChallenge(date) {
  const t = new Date(date);
  const dayStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const monday = dayStart - ((t.getUTCDay() + 6) % 7) * 86400000;
  const weeks = Math.floor((monday - WEEK_ORIGIN) / WEEK_MS);
  return {
    id: new Date(monday).toISOString().slice(0, 10),
    trackId: TRACK_IDS[((weeks % TRACK_IDS.length) + TRACK_IDS.length) % TRACK_IDS.length],
    startsAt: new Date(monday).toISOString(),
    endsAt: new Date(monday + WEEK_MS).toISOString()
  };
}

// Returns the weekly challenge a well-formed id refers to, or null.
function parseChallengeId(id) {
  if (typeof id !== 'string' || !DATE_RE.test(id)) return null;
  const ms = Date.parse(id + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== id) return null;
  if (new Date(ms).getUTCDay() !== 1 || ms < WEEK_ORIGIN) return null;
  return weeklyChallenge(ms);
}

// ---------- configuration ----------

function intEnv(env, key, def, min, max) {
  if (env[key] === undefined || env[key] === '') return def;
  const n = Number(env[key]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

function listEnv(env, key) {
  return String(env[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const origins = listEnv(env, 'RACING_ALLOWED_ORIGINS').map((o) => {
    let u;
    try { u = new URL(o); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || u.origin === 'null' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      throw new Error(`RACING_ALLOWED_ORIGINS entry must be a bare http(s) origin: ${o}`);
    }
    return u.origin;
  });
  return {
    host: env.RACING_HOST || '127.0.0.1',
    port: intEnv(env, 'RACING_PORT', 8787, 0, 65535),
    dataDir: path.resolve(env.RACING_DATA_DIR || path.join(os.homedir(), '.racing-lab-data')),
    allowedOrigins: origins,
    trustedProxies: listEnv(env, 'RACING_TRUSTED_PROXIES'),
    maxBodyBytes: intEnv(env, 'RACING_MAX_BODY_BYTES', 400 * 1024, 1024, 8 * 1024 * 1024),
    maxRecords: intEnv(env, 'RACING_MAX_RECORDS', 1000, 1, 100000),
    writeRateLimit: intEnv(env, 'RACING_WRITE_RATE_LIMIT', 20, 1, 100000),
    readRateLimit: intEnv(env, 'RACING_READ_RATE_LIMIT', 240, 1, 1000000),
    rateWindowMs: intEnv(env, 'RACING_RATE_WINDOW_MS', 60000, 1000, 3600000),
    maxRateKeys: 10000,
    now: () => Date.now(),
    logger: (msg) => console.error(msg)
  };
}

// ---------- validation ----------

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000;

function validateName(name) {
  if (typeof name !== 'string') throw new HttpError(400, 'invalid_name', 'name must be a string');
  const n = name.normalize('NFC').trim();
  if (!NAME_RE.test(n)) throw new HttpError(400, 'invalid_name', 'name must be 1-24 letters, numbers, spaces, dots, dashes or underscores');
  return n;
}

function validateTrack(id) {
  if (typeof id !== 'string' || !ALL_TRACK_IDS.includes(id)) throw new HttpError(400, 'invalid_track', 'unknown track');
  return id;
}

// Reads: any past or current weekly id that belongs to the track. Writes: only the current one.
function validateChallenge(id, trackId, nowMs, forWrite) {
  if (id === null || id === undefined || id === '') return null;
  const info = parseChallengeId(id);
  const weekIndex = info && ((Math.floor((Date.parse(info.startsAt) - WEEK_ORIGIN) / WEEK_MS) % 3) + 3) % 3;
  const archived = info && ARCHIVED_ROTATIONS.some(ids => ids[weekIndex] === trackId);
  if (!info || (info.trackId !== trackId && (forWrite || !archived))) throw new HttpError(400, 'invalid_challenge', 'unknown weekly challenge for this track');
  const current = weeklyChallenge(nowMs);
  if (Date.parse(info.startsAt) > Date.parse(current.startsAt)) throw new HttpError(400, 'invalid_challenge', 'weekly challenge has not started');
  if (forWrite && info.id !== current.id) throw new HttpError(409, 'challenge_expired', 'weekly challenge is closed');
  return info.id;
}

function validateLap(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'body must be a JSON object');
  const trackId = validateTrack(body.trackId);
  const challengeId = validateChallenge(body.challengeId === undefined ? null : body.challengeId, trackId, nowMs, true);
  const name = validateName(body.name);
  const ms = body.ms;
  if (!isNum(ms) || ms < LIMITS.minMs || ms > LIMITS.maxMs) throw new HttpError(400, 'invalid_time', `ms must be a number between ${LIMITS.minMs} and ${LIMITS.maxMs}`);
  const f = body.frames;
  if (!Array.isArray(f) || f.length < 2 || f.length > LIMITS.maxFrames) throw new HttpError(400, 'invalid_frames', `frames must be an array of 2-${LIMITS.maxFrames} samples`);
  const frames = new Array(f.length);
  let last = 0;
  for (let i = 0; i < f.length; i++) {
    const s = f[i];
    if (!Array.isArray(s) || s.length !== 4 || !s.every(isNum)) throw new HttpError(400, 'invalid_frames', `frame ${i} must be [elapsedMs,x,y,angle] with finite numbers`);
    if (s[0] < last) throw new HttpError(400, 'invalid_frames', 'frame times must not decrease');
    if (s[1] < 0 || s[1] > WORLD.width || s[2] < 0 || s[2] > WORLD.height) throw new HttpError(400, 'invalid_frames', 'frame position is outside the 900x560 world');
    if (Math.abs(s[3]) > LIMITS.maxAngle) throw new HttpError(400, 'invalid_frames', 'frame angle is out of range');
    last = s[0];
    frames[i] = [round3(s[0]), round3(s[1]), round3(s[2]), round3(s[3])];
  }
  if (f[0][0] !== 0) throw new HttpError(400, 'invalid_frames', 'first frame must be at 0 ms');
  if (Math.abs(last - ms) > 1) throw new HttpError(400, 'invalid_frames', 'last frame must match the lap time');
  return { trackId, challengeId, name, ms: round3(ms), frames };
}

// ---------- persistence ----------

// One small JSON file per driver+track+challenge record, written atomically
// (temp file, fsync, rename). All mutations run synchronously on the single
// event-loop thread, so check-and-replace is serialised and cannot drop a best.
function createStore(dir, maxRecords, logger) {
  const recDir = path.join(dir, 'records');
  const index = new Map(); // key -> {trackId, challengeId, name, ms, file}
  const keyOf = (t, c, name) => JSON.stringify([t, c, name.toLowerCase()]);
  const fileOf = (key) => crypto.createHash('sha256').update(key).digest('hex') + '.json';

  fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });
  for (const file of fs.readdirSync(recDir)) {
    if (!FILE_RE.test(file)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(recDir, file), 'utf8'));
      const name = validateName(r.name);
      validateTrack(r.trackId);
      if (r.challengeId !== null && !parseChallengeId(r.challengeId)) continue;
      if (!isNum(r.ms)) continue;
      const key = keyOf(r.trackId, r.challengeId, name);
      if (fileOf(key) !== file) continue;
      index.set(key, { trackId: r.trackId, challengeId: r.challengeId, name, ms: r.ms, file });
    } catch (e) { logger(`skipping unreadable record ${file}`); }
  }

  function writeAtomic(file, data) {
    fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(recDir, `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, path.join(recDir, file)); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }

  function prune(currentChallengeId) {
    for (const [key, r] of index) {
      if (r.challengeId !== null && r.challengeId !== currentChallengeId) {
        fs.rmSync(path.join(recDir, r.file), { force: true });
        index.delete(key);
      }
    }
  }

  return {
    size: () => index.size,
    leaderboard(trackId, challengeId) {
      return [...index.values()]
        .filter((r) => r.trackId === trackId && r.challengeId === challengeId)
        .sort((a, b) => a.ms - b.ms || a.name.localeCompare(b.name))
        .slice(0, LIMITS.boardSize)
        .map((r) => ({ name: r.name, ms: r.ms }));
    },
    ghost(trackId, challengeId, name) {
      const r = index.get(keyOf(trackId, challengeId, name));
      if (!r) return null;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(recDir, r.file), 'utf8'));
        return { ms: rec.ms, frames: rec.frames };
      } catch (e) { logger(`ghost read failed: ${e.code || e.message}`); return null; }
    },
    // Returns 'saved' | 'slower' | 'full'. The index only changes after the file is durable.
    submit(lap, currentChallengeId) {
      const key = keyOf(lap.trackId, lap.challengeId, lap.name);
      const old = index.get(key);
      if (old && !(lap.ms < old.ms)) return 'slower';
      if (!old && index.size >= maxRecords) {
        prune(currentChallengeId);
        if (index.size >= maxRecords) return 'full';
      }
      const file = fileOf(key);
      writeAtomic(file, JSON.stringify({ version: 1, trackId: lap.trackId, challengeId: lap.challengeId, name: lap.name, ms: lap.ms, frames: lap.frames, savedAt: new Date().toISOString() }));
      index.set(key, { trackId: lap.trackId, challengeId: lap.challengeId, name: lap.name, ms: lap.ms, file });
      return 'saved';
    }
  };
}

// ---------- rate limiting and client identity ----------

function createLimiter(max, windowMs, maxKeys, now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    if (hits.size >= maxKeys && !hits.has(key)) {
      for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      if (hits.size >= maxKeys) key = '*overflow*';
    }
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
    h.count++;
    return h.count <= max ? 0 : Math.max(1, Math.ceil((h.reset - t) / 1000));
  };
}

const stripV4 = (ip) => (ip || 'unknown').replace(/^::ffff:/, '');

function clientIp(req, trusted) {
  const peer = stripV4(req.socket.remoteAddress);
  if (!trusted.has(peer)) return peer;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => stripV4(s.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i])) return hops[i].slice(0, 64);
  return peer;
}

// ---------- HTTP ----------

function createServer(config) {
  const cfg = Object.assign(loadConfig({}), config);
  const logger = cfg.logger;
  const store = createStore(cfg.dataDir, cfg.maxRecords, logger);
  const origins = new Set(cfg.allowedOrigins);
  const trusted = new Set(cfg.trustedProxies.map(stripV4));
  const limitWrite = createLimiter(cfg.writeRateLimit, cfg.rateWindowMs, cfg.maxRateKeys, cfg.now);
  const limitRead = createLimiter(cfg.readRateLimit, cfg.rateWindowMs, cfg.maxRateKeys, cfg.now);
  // Presence is ephemeral and independently limited: driving must not consume the lap submission budget.
  const limitPresence = createLimiter(120, cfg.rateWindowMs, cfg.maxRateKeys, cfg.now);
  const sessions = new Map();
  const racers = new Map();
  const limitRacerWrite = createLimiter(1200, cfg.rateWindowMs, cfg.maxRateKeys, cfg.now);
  const limitRacerRead = createLimiter(1200, cfg.rateWindowMs, cfg.maxRateKeys, cfg.now);
  const RACER_TTL = 15000;
  function expireRacers() {
    for (const [id,racer] of racers) if(racer.expires <= cfg.now()) racers.delete(id);
  }
  function racerTrack(id) { return id === 'legacy' ? id : validateTrack(id); }
  async function postRacer(req,res) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new HttpError(415,'unsupported_media_type','content-type must be application/json');
    let body;
    try { body=JSON.parse(await readBody(req,res,4096)); } catch(e) {
      if(e instanceof HttpError)throw e;
      throw new HttpError(400,'invalid_json','body is not valid JSON');
    }
    if(!body || typeof body!=='object' || Array.isArray(body) || typeof body.sessionId!=='string' ||
      !/^[a-f0-9]{32}$/.test(body.sessionId) || !Number.isSafeInteger(body.sequence) || body.sequence<1 ||
      typeof body.driving!=='boolean' || (body.leaving!==undefined && typeof body.leaving!=='boolean') ||
      ![body.x,body.y,body.angle].every(isNum) || body.x<0 || body.x>900 || body.y<0 || body.y>560 || Math.abs(body.angle)>Math.PI+0.001)
      throw new HttpError(400,'invalid_racer','invalid racer state');
    const trackId=racerTrack(body.trackId), name=validateName(body.name);
    if(Array.from(name).length>20)throw new HttpError(400,'invalid_racer','racer name too long');
    expireRacers();const old=racers.get(body.sessionId);
    if(old && old.sequence>=body.sequence)return send(res,200,{ok:true});
    if(!old && !body.leaving && racers.size>=2000)throw new HttpError(503,'racers_full','live car capacity reached');
    if(old || !body.leaving) racers.set(body.sessionId,{sessionId:body.sessionId,sequence:body.sequence,trackId,name,
      x:round3(body.x),y:round3(body.y),angle:round3(body.angle),driving:body.driving,leaving:body.leaving===true,expires:cfg.now()+RACER_TTL});
    send(res,200,{ok:true});
  }
  function getRacers(url,res) {
    const trackId=racerTrack(url.searchParams.get('track'));expireRacers();
    const peers=[...racers.values()].filter(r=>r.trackId===trackId && !r.leaving).slice(0,50)
      .map(({expires,leaving,...r})=>r);
    send(res,200,{racers:peers});
  }
  const PRESENCE_TTL = 45000, MAX_SESSIONS = 2000;
  function expirePresence() {
    const now = cfg.now();
    for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id);
  }
  async function postPresence(req, res) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
      throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
    let body;
    try { body = JSON.parse(await readBody(req, res)); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid_json', 'body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(body.sessionId) ||
        typeof body.active !== 'boolean' || !Number.isSafeInteger(body.sequence) || body.sequence < 1)
      throw new HttpError(400, 'invalid_presence', 'invalid presence session');
    const trackId = validateTrack(body.trackId);
    expirePresence();
    const previous = sessions.get(body.sessionId);
    if (previous && body.sequence <= previous.sequence) return send(res, 200, {ok:true});
    if (body.active || previous) {
      if (!previous && sessions.size >= MAX_SESSIONS) throw new HttpError(503, 'presence_full', 'presence capacity reached');
      // Retain inactive tombstones until expiry so delayed older heartbeats cannot undo a leave.
      sessions.set(body.sessionId, {trackId,active:body.active,sequence:body.sequence,expires:cfg.now()+PRESENCE_TTL});
    }
    send(res, 200, {ok:true});
  }
  function getPresence(res) {
    expirePresence();
    const counts = Object.fromEntries(ALL_TRACK_IDS.map(id=>[id,0]));
    const seen = new Set();
    for (const [id,session] of sessions) if (session.active) {counts[session.trackId]++;seen.add(id);}
    expireRacers();
    for (const [id,racer] of racers) if (!racer.leaving && racer.driving && !seen.has(id) && racer.trackId in counts) counts[racer.trackId]++;
    send(res, 200, {counts});
  }

  function send(res, status, body, extra) {
    const data = status === 204 ? '' : JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, res.corsHeaders, extra));
    res.end(data);
  }

  function readBody(req, res, maximum = cfg.maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      const chunks = [];
      let size = 0;
      let over = false;
      const reject413 = () => {
        over = true;
        reject(new HttpError(413, 'payload_too_large', `body exceeds ${maximum} bytes`));
      };
      if (declared > maximum) reject413();
      req.on('data', (c) => {
        size += c.length;
        if (over) { if (size > DRAIN_LIMIT) req.destroy(); return; }
        if (size > maximum) { chunks.length = 0; reject413(); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { if (!over) reject(new HttpError(400, 'bad_request', 'request aborted')); });
    });
  }

  async function postLap(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
    const text = await readBody(req, res);
    let body;
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json', 'body is not valid JSON'); }
    const nowMs = cfg.now();
    const lap = validateLap(body, nowMs);
    const result = store.submit(lap, weeklyChallenge(nowMs).id);
    if (result === 'full') throw new HttpError(503, 'storage_full', 'record limit reached; try again later');
    send(res, 200, { saved: result === 'saved' });
  }

  function getLeaderboard(url, res) {
    const trackId = validateTrack(url.searchParams.get('track'));
    const challengeId = validateChallenge(url.searchParams.get('challenge'), trackId, cfg.now(), false);
    send(res, 200, { entries: store.leaderboard(trackId, challengeId), verified: false });
  }

  function getGhost(url, res) {
    const trackId = validateTrack(url.searchParams.get('track'));
    const challengeId = validateChallenge(url.searchParams.get('challenge'), trackId, cfg.now(), false);
    const name = validateName(url.searchParams.get('name'));
    const ghost = store.ghost(trackId, challengeId, name);
    if (!ghost) throw new HttpError(404, 'not_found', 'no ghost for this driver');
    send(res, 200, ghost);
  }

  async function handle(req, res) {
    const origin = req.headers.origin;
    res.corsHeaders = {};
    if (origin !== undefined && origins.has(origin)) {
      res.corsHeaders = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    } else if (origin !== undefined) {
      res.corsHeaders = { Vary: 'Origin' };
    }
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const routes = { '/api/health': ['GET'], '/api/leaderboard': ['GET'], '/api/ghost': ['GET'], '/api/laps': ['POST'], '/api/presence': ['GET', 'POST'], '/api/racers': ['GET', 'POST'] };
    if (!routes[route]) throw new HttpError(404, 'not_found', 'unknown endpoint');
    if (req.method === 'OPTIONS') {
      if (origin === undefined || !origins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'origin is not allowed');
      return send(res, 204, null, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    }
    if (!routes[route].includes(req.method)) {
      throw Object.assign(new HttpError(405, 'method_not_allowed', 'method not allowed'), { allow: routes[route].join(', ') });
    }
    const ip = clientIp(req, trusted);
    if (req.method === 'POST') {
      if (origin === undefined || !origins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'origin is not allowed');
      const wait = route === '/api/racers' ? limitRacerWrite(ip) : route === '/api/presence' ? limitPresence(ip) : limitWrite(ip);
      if (wait) throw Object.assign(new HttpError(429, 'rate_limited', 'too many submissions'), { retryAfter: wait });
      return route === '/api/racers' ? postRacer(req,res) : route === '/api/presence' ? postPresence(req, res) : postLap(req, res);
    }
    const wait = route === '/api/racers' ? limitRacerRead(ip) : limitRead(ip);
    if (wait) throw Object.assign(new HttpError(429, 'rate_limited', 'too many requests'), { retryAfter: wait });
    if (route === '/api/racers') return getRacers(url,res);
    if (route === '/api/presence') return getPresence(res);
    if (route === '/api/health') return send(res, 200, { ok: true, verified: false });
    if (route === '/api/leaderboard') return getLeaderboard(url, res);
    return getGhost(url, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) {
        const extra = {};
        if (e.allow) extra.Allow = e.allow;
        if (e.retryAfter) extra['Retry-After'] = String(e.retryAfter);
        return send(res, e.status, { error: e.code, message: e.message }, extra);
      }
      logger(`internal error: ${e && e.code ? e.code : 'unexpected'} ${req.method}`);
      send(res, 500, { error: 'internal_error', message: 'internal server error' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

const HELP = `Racing Lab API (community scores, unverified)
Usage: node server/server.cjs [--help]
Environment:
  RACING_HOST             bind address (default 127.0.0.1)
  RACING_PORT             port (default 8787)
  RACING_DATA_DIR         data directory outside the web root (default ~/.racing-lab-data)
  RACING_ALLOWED_ORIGINS  comma-separated bare origins allowed to write, e.g. https://example.github.io
  RACING_TRUSTED_PROXIES  comma-separated proxy IPs whose X-Forwarded-For is trusted (default none)
  RACING_MAX_BODY_BYTES   request body limit (default 409600)
  RACING_MAX_RECORDS      max stored driver records (default 1000)
  RACING_WRITE_RATE_LIMIT / RACING_READ_RATE_LIMIT  requests per window per client (20 / 240)
  RACING_RATE_WINDOW_MS   rate window in ms (default 60000)
See server/README.md.`;

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); return; }
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error(e.message); process.exit(2); }
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`racing-lab api listening on ${config.host}:${server.address().port}`);
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, loadConfig, weeklyChallenge, parseChallengeId, TRACK_IDS };

if (require.main === module) main();
