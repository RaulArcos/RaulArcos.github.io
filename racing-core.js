// racing-core.js — Racing Lab core (browser global RacingLabCore + CommonJS).
// Tracks, weekly challenge, DOM-free race session (physics + lap timing), ghost recorder/playback,
// score/ghost persistence and the optional community API client. No dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RacingLabCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // ── Physics (pakastin/car values, shared with the legacy circuit) ─────────
  const PHYS = {
    MAX_POWER: 0.075, MAX_REVERSE: 0.0375, POWER_FACTOR: 0.001, REV_FACTOR: 0.0005,
    DRAG: 0.95, ANG_DRAG: 0.95, TURN_SPEED: 0.002, HZ: 120,
  };
  const STEP_MS = 1000 / PHYS.HZ;
  const CAR_R = 6;
  const GATE_PAD = 14;
  // Terminal speed of the car model in px/s: v = power * drag / (1 - drag) per step.
  const TOP_SPEED_PPS = (PHYS.MAX_POWER * PHYS.DRAG / (1 - PHYS.DRAG)) * PHYS.HZ;

  // ── Limits ────────────────────────────────────────────────────────────────
  const FRAME_INTERVAL_MS = 80;
  const MAX_LAP_MS = 180000;                     // longest lap that is scored (matches the API)
  // Derived, not hand-picked: one frame per interval for a full-length lap, plus the start and finish frames.
  const MAX_FRAMES = Math.ceil(MAX_LAP_MS / FRAME_INTERVAL_MS) + 2;
  const MAX_SCORES = 100;
  const MAX_NAME = 20;
  const MAX_RESPONSE_CHARS = 200000;
  const WORLD = { width: 900, height: 560 };     // every track lives inside this box
  const STORE_PREFIX = 'rah-racing-v4';

  // ── Small helpers ─────────────────────────────────────────────────────────
  const round1 = v => Math.round(v * 10) / 10;
  const round3 = v => { const n = Math.round(v * 1000) / 1000; return Object.is(n, -0) ? 0 : n; };
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const normAngle = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

  // Names are shown as text only; also keep to the charset the community API accepts.
  function cleanName(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[^\p{L}\p{N}]+/u, '');
    return Array.from(s).slice(0, MAX_NAME).join('').trim();
  }
  const nameKey = raw => cleanName(raw).toUpperCase();

  // ── Geometry ──────────────────────────────────────────────────────────────
  function nearestOnRing(points, px, py) {
    const n = points.length;
    let bd = Infinity, bx = 0, by = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      let x = a[0], y = a[1];
      if (l2) {
        const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
        x = a[0] + t * dx; y = a[1] + t * dy;
      }
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; bx = x; by = y; }
    }
    return { dist: bd, nx: bx, ny: by };
  }

  // Strict legacy intersection test (kept byte-for-byte compatible with the original game).
  function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay, d2x = dx - cx, d2y = dy - cy;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }

  // Gate across the track at points[i]; ring-closed (no duplicated first point).
  function makeGate(points, i, width) {
    const m = points.length;
    const a = points[i], prev = points[(i - 1 + m) % m], next = points[(i + 1) % m];
    const dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const ndx = dx / len, ndy = dy / len;
    const px = -ndy, py = ndx;
    const half = width / 2 + GATE_PAD;
    return { x1: a[0] + px * half, y1: a[1] + py * half, x2: a[0] - px * half, y2: a[1] - py * half, dirX: ndx, dirY: ndy };
  }

  // Crossing of the move a→b through a gate: {t in (0,1], forward} or null. Half-open on t so a
  // car landing exactly on the line is counted once, never skipped on two consecutive steps.
  function gateCrossing(ax, ay, bx, by, g) {
    const d1x = bx - ax, d1y = by - ay, d2x = g.x2 - g.x1, d2y = g.y2 - g.y1;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((g.x1 - ax) * d2y - (g.y1 - ay) * d2x) / den;
    const u = ((g.x1 - ax) * d1y - (g.y1 - ay) * d1x) / den;
    if (!(t > 0 && t <= 1 && u >= 0 && u <= 1)) return null;
    return { t, forward: d1x * g.dirX + d1y * g.dirY > 0 };
  }

  // Centripetal Catmull-Rom through a closed list of control points → dense ring.
  function smoothRing(ctrl, perSeg) {
    const n = ctrl.length, out = [];
    const lerp = (p, q, w) => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
    for (let i = 0; i < n; i++) {
      const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
      const t0 = 0;
      const t1 = t0 + Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
      const t2 = t1 + Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
      const t3 = t2 + Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
      for (let k = 0; k < perSeg; k++) {
        const t = t1 + (t2 - t1) * (k / perSeg);
        const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
        const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
        const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
        const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
        const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
        out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
      }
    }
    return out;
  }

  // Uniform arc-length resampling of a closed ring (first point preserved, not repeated at the end).
  function resampleRing(ring, spacing) {
    const n = ring.length, cum = [0];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[n], count = Math.max(8, Math.round(total / spacing)), step = total / count;
    const out = [];
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const s = k * step;
      while (seg < n - 1 && cum[seg + 1] < s) seg++;
      const a = ring[seg], b = ring[(seg + 1) % n];
      const w = (s - cum[seg]) / ((cum[seg + 1] - cum[seg]) || 1);
      out.push([round1(a[0] + (b[0] - a[0]) * w), round1(a[1] + (b[1] - a[1]) * w)]);
    }
    return out;
  }

  function ringLength(points) {
    let len = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return len;
  }

  // Geometry report used by the tests (and handy when designing tracks).
  //  selfIntersections: proper crossings between non-adjacent segments
  //  minClearance: closest approach of centerline parts that are far apart along the lap
  //  minRadius: tightest circumradius sampled at ±2 points
  function analyzeTrack(track) {
    const pts = track.points, n = pts.length, w = track.width;
    const segLen = pts.map((a, i) => Math.hypot(pts[(i + 1) % n][0] - a[0], pts[(i + 1) % n][1] - a[1]));
    const cum = [0];
    segLen.forEach((l, i) => cum.push(cum[i] + l));
    const total = cum[n];
    const arcSep = (i, j) => { const d = Math.abs(cum[i] - cum[j]); return Math.min(d, total - d); };

    let selfIntersections = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
        if (segsIntersect(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) selfIntersections++;
      }
    }
    let minClearance = Infinity;
    const farArc = 2.5 * w;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (arcSep(i, j) < farArc && arcSep(i, (j + 1) % n) < farArc) continue;
        const a = pts[j], b = pts[(j + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((pts[i][0] - a[0]) * dx + (pts[i][1] - a[1]) * dy) / l2));
        minClearance = Math.min(minClearance, Math.hypot(pts[i][0] - a[0] - t * dx, pts[i][1] - a[1] - t * dy));
      }
    }
    let minRadius = Infinity, maxSegTurn = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[(i - 2 + n) % n], q = pts[i], r = pts[(i + 2) % n];
      const ab = Math.hypot(q[0] - p[0], q[1] - p[1]), bc = Math.hypot(r[0] - q[0], r[1] - q[1]), ca = Math.hypot(p[0] - r[0], p[1] - r[1]);
      const area2 = Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
      if (area2 > 1e-9) minRadius = Math.min(minRadius, (ab * bc * ca) / (2 * area2));
      const u = pts[(i + 1) % n], h1 = Math.atan2(q[1] - pts[(i - 1 + n) % n][1], q[0] - pts[(i - 1 + n) % n][0]);
      const h2 = Math.atan2(u[1] - q[1], u[0] - q[0]);
      maxSegTurn = Math.max(maxSegTurn, Math.abs(normAngle(h2 - h1)));
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    return { length: total, selfIntersections, minClearance, minRadius, maxSegTurn, minX, minY, maxX, maxY };
  }

  // ── Tracks ────────────────────────────────────────────────────────────────
  // Control points are hand-placed, closed and clockwise; `points` is the smoothed, evenly
  // spaced playable centerline (index 0 = start/finish line). `sectors` are indices into points.
  const TRACK_SPECS = [
    {
      id: 'cadiz-city-v3', name: 'Cádiz City', difficulty: 'Medium', width: 60, spacing: 14,
      description: 'Cádiz coastline: La Caleta and Genovés around the old town, Puerta de Tierra, Playa Victoria and Cortadura.',
      controls: [[605,365],[740,435],[785,470],[770,505],[715,500],[600,460],[520,390],[425,320],[350,285],[280,305],[210,295],[155,270],[110,235],[110,200],[150,190],[175,170],[180,135],[205,105],[250,85],[285,70],[365,70],[415,90],[440,125],[420,155],[390,160],[385,185],[415,215],[455,230],[510,295]],
      geography: ['La Caleta','Parque Genovés','Puerta de Tierra','Playa Victoria','Cortadura'],
      sectorFractions: [0.25, 0.5, 0.75],
    },
    {
      id: 'spa-francorchamps-v3', name: 'Spa-Francorchamps', difficulty: 'Hard', width: 58, spacing: 14,
      description: 'A simplified Spa outline: La Source, Eau Rouge, Kemmel, Pouhon and Blanchimont.',
      controls: [[510,80],[705,85],[765,115],[785,155],[765,185],[775,220],[740,265],[680,250],[640,290],[635,340],[605,370],[590,400],[620,430],[680,435],[750,435],[785,460],[785,495],[750,510],[620,500],[450,465],[310,390],[220,305],[175,290],[130,290],[105,260],[115,225],[145,205],[155,165],[135,110],[140,70],[185,65],[225,100],[250,140],[280,150],[315,120],[350,100]],
      sectorFractions: [0.25, 0.5, 0.75],
    },
    {
      id: 'noob-gp-v3', name: 'Noob GP', difficulty: 'Easy', width: 78, spacing: 20,
      description: 'Long mountain grand prix: sweeping esses, a downhill double-apex and a fast final bend.',
      controls: [[520, 70], [700, 85], [810, 150], [800, 240], [748, 300], [778, 372], [740, 450], [640, 500], [500, 470], [380, 500], [250, 490], [140, 430], [108, 350], [152, 300], [125, 235], [122, 132], [200, 85], [300, 75]],
      sectorFractions: [0.25, 0.5, 0.75],
    },
  ];

  function buildTrack(spec) {
    const points = resampleRing(smoothRing(spec.controls, 48), spec.spacing);
    const n = points.length, width = spec.width;
    const length = ringLength(points);
    const cum = [0];
    for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(points[(i + 1) % n][0] - points[i][0], points[(i + 1) % n][1] - points[i][1]));
    const sectors = spec.sectorFractions.map(f => {
      let best = 1;
      for (let i = 1; i < n; i++) if (Math.abs(cum[i] - f * length) < Math.abs(cum[best] - f * length)) best = i;
      return best;
    });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const pad = width / 2 + 24;
    const x0 = Math.max(0, Math.floor(minX - pad)), y0 = Math.max(0, Math.floor(minY - pad));
    const bounds = { x: x0, y: y0, w: Math.min(WORLD.width, Math.ceil(maxX + pad)) - x0, h: Math.min(WORLD.height, Math.ceil(maxY + pad)) - y0 };
    // Spawn a few car lengths before the line so the first timed lap is a flying lap.
    const si = (n - 8 + n) % n, sp = points[si], ahead = points[(si + 1) % n];
    const spawn = { x: sp[0], y: sp[1], angle: Math.atan2(ahead[0] - sp[0], -(ahead[1] - sp[1])) };
    const track = {
      id: spec.id, name: spec.name, difficulty: spec.difficulty, description: spec.description,
      points, width, sectors, bounds, spawn, startIndex: 0, length: Math.round(length),
      minLapMs: Math.max(5000, Math.round(length / TOP_SPEED_PPS * 1000 * 0.7)),
      controls: spec.controls,
    };
    if (spec.geography) track.geography = spec.geography.slice();
    return track;
  }

  const tracks = TRACK_SPECS.map(buildTrack);
  const TRACK_IDS = tracks.map(t => t.id);
  const trackById = id => tracks.find(t => t.id === id) || null;
  // Historical score namespaces stay readable; changed layouts never reuse their keys.
  const isTrackId = id => typeof id === 'string' && (TRACK_IDS.includes(id) || ['cadiz-sprint', 'harbor-technical', 'cadiz-city-v1', 'spa-francorchamps-v1', 'sierra-gp', 'cadiz-city-v2', 'spa-francorchamps-v2', 'noob-gp-v2'].includes(id));

  // ── Weekly challenge (UTC Monday 00:00 → next Monday) ─────────────────────
  const DAY_MS = 86400000, WEEK_MS = 7 * DAY_MS;
  const WEEK_ORIGIN = Date.UTC(2026, 0, 5);      // a Monday; week 0 of the track rotation

  function toMs(date) {
    let ms;
    if (date === undefined) ms = Date.now();
    else if (date instanceof Date) ms = date.getTime();
    else if (typeof date === 'number') ms = date;
    else if (typeof date === 'string') ms = Date.parse(date);
    else ms = NaN;
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new RangeError('weeklyChallenge: invalid date');
    return ms;
  }

  // Returns {id,trackId,startsAt,endsAt} (+ startsAtMs/endsAtMs). id is the Monday's UTC date.
  function weeklyChallenge(date) {
    const t = new Date(toMs(date));
    const dayStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    const monday = dayStart - ((t.getUTCDay() + 6) % 7) * DAY_MS;
    const weeks = Math.floor((monday - WEEK_ORIGIN) / WEEK_MS);
    return {
      id: new Date(monday).toISOString().slice(0, 10),
      trackId: TRACK_IDS[((weeks % TRACK_IDS.length) + TRACK_IDS.length) % TRACK_IDS.length],
      startsAt: new Date(monday).toISOString(),
      endsAt: new Date(monday + WEEK_MS).toISOString(),
      startsAtMs: monday,
      endsAtMs: monday + WEEK_MS,
    };
  }
  const isChallengeId = id => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(id) &&
    Number.isFinite(Date.parse(id + 'T00:00:00Z')) && new Date(id + 'T00:00:00Z').toISOString().slice(0, 10) === id &&
    new Date(id + 'T00:00:00Z').getUTCDay() === 1;

  // ── Car physics ───────────────────────────────────────────────────────────
  function createCar(track) {
    return { x: track.spawn.x, y: track.spawn.y, vx: 0, vy: 0, angle: track.spawn.angle, angVel: 0, power: 0, reverse: 0, wallMult: 1 };
  }

  // One 1/120 s step. Same mechanics (and order of operations) as the original game.
  function stepCar(car, c, track) {
    const canTurn = car.power > 0.0025 || car.reverse > 0;
    const dir = car.power >= car.reverse ? 1 : -1;
    car.power = Math.max(0, Math.min(PHYS.MAX_POWER, car.power + (c.up ? PHYS.POWER_FACTOR : -PHYS.POWER_FACTOR)));
    car.reverse = Math.max(0, Math.min(PHYS.MAX_REVERSE, car.reverse + (c.down ? PHYS.REV_FACTOR : -PHYS.REV_FACTOR)));
    if (canTurn) {
      if (c.left) car.angVel -= dir * PHYS.TURN_SPEED;
      if (c.right) car.angVel += dir * PHYS.TURN_SPEED;
    }
    const thrust = (car.power - car.reverse) * car.wallMult;
    car.vx += Math.sin(car.angle) * thrust;
    car.vy -= Math.cos(car.angle) * thrust;
    car.vx *= PHYS.DRAG; car.vy *= PHYS.DRAG; car.angVel *= PHYS.ANG_DRAG;
    car.wallMult = Math.min(1, car.wallMult + 0.003);
    car.x += car.vx; car.y += car.vy; car.angle += car.angVel;

    // Wall: slow down, never hard-stop
    const near = nearestOnRing(track.points, car.x, car.y), limit = track.width / 2 - CAR_R;
    if (near.dist > limit && near.dist > 0) {
      const nx = (car.x - near.nx) / near.dist, ny = (car.y - near.ny) / near.dist;
      const push = near.dist - limit;
      car.x -= nx * push * 1.05; car.y -= ny * push * 1.05;
      const dot = car.vx * nx + car.vy * ny;
      if (dot > 0) { car.vx -= 1.7 * dot * nx; car.vy -= 1.7 * dot * ny; }
      const spd = Math.hypot(car.vx, car.vy);
      if (spd > 0.15) { car.vx *= 0.38; car.vy *= 0.38; car.angVel *= 0.55; car.wallMult = Math.max(0.12, car.wallMult - 0.22); }
      else { car.vx *= 0.65; car.vy *= 0.65; car.wallMult = Math.max(0.20, car.wallMult - 0.06); }
    }
  }

  // ── Ghost recorder / playback ─────────────────────────────────────────────
  // Frames are [elapsedMs, x, y, angle]; sampled at bounded intervals, capped at MAX_FRAMES.
  function createRecorder() {
    let frames = [], overflow = false, last = -Infinity;
    const frame = (e, x, y, a) => [Math.round(e), round1(x), round1(y), round3(normAngle(a))];
    return {
      begin(x, y, a) { frames = [frame(0, x, y, a)]; overflow = false; last = 0; },
      sample(elapsed, x, y, a) {
        if (overflow || elapsed - last < FRAME_INTERVAL_MS) return;
        if (frames.length >= MAX_FRAMES - 1) { overflow = true; return; }   // keep one slot for the final frame
        frames.push(frame(elapsed, x, y, a)); last = elapsed;
      },
      finish(ms, x, y, a) {
        if (overflow || !frames.length) return null;
        const f = frame(ms, x, y, a), tail = frames[frames.length - 1];
        if (f[0] <= tail[0]) frames.pop();                                 // keep times strictly increasing
        frames.push(f);
        return frames.slice();
      },
      get length() { return frames.length; },
      get overflowed() { return overflow; },
    };
  }

  // Interpolated {x,y,angle} at lap time t; clamps to the first/last frame.
  function ghostAt(frames, t) {
    if (!Array.isArray(frames) || !frames.length) return null;
    const pick = f => ({ x: f[1], y: f[2], angle: f[3] });
    if (!(t > frames[0][0])) return pick(frames[0]);
    const lastF = frames[frames.length - 1];
    if (t >= lastF[0]) return pick(lastF);
    let lo = 0, hi = frames.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid][0] <= t) lo = mid; else hi = mid; }
    const a = frames[lo], b = frames[hi], w = (t - a[0]) / (b[0] - a[0]);
    return { x: a[1] + (b[1] - a[1]) * w, y: a[2] + (b[2] - a[2]) * w, angle: a[3] + normAngle(b[3] - a[3]) * w };
  }

  // Validates a ghost {ms,frames} from storage or the network against a track; returns a clean copy or null.
  function sanitizeGhost(obj, track) {
    if (!obj || typeof obj !== 'object' || !track || !track.bounds) return null;
    const ms = obj.ms, fr = obj.frames, b = track.bounds;
    if (!isNum(ms) || ms < track.minLapMs || ms > MAX_LAP_MS) return null;
    if (!Array.isArray(fr) || fr.length < 2 || fr.length > MAX_FRAMES) return null;
    const out = [];
    let prev = -1;
    for (const f of fr) {
      if (!Array.isArray(f) || f.length !== 4 || !f.every(isNum)) return null;
      if (f[0] <= prev || f[1] < b.x || f[1] > b.x + b.w || f[2] < b.y || f[2] > b.y + b.h || Math.abs(f[3]) > 7) return null;
      prev = f[0];
      out.push([Math.round(f[0]), round1(f[1]), round1(f[2]), round3(f[3])]);
    }
    if (out[0][0] !== 0 || Math.abs(out[out.length - 1][0] - ms) > 2) return null;
    return { ms: Math.round(ms), frames: out };
  }

  // ── Race session (no DOM) ─────────────────────────────────────────────────
  // New tracks: simulated clock (deterministic), ordered sector gates, flying start.
  // `track.legacy`: original rules — wall clock, any-order sectors, 200-step cooldown, 5 s minimum.
  function createSession(opts) {
    const track = opts.track, legacy = !!track.legacy;
    const wallNow = opts.wallNow || (() => Date.now());
    const car = createCar(track);
    const finishGate = makeGate(track.points, track.startIndex || 0, track.width);
    const gates = track.sectors.map(i => makeGate(track.points, i, track.width));
    const rec = createRecorder();
    const S = {
      car, simMs: 0, running: false, lapCount: 0, lapStart: null,
      nextSector: 0, sectorsOk: new Set(), cooldown: legacy ? 200 : 0, reversed: false,
    };

    function restartLap(tStart, x, y, a) {
      S.lapStart = tStart; S.nextSector = 0; S.sectorsOk.clear();
      if (!legacy) rec.begin(x, y, a);
    }

    function stepLegacy(px, py) {
      gates.forEach((g, i) => {
        if (S.sectorsOk.has(i)) return;
        if (segsIntersect(px, py, car.x, car.y, g.x1, g.y1, g.x2, g.y2))
          if ((car.x - px) * g.dirX + (car.y - py) * g.dirY > 0) S.sectorsOk.add(i);
      });
      if (S.cooldown > 0) { S.cooldown--; return null; }
      const fg = finishGate;
      if (!segsIntersect(px, py, car.x, car.y, fg.x1, fg.y1, fg.x2, fg.y2)) return null;
      if (!((car.x - px) * fg.dirX + (car.y - py) * fg.dirY > 0)) return null;
      if (!S.running) {
        S.running = true; S.lapCount = 0; S.lapStart = wallNow(); S.sectorsOk.clear();
        return { type: 'start' };
      }
      const allSectors = S.sectorsOk.size >= gates.length, lapMs = wallNow() - S.lapStart;
      if (allSectors && lapMs >= track.minLapMs) {
        S.lapCount++; S.lapStart = wallNow(); S.sectorsOk.clear();
        return { type: 'lap', ms: lapMs, lap: S.lapCount, frames: null };
      }
      S.lapStart = wallNow(); S.sectorsOk.clear();
      return { type: 'invalid', reason: allSectors ? 'slow' : 'shortcut' };
    }

    function stepTimed(px, py, pa, t0) {
      if (S.running && S.nextSector < gates.length) {
        const sx = gateCrossing(px, py, car.x, car.y, gates[S.nextSector]);
        if (sx && sx.forward) { S.nextSector++; S.sectorsOk.add(S.nextSector - 1); }
      }
      const fx = gateCrossing(px, py, car.x, car.y, finishGate);
      if (!fx) return null;
      if (!fx.forward) { S.reversed = true; return null; }
      if (S.reversed) { S.reversed = false; return null; }        // re-crossing after backing over the line
      const tCross = t0 + fx.t * STEP_MS;
      const cx = px + (car.x - px) * fx.t, cy = py + (car.y - py) * fx.t, ca = pa + (car.angle - pa) * fx.t;
      if (!S.running) {
        S.running = true; S.lapCount = 0; restartLap(tCross, cx, cy, ca);
        return { type: 'start' };
      }
      const lapMs = tCross - S.lapStart, allSectors = S.nextSector >= gates.length;
      if (allSectors && lapMs >= track.minLapMs) {
        const ms = Math.round(lapMs);
        const frames = rec.finish(ms, cx, cy, ca);
        S.lapCount++; restartLap(tCross, cx, cy, ca);
        return { type: 'lap', ms, lap: S.lapCount, frames };
      }
      restartLap(tCross, cx, cy, ca);
      return { type: 'invalid', reason: allSectors ? 'slow' : 'shortcut' };
    }

    S.step = function (input) {
      const t0 = S.simMs;
      S.simMs += STEP_MS;
      const px = car.x, py = car.y, pa = car.angle;
      stepCar(car, input, track);
      const ev = legacy ? stepLegacy(px, py) : stepTimed(px, py, pa, t0);
      if (!legacy && S.running) rec.sample(S.simMs - S.lapStart, car.x, car.y, car.angle);
      return ev;
    };
    // Lap time so far (null before the first line crossing).
    S.elapsed = () => !S.running ? null : legacy ? wallNow() - S.lapStart : S.simMs - S.lapStart;
    // Move the wall-clock lap start forward after a pause (the simulated clock needs no help).
    S.shiftClock = ms => { if (legacy && S.running) S.lapStart += ms; };
    S.recorder = rec; S.track = track;
    S.gates = gates; S.finishGate = finishGate;
    return S;
  }

  // ── Persistence (injected Storage-like object; every failure is tolerated) ─
  function safeGet(storage, key) {
    try { const v = storage && storage.getItem(key); return v == null ? null : JSON.parse(v); } catch { return null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function scopeOf(trackId, challengeId) {
    if (!isTrackId(trackId)) throw new RangeError('unknown track: ' + trackId);   // legacy has its own storage
    if (challengeId != null && !isChallengeId(challengeId)) throw new RangeError('bad challenge id');
    return challengeId ? trackId + '@' + challengeId : trackId;
  }
  const scoresKey = scope => `${STORE_PREFIX}:scores:${scope}`;
  const ghostKey = (scope, name) => `${STORE_PREFIX}:ghost:${scope}:${nameKey(name)}`;

  const validMs = ms => isNum(ms) && ms >= 1000 && ms <= MAX_LAP_MS;

  // Parses an untrusted entry list ({name,ms}…) into a sorted, de-duplicated, capped board.
  function parseBoard(list, max) {
    if (!Array.isArray(list)) return [];
    const best = new Map();
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const name = cleanName(e.name), ms = e.ms;
      if (!name || !validMs(ms)) continue;
      const k = name.toUpperCase(), prev = best.get(k);
      if (!prev || ms < prev.ms) best.set(k, { name, ms });
    }
    return Array.from(best.values()).sort((a, b) => a.ms - b.ms || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, max || MAX_SCORES);
  }

  function loadScores(storage, trackId, challengeId) {
    const data = safeGet(storage, scoresKey(scopeOf(trackId, challengeId)));
    return parseBoard(data && data.entries, MAX_SCORES);
  }

  function recordScore(storage, trackId, challengeId, name, ms) {
    const nm = cleanName(name);
    if (!nm || !validMs(ms)) return { improved: false, persisted: false, best: null };
    const entries = loadScores(storage, trackId, challengeId);
    const old = entries.find(e => e.name.toUpperCase() === nm.toUpperCase());
    if (old && !(ms < old.ms)) return { improved: false, persisted: true, best: old.ms };
    const next = parseBoard(entries.filter(e => e !== old).concat({ name: nm, ms }), MAX_SCORES);
    const persisted = safeSet(storage, scoresKey(scopeOf(trackId, challengeId)), { v: 1, entries: next });
    return { improved: true, persisted, best: ms };
  }

  function loadGhost(storage, trackId, challengeId, name) {
    const track = trackById(trackId);
    if (!track || !nameKey(name)) return null;
    return sanitizeGhost(safeGet(storage, ghostKey(scopeOf(trackId, challengeId), name)), track);
  }

  // Replaces the stored ghost only when the new lap is strictly faster (or none/corrupt exists).
  function saveGhostIfBetter(storage, trackId, challengeId, name, ms, frames) {
    const track = trackById(trackId), fresh = track && sanitizeGhost({ ms, frames }, track);
    if (!fresh || !nameKey(name)) return { improved: false, persisted: false, ghost: null };
    const old = loadGhost(storage, trackId, challengeId, name);
    if (old && !(fresh.ms < old.ms)) return { improved: false, persisted: true, ghost: old };
    const persisted = safeSet(storage, ghostKey(scopeOf(trackId, challengeId), name), fresh);
    return { improved: true, persisted, ghost: fresh };
  }

  // Everything to do after a valid lap on a new track.
  function recordLap(storage, lap) {
    const score = recordScore(storage, lap.trackId, lap.challengeId, lap.name, lap.ms);
    const ghost = lap.frames ? saveGhostIfBetter(storage, lap.trackId, lap.challengeId, lap.name, lap.ms, lap.frames)
                             : { improved: false, persisted: false, ghost: null };
    return { score, ghost };
  }

  // Visual-only playout buffer. Networking, raw positions, lap timing and physics stay unchanged.
  // Render350ms behind received snapshots; predict at most120ms to bridge brief jitter.
  function createPeerInterpolator() {
    const frames = [], DELAY_MS = 350, MAX_AHEAD_MS = 120, MAX_FRAMES = 12;
    const pose = f => ({x:f.x,y:f.y,angle:f.angle});
    return {
      push(peer, time) {
        if (!Number.isFinite(time) || ![peer.x,peer.y,peer.angle].every(Number.isFinite) ||
            peer.x<0 || peer.x>900 || peer.y<0 || peer.y>560) return;
        const last=frames[frames.length-1];
        if (last && (peer.sequence===last.sequence || peer.sequence<last.sequence || time<=last.time)) return;
        if (last && (time-last.time>1000 || Math.hypot(peer.x-last.x,peer.y-last.y)>180)) frames.length=0;
        frames.push({time,sequence:peer.sequence,x:peer.x,y:peer.y,angle:peer.angle,driving:peer.driving!==false});
        if (frames.length>MAX_FRAMES) frames.shift();
      },
      sample(time) {
        if (!frames.length || !Number.isFinite(time)) return null;
        const at=time-DELAY_MS, first=frames[0], last=frames[frames.length-1];
        if (at<=first.time) return pose(first);
        for (let i=1;i<frames.length;i++) {
          const a=frames[i-1],b=frames[i];
          if (at<=b.time) {
            const t=(at-a.time)/(b.time-a.time),angle=a.angle+normAngle(b.angle-a.angle)*t;
            return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:normAngle(angle)};
          }
        }
        if (frames.length<2 || !last.driving) return pose(last);
        const previous=frames[frames.length-2],dt=last.time-previous.time;
        const vx=(last.x-previous.x)/dt,vy=(last.y-previous.y)/dt;
        const scale=Math.min(1,0.2/(Math.hypot(vx,vy)||1)); // at most200 world units/s
        const ahead=Math.min(at-last.time,MAX_AHEAD_MS);
        return {x:Math.max(0,Math.min(900,last.x+vx*scale*ahead)),
          y:Math.max(0,Math.min(560,last.y+vy*scale*ahead)),angle:last.angle};
      },
    };
  }

  // ── Optional community API ────────────────────────────────────────────────
  // Accepts https URLs (http only for localhost); drops credentials, query, hash and trailing slashes.
  function normalizeApiUrl(raw) {
    if (typeof raw !== 'string') return '';
    let u;
    try { u = new URL(raw.trim()); } catch { return ''; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return '';
    if (u.username || u.password) return '';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  }

  // Returns null when no usable endpoint is configured. Methods never throw.
  function createApi(rawUrl, opts) {
    const base = normalizeApiUrl(rawUrl);
    if (!base) return null;
    opts = opts || {};
    const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const timeoutMs = opts.timeoutMs || 6000;
    if (!doFetch) return null;

    async function request(path, init) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
      try {
        const res = await doFetch(base + path, Object.assign({ credentials: 'omit', redirect: 'error', cache: 'no-store', signal: ctl ? ctl.signal : undefined }, init));
        if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 };
        const text = await res.text();
        if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) return { ok: false, status: 0 };
        return { ok: true, data: JSON.parse(text) };
      } catch { return { ok: false, status: 0 }; }
      finally { clearTimeout(timer); }
    }

    return {
      base,
      async health() { const r = await request('/api/health'); return r.ok; },
      async racers(trackId) {
        if(trackId!=='legacy' && !isTrackId(trackId))return null;
        const r=await request('/api/racers?track='+encodeURIComponent(trackId));
        if(!r.ok || !r.data || !Array.isArray(r.data.racers))return null;
        return r.data.racers.slice(0,50).filter(p=>p && p.trackId===trackId && /^[a-f0-9]{32}$/.test(p.sessionId) &&
          Number.isSafeInteger(p.sequence) && p.sequence>0 && typeof p.driving==='boolean' &&
          typeof p.name==='string' && cleanName(p.name)===p.name && p.name.length>0 &&
          [p.x,p.y,p.angle].every(isNum) && p.x>=0 && p.x<=900 && p.y>=0 && p.y<=560 && Math.abs(p.angle)<=Math.PI+0.001)
          .map(p=>({sessionId:p.sessionId,sequence:p.sequence,trackId:p.trackId,name:p.name,x:p.x,y:p.y,angle:p.angle,driving:p.driving}));
      },
      async publishRacer(state) {
        const r=await request('/api/racers',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});
        return !!(r.ok && r.data && r.data.ok===true);
      },
      async presence() {
        const r = await request('/api/presence');
        const counts = r.ok && r.data && r.data.counts;
        if (!counts || !TRACK_IDS.every(id => Number.isInteger(counts[id]) && counts[id] >= 0 && counts[id] <= 2000)) return null;
        return Object.fromEntries(TRACK_IDS.map(id => [id, counts[id]]));
      },
      async heartbeat(sessionId, trackId, active, sequence) {
        if (!/^[a-f0-9]{32}$/.test(sessionId) || !isTrackId(trackId) || typeof active !== 'boolean' || !Number.isSafeInteger(sequence) || sequence < 1) return false;
        const r = await request('/api/presence', {method:'POST',keepalive:true,
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId,trackId,active,sequence})});
        return !!(r.ok && r.data && r.data.ok === true);
      },
      // → [{name,ms}] (sanitized, sorted, ≤50) or null when unavailable
      async leaderboard(trackId, challengeId) {
        if (!isTrackId(trackId) || (challengeId != null && !isChallengeId(challengeId))) return null;
        const q = '?track=' + encodeURIComponent(trackId) + (challengeId ? '&challenge=' + encodeURIComponent(challengeId) : '');
        const r = await request('/api/leaderboard' + q);
        return r.ok && r.data && typeof r.data === 'object' ? parseBoard(r.data.entries, 50) : null;
      },
      // → 'saved' | 'not-saved' | 'skipped' (nothing valid to send) | 'unavailable'
      async submit(lap) {
        const track = trackById(lap.trackId), name = cleanName(lap.name);
        const ghost = track && sanitizeGhost({ ms: lap.ms, frames: lap.frames }, track);
        if (!ghost || !name || (lap.challengeId != null && !isChallengeId(lap.challengeId))) return 'skipped';
        const r = await request('/api/laps', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId: lap.trackId, challengeId: lap.challengeId || null, name, ms: ghost.ms, frames: ghost.frames }),
        });
        if (!r.ok) return r.status >= 400 && r.status < 500 && r.status !== 429 ? 'not-saved' : 'unavailable';
        return r.data && r.data.saved === true ? 'saved' : 'not-saved';
      },
    };
  }

  return {
    PHYS, STEP_MS, CAR_R, TOP_SPEED_PPS, FRAME_INTERVAL_MS, MAX_FRAMES, MAX_LAP_MS, WORLD, STORE_PREFIX,
    tracks, TRACK_IDS, trackById, isTrackId, weeklyChallenge, isChallengeId,
    analyzeTrack, makeGate, gateCrossing, segsIntersect, nearestOnRing, smoothRing, resampleRing,
    createCar, stepCar, createSession, createRecorder, ghostAt, sanitizeGhost, createPeerInterpolator,
    cleanName, nameKey, parseBoard, scopeOf, scoresKey, ghostKey,
    loadScores, recordScore, loadGhost, saveGhostIfBetter, recordLap,
    normalizeApiUrl, createApi,
  };
});
