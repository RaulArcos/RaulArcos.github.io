'use strict';
// Racing Lab game: runs the real racing-game.js + racing-core.js in a VM against a small fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const Core = require(path.join(ROOT, 'racing-core.js'));
const FB = 'https://personalwebpage-c3328-default-rtdb.europe-west1.firebasedatabase.app';
const API = 'https://api.test';

// <harness>
function makeEnv(opts = {}) {
  const env = { now: 1000, dateNow: opts.dateNow !== undefined ? opts.dateNow : Date.UTC(2026, 9, 22, 12), raf: new Map(), rafId: 0,
    timers: new Map(), timerId: 0, fetchCalls: [], session: null, lsFail: { access: false, get: false, set: false }, ap: null,
    apiHandler: () => resp(404, {}), fbBoard: {} };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  env.resp = resp;

  const camel = k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class Style {
    get cssText() { return this._css || ''; }
    set cssText(v) {
      for (const k of Object.keys(this)) if (k !== '_css') delete this[k];
      Object.defineProperty(this, '_css', { value: String(v), writable: true, enumerable: false, configurable: true });
      for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) this[camel(decl.slice(0, i).trim())] = decl.slice(i + 1).trim(); }
    }
  }
  const mkTarget = o => {
    o._l = [];
    const cap = opt => opt === true || !!(opt && opt.capture);
    o.addEventListener = function (type, fn, opt) { if (!this._l.some(l => l.type === type && l.fn === fn && l.capture === cap(opt))) this._l.push({ type, fn, capture: cap(opt) }); };
    o.removeEventListener = function (type, fn, opt) { this._l = this._l.filter(l => !(l.type === type && l.fn === fn && l.capture === cap(opt))); };
    return o;
  };
  const makeCtx = () => {
    const calls = [], state = {};
    return new Proxy({}, {
      get(_, k) {
        if (k === 'calls') return calls;
        if (k in state) return state[k];
        return (...a) => { if (k === 'fillText' || k === 'translate' || k === 'setTransform' || k === 'strokeRect') { calls.push([k, ...a]); if (calls.length > 3000) calls.splice(0, 1500); } };
      },
      set(_, k, v) { state[k] = v; return true; },
    });
  };
  const win = mkTarget({});
  const doc = mkTarget({ nodeType: 9, parentNode: null, hidden: false, hasFocus: () => true });

  class Element {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.childNodes = []; this.parentNode = null; this.attributes = {};
      this.style = new Style(); this.dataset = {}; this._classes = new Set(); this.value = ''; this.disabled = false; mkTarget(this);
      if (this.tagName === 'CANVAS') { this.width = 300; this.height = 150; }
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = String(v); }
    get classList() { const s = this._classes; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; }
    get isConnected() { for (let n = this; n; n = n.parentNode) if (n === doc.body) return true; return false; }
    get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild(doc.createTextNode(v)); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(n => n !== c); c.parentNode = null; return c; }
    remove() {
      const active = doc.activeElement;
      if (this.parentNode) this.parentNode.removeChild(this);
      for (let n = active; n; n = n.parentNode) if (n === this) { doc.activeElement = doc.body; break; }
    }
    setAttribute(k, v) { this.attributes[k] = String(v); if (this.tagName === 'CANVAS' && (k === 'width' || k === 'height')) this[k] = Number(v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    focus() { if (this.isConnected) doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    click() { env.dispatch(this, { type: 'click' }); }
    closest(sel) { if (sel[0] === '#') for (let n = this; n; n = n.parentNode) if (n.id === sel.slice(1)) return n; return null; }
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }; }
    getContext() { return this._ctx || (this._ctx = makeCtx()); }
  }
  doc.body = new Element('body'); doc.body.parentNode = doc; doc.activeElement = doc.body;
  doc.createElement = t => new Element(t);
  doc.createTextNode = d => ({ nodeType: 3, data: String(d), parentNode: null });
  const walk = (n, fn) => { fn(n); (n.childNodes || []).forEach(c => walk(c, fn)); };
  doc.getElementById = id => { let f = null; walk(doc.body, n => { if (!f && n.nodeType === 1 && n.id === id) f = n; }); return f; };

  env.win = win; env.doc = doc; env.Element = Element; env.walk = walk;
  env.byId = id => doc.getElementById(id);
  env.all = pred => { const out = []; walk(doc.body, n => { if (n.nodeType === 1 && pred(n)) out.push(n); }); return out; };
  env.backdrops = () => env.all(n => n.style.position === 'fixed' && n.style.inset === '0');
  env.text = id => { const e = env.byId(id); return e ? e.textContent : null; };

  env.dispatch = (target, e) => {
    const path = []; for (let n = target; n; n = n.parentNode) path.push(n); path.push(win);
    let stopped = false;
    Object.assign(e, { target, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() { stopped = true; } });
    const run = (n, capture) => { for (const l of n._l.slice()) if (l.type === e.type && l.capture === capture) { e.currentTarget = n; l.fn.call(n, e); } };
    for (let i = path.length - 1; i >= 0 && !stopped; i--) run(path[i], true);
    for (let i = 0; i < path.length && !stopped; i++) run(path[i], false);
    return e;
  };
  env.key = (type, code, extra) => env.dispatch(doc.activeElement, Object.assign({ type, code, key: code.length === 1 ? code : code }, extra));
  env.listeners = (target, type) => target._l.filter(l => l.type === type).length;
  env.allListeners = () => ['keydown', 'keyup', 'resize', 'blur', 'focus'].reduce((n, t) => n + env.listeners(win, t), 0) + env.listeners(doc, 'visibilitychange');

  // clock: one virtual time for performance.now, timers and animation frames
  win.requestAnimationFrame = fn => { env.raf.set(++env.rafId, fn); return env.rafId; };
  win.cancelAnimationFrame = id => { env.raf.delete(id); };
  win.setTimeout = (fn, ms) => { env.timers.set(++env.timerId, { fn, at: env.now + (ms || 0), ms: ms || 0 }); return env.timerId; };
  win.clearTimeout = id => { env.timers.delete(id); };
  win.performance = { now: () => env.now };
  const runTimers = () => { for (const [id, t] of [...env.timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= env.now && env.timers.has(id)) { env.timers.delete(id); t.fn(); } };
  env.frame = (dt = 1000 / 60) => { env.now += dt; runTimers(); const q = [...env.raf]; env.raf.clear(); q.forEach(([, fn]) => fn(env.now)); };
  env.frames = (n, dt) => { for (let i = 0; i < n; i++) env.frame(dt); };
  env.advance = ms => { env.now += ms; runTimers(); };
  env.pendingTimers = () => [...env.timers.values()].filter(t => t.ms !== 5000);   // 5 s = the permanent attract-glow timer
  env.flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

  // storage + network
  const mkStore = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
  const ls = mkStore(), ss = mkStore();
  env.ls = ls;
  const guard = (s, over) => new Proxy(s, { get(t, k) {
    if (k === 'getItem') return key => { if (env.lsFail.get) throw new Error('blocked'); return t.getItem(key); };
    if (k === 'setItem') return (key, v) => { if (env.lsFail.set) throw new Error('quota'); t.setItem(key, v); };
    return t[k];
  } });
  Object.defineProperty(win, 'localStorage', { get() { if (env.lsFail.access) throw new Error('SecurityError'); return guard(ls); }, configurable: true });
  win.sessionStorage = ss;
  win.fetch = (url, init) => {
    url = String(url); env.fetchCalls.push({ url, init: init || null });
    try {
      if (url.startsWith(FB)) {                                       // a tiny stateful Realtime Database
        if (init && init.method === 'PATCH') { Object.assign(env.fbBoard, JSON.parse(init.body)); return Promise.resolve(resp(200, {})); }
        return Promise.resolve(resp(200, env.fbBoard));
      }
      if (url.includes('identitytoolkit')) return Promise.resolve(resp(200, { idToken: 'tok' }));
      return Promise.resolve(env.apiHandler(url, init || {}));
    } catch (e) { return Promise.reject(e); }
  };
  win.window = win; win.document = doc; win.innerWidth = 1280; win.innerHeight = 800; win.console = console;
  win.Blob = function Blob() {}; win.URL = class extends URL { static createObjectURL() { return 'blob:x'; } static revokeObjectURL() {} };
  win.AbortController = AbortController;
  if (opts.touch) win.ontouchstart = null;
  win.__env = env;
  const ctx = vm.createContext(win);
  vm.runInContext(`(function () { const D = Date; class FD extends D { constructor(...a) { if (a.length === 0) super(__env.dateNow); else super(...a); } static now() { return __env.dateNow; } } window.Date = FD; })()`, ctx);
  const load = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  env.load = load;
  env.loadAll = (files = ['racing-config.js', 'racing-core.js', 'racing-game.js']) => {
    if (env.win.RACING_API_URL === undefined) env.win.RACING_API_URL = '';
    for (const f of files) {
      load(f);
      if (f === 'racing-core.js') {                                    // expose the live session to the tests
        const c = win.RacingLabCore, orig = c.createSession;
        c.createSession = o => (env.session = orig(o));
      }
    }
  };
  env.addPhoto = () => {
    const mk = (tag, id) => { const e = new Element(tag); e.setAttribute('id', id); doc.body.appendChild(e); return e; };
    const frame = mk('div', 'rah-photo-frame'); const photo = mk('img', 'rah-photo'); const label = mk('span', 'rah-race-label'); const tip = mk('span', 'rah-clickme');
    photo._rect = { left: 700, top: 100, width: 300, height: 345, right: 1000, bottom: 445 };
    return { frame, photo, label, tip };
  };
  env.opener = () => { const b = new Element('button'); b.setAttribute('id', 'opener'); doc.body.appendChild(b); b.focus(); return b; };

  // Presses/releases arrow keys so that the held set equals `want` (through real key events).
  const KEYS = { up: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight', down: 'ArrowDown' };
  env.held = {};
  env.setKeys = want => { for (const k in KEYS) { const on = !!want[k]; if (on !== !!env.held[k]) { env.key(on ? 'keydown' : 'keyup', KEYS[k]); env.held[k] = on; } } };
  // Pure-pursuit driver reading the live session; one decision per animation frame.
  const na = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  env.autopilot = (o = {}) => {
    const s = env.session, track = s.track, p = track.points, n = p.length, c = s.car;
    if (!env.ap || env.ap.s !== s) {
      let len = 0; for (let i = 0; i < n; i++) len += Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]);
      env.ap = { s, idx: track.legacy ? 1 : n - 8, k: track.id === 'spa-francorchamps-v3' ? 1 : 18 / (len / n) };      // look-ahead windows are in metres, not points
    }
    const I = x => Math.max(1, Math.round(x * env.ap.k));
    let best = Infinity, bi = env.ap.idx;
    for (let d = -3; d <= 8; d++) { const j = (env.ap.idx + d + n) % n, dd = Math.hypot(p[j][0] - c.x, p[j][1] - c.y); if (dd < best) { best = dd; bi = j; } }
    env.ap.idx = bi;
    const sp = Math.hypot(c.vx, c.vy), tg = p[(bi + I(3 + sp * 3)) % n];
    const err = na(Math.atan2(tg[0] - c.x, -(tg[1] - c.y)) - c.angle);
    const a = p[(bi + I(4)) % n], b = p[(bi + I(12)) % n], b0 = p[(bi + I(8)) % n];
    const h1 = Math.atan2(a[0] - p[bi][0], -(a[1] - p[bi][1])), h2 = Math.atan2(b[0] - b0[0], -(b[1] - b0[1]));
    const vmax = Math.max(0.5, 1.4 - Math.abs(na(h2 - h1)) * 0.6 * 2.6) * (o.vScale || 1);
    const e2 = err - c.angVel * (o.kd || 8);
    env.setKeys({ up: sp < vmax, left: e2 < -0.02, right: e2 > 0.02 });
  };
  env.race = (until, o = {}) => {
    for (let i = 0; i < (o.maxFrames || 6000); i++) { env.autopilot(o); env.frame(); if (until()) return i; }
    throw new Error('race did not reach the goal within ' + (o.maxFrames || 6000) + ' frames');
  };
  return env;
}
// </harness>

// ── scenario helpers ───────────────────────────────────────────────────────
function boot(opts = {}) {
  const env = makeEnv(opts);
  env.win.RACING_API_URL = opts.api === undefined ? '' : opts.api;
  env.loadAll();
  return env;
}
const trackButtons = env => env.all(n => n.attributes['data-track']);
const pressed = env => trackButtons(env).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-track'));
function startRace(env, name = 'Ana') {
  env.byId('rr-input').value = name;
  env.byId('rr-go').click();
  assert.ok(env.session, 'a race session was created');
}
const lsKeys = env => [...env.ls.m.keys()];
const lapDone = (env, n = 1) => () => env.session.lapCount >= n;

// ── loading, entry point, legacy compatibility ─────────────────────────────
test('loading keeps the legacy Firebase sync, defines rahOpenRace and opens nothing', async () => {
  const env = boot();
  await env.flush();
  assert.equal(typeof env.win.rahOpenRace, 'function');
  assert.deepEqual(env.fetchCalls.map(c => [c.url, c.init]), [[FB + '/rah-lb-wide-v2.json', null]]);
  assert.equal(env.byId('rah-race-ov'), null);
  assert.equal(env.allListeners(), 0);
});

test('legacy: the attract glow still invites the first click after 5 s', () => {
  const env = boot(); const { frame, tip } = env.addPhoto();
  env.advance(5000);
  assert.ok(frame.classList.contains('rah-photo-glow') && tip.classList.contains('rah-clickme-show'));
});

test('photo click and RACE label open the game from the photo, with no keyboard capture before Play', () => {
  const env = boot(); const { photo, label, frame, tip } = env.addPhoto();
  photo.click();
  const ov = env.byId('rah-race-ov');
  assert.ok(ov);
  assert.equal(ov.dataset.mode, 'photo');
  assert.equal(ov.style.left, '700px'); assert.equal(ov.style.width, '300px');
  assert.deepEqual(pressed(env), ['cadiz-city-v3']);                       // default track
  assert.equal(env.doc.activeElement, env.byId('rr-input'));
  assert.equal(env.allListeners(), 1); // visibility-only polling listener, not gameplay keys
  assert.equal(env.listeners(env.win,'keydown'),0);assert.equal(env.listeners(env.win,'keyup'),0);
  for (const code of ['ArrowUp', 'Space', 'KeyW']) assert.equal(env.key('keydown', code).defaultPrevented, false);
  assert.equal(env.byId('rr-game').style.display, 'none');
  env.key('keydown', 'Escape'); assert.equal(env.byId('rah-race-ov'), null);
  label.click(); assert.ok(env.byId('rah-race-ov'));
  env.win.rahOpenRace(); assert.equal(env.all(n => n.id === 'rah-race-ov').length, 1);   // no second overlay
  env.byId('rr-x').click();
  assert.equal(env.byId('rah-race-ov'), null);
  env.doc.body.click(); assert.equal(env.byId('rah-race-ov'), null);       // other clicks do nothing
  assert.ok(!frame.classList.contains('rah-photo-glow') && !tip.classList.contains('rah-clickme-show'));
});

test('rahOpenRace(trackId, challenge) opens the expanded menu on the requested track', () => {
  const env = boot(); env.addPhoto();
  const open = (...a) => { env.win.rahOpenRace(...a); const ov = env.byId('rah-race-ov'); const sel = pressed(env), chal = env.byId('rr-chal'); env.key('keydown', 'Escape'); return { ov, sel, chal }; };
  for (const id of ['cadiz-city-v3', 'spa-francorchamps-v3', 'noob-gp-v3', 'legacy']) {
    env.win.rahOpenRace(id);
    const ov = env.byId('rah-race-ov');
    assert.equal(ov.dataset.mode, 'expanded', id);
    assert.deepEqual(pressed(env), [id]);
    assert.ok(env.byId('rr-desc').textContent.includes((Core.trackById(id) || { name: 'Legacy Circuit' }).name.toUpperCase()));
    assert.ok(env.backdrops().length === 1);   // backdrop
    env.key('keydown', 'Escape');
    assert.equal(env.backdrops().length, 0);
  }
  assert.deepEqual(open('nonsense').sel, ['cadiz-city-v3']);
  assert.deepEqual(open(undefined, false).sel, ['cadiz-city-v3']);
  assert.deepEqual(open(null).sel, ['cadiz-city-v3']);
  env.win.rahOpenRace('legacy',true);assert.equal(env.byId('rr-chal'),null);assert.deepEqual(pressed(env),['legacy']);

});

test('menu: buttons switch free-play tracks without a weekly toggle', () => {
  const env = boot(); env.win.rahOpenRace('spa-francorchamps-v3');
  const btn = id => trackButtons(env).find(b => b.getAttribute('data-track') === id);
  btn('noob-gp-v3').click(); assert.deepEqual(pressed(env), ['noob-gp-v3']);
  btn('legacy').click(); assert.deepEqual(pressed(env), ['legacy']);
  assert.ok(env.byId('rr-lb0').textContent.includes('LEGACY BOARD'));
  btn('cadiz-city-v3').click(); assert.ok(env.byId('rr-lb0').textContent.includes('THIS DEVICE ONLY'));
});

test('modal is accessible: dialog semantics, Tab stays inside, Escape closes and restores focus', () => {
  const env = boot(); const opener = env.opener();
  env.win.rahOpenRace('noob-gp-v3');
  const ov = env.byId('rah-race-ov');
  assert.equal(ov.getAttribute('role'), 'dialog'); assert.equal(ov.getAttribute('aria-modal'), 'true'); assert.ok(ov.getAttribute('aria-label'));
  assert.equal(env.doc.activeElement, env.byId('rr-input'));
  const inside = n => { for (let x = n; x; x = x.parentNode) if (x === ov) return true; return false; };
  const seen = [];
  for (let i = 0; i < 40; i++) { env.key('keydown', 'Tab'); seen.push(env.doc.activeElement); assert.ok(inside(env.doc.activeElement)); }
  const cycle = new Set(seen);
  assert.ok(cycle.size >= 7, 'tab order has the tracks, name, start and close controls');
  assert.ok([...cycle].every(e => ['BUTTON', 'INPUT'].includes(e.tagName)));
  for (let i = 0; i < 10; i++) { assert.equal(env.key('keydown', 'Tab', { shiftKey: true }).defaultPrevented, true); assert.ok(inside(env.doc.activeElement)); }
  env.doc.activeElement.blur();
  env.key('keydown', 'Tab'); assert.ok(inside(env.doc.activeElement));       // focus lost to <body> is pulled back in
  env.key('keydown', 'Escape');
  assert.equal(env.byId('rah-race-ov'), null);
  assert.equal(env.doc.activeElement, opener);
  assert.equal(env.backdrops().length, 0);
  assert.equal(env.pendingTimers().length, 0);
});

// ── race lifecycle ─────────────────────────────────────────────────────────
test('Play starts the race: keys are captured only now; Escape cleans up everything', () => {
  const env = boot(); const opener = env.opener();
  env.win.rahOpenRace('spa-francorchamps-v3');
  assert.equal(env.allListeners(), 1);assert.equal(env.listeners(env.win,'keydown'),0);assert.equal(env.listeners(env.win,'keyup'),0);
  startRace(env, 'Ana');
  assert.equal(env.ls.getItem('rah-race-last'), 'ANA');
  assert.equal(env.byId('rr-name').style.display, 'none'); assert.equal(env.byId('rr-game').style.display, 'block');
  assert.equal(env.doc.activeElement, env.byId('rr-game'));
  assert.equal(env.listeners(env.win, 'keydown'), 1); assert.equal(env.listeners(env.win, 'keyup'), 1);
  assert.equal(env.session.track.id, 'spa-francorchamps-v3');
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']) assert.equal(env.key('keydown', code).defaultPrevented, true, code);
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']) env.key('keyup', code);
  const y0 = env.session.car.y, x0 = env.session.car.x;
  env.setKeys({ up: true }); env.frames(60);
  assert.ok(Math.hypot(env.session.car.x - x0, env.session.car.y - y0) > 10, 'the car drives');
  assert.ok(env.raf.size > 0);
  env.key('keydown', 'Escape');
  assert.equal(env.byId('rah-race-ov'), null);
  assert.equal(env.allListeners(), 0);
  assert.equal(env.raf.size, 0);
  assert.equal(env.pendingTimers().length, 0);
  assert.equal(env.win._rrResize, null);
  assert.equal(env.doc.activeElement, opener);
  assert.equal(env.key('keydown', 'ArrowUp').defaultPrevented, false);   // keys are free again
  env.frames(5);
  env.win.rahOpenRace('legacy'); startRace(env, 'Bo');                    // and the game can be reopened
  env.byId('rr-quit').click();
  assert.equal(env.byId('rah-race-ov'), null); assert.equal(env.allListeners(), 0); assert.equal(env.raf.size, 0);
});

test('Play without a name keeps the menu open', () => {
  const env = boot(); env.win.rahOpenRace('cadiz-city-v3');
  env.byId('rr-input').value = '  !!<> ';
  env.byId('rr-go').click();
  assert.equal(env.session, null);
  assert.equal(env.byId('rr-game').style.display, 'none');
  assert.equal(env.doc.activeElement, env.byId('rr-input'));
});

test('names for the new tracks are cleaned to bounded plain text; the legacy name rule is unchanged', () => {
  const env = boot(); env.win.rahOpenRace('cadiz-city-v3');
  env.byId('rr-input').value = ' <b>Ana</b> '; env.byId('rr-go').click();
  assert.equal(env.ls.getItem('rah-race-last'), 'BANAB');
  env.key('keydown', 'Escape');
  env.win.rahOpenRace('noob-gp-v3'); env.byId('rr-input').value = 'ß'.repeat(15); env.byId('rr-go').click();
  assert.equal(env.ls.getItem('rah-race-last'), 'SS'.repeat(10));
  env.key('keydown', 'Escape');
  env.win.rahOpenRace('legacy'); env.byId('rr-input').value = ' <b>x</b> '; env.byId('rr-go').click();
  assert.equal(env.ls.getItem('rah-race-last'), '<B>X</B>');                 // legacy keeps trim + uppercase only
});

test('Tab inside a running race stays in the dialog and Space never reaches the page', () => {
  const env = boot(); env.win.rahOpenRace('cadiz-city-v3'); startRace(env);
  const ov = env.byId('rah-race-ov');
  for (let i = 0; i < 6; i++) { env.key('keydown', 'Tab'); let ok = false; for (let x = env.doc.activeElement; x; x = x.parentNode) if (x === ov) ok = true; assert.ok(ok); }
  assert.ok(['BUTTON', 'INPUT'].includes(env.doc.activeElement.tagName));
});

test('blur and hidden tab pause the race: keys are released, the clock stops, nothing phantom happens', () => {
  const env = boot(); env.win.rahOpenRace('cadiz-city-v3'); startRace(env);
  const s = env.session, car = s.car;
  env.setKeys({ up: true }); env.frames(40);
  const v = Math.hypot(car.vx, car.vy); assert.ok(v > 0.3);
  env.dispatch(env.win, { type: 'blur' });
  assert.equal(env.text('rr-msg'), 'PAUSED');
  const snap = [car.x, car.y, s.simMs];
  env.advance(30000); env.frames(120);
  assert.deepEqual([car.x, car.y, s.simMs], snap);                        // frozen while paused
  env.dispatch(env.win, { type: 'focus' });
  assert.notEqual(env.text('rr-msg'), 'PAUSED');
  env.held = {};                                                          // the user released the keys while away: no keyup arrives
  env.frames(90);
  assert.equal(car.power, 0, 'no stuck throttle');
  assert.ok(Math.hypot(car.vx, car.vy) < 0.01);
  assert.equal(s.lapCount, 0);
  // hidden tab: focus events while still hidden must not resume
  env.setKeys({ up: true }); env.frames(20);
  env.doc.hidden = true; env.dispatch(env.doc, { type: 'visibilitychange' });
  const t = s.simMs; env.frames(30); assert.equal(s.simMs, t);
  env.dispatch(env.win, { type: 'focus' }); env.frames(30); assert.equal(s.simMs, t);
  env.doc.hidden = false; env.dispatch(env.doc, { type: 'visibilitychange' }); env.held = {};
  env.frames(10); assert.ok(s.simMs > t);
  env.key('keydown', 'Escape');
  assert.equal(env.allListeners(), 0);
});

test('legacy wall-clock lap does not grow while the tab is away', () => {
  const env = boot(); env.win.rahOpenRace('legacy'); startRace(env);
  env.race(() => env.session.running, { maxFrames: 4000 });
  env.race(() => env.session.elapsed() > 3000, { maxFrames: 400 });
  const before = env.session.elapsed();
  env.dispatch(env.win, { type: 'blur' });
  env.advance(90000);
  env.dispatch(env.win, { type: 'focus' });
  const after = env.session.elapsed();
  assert.ok(after >= before && after - before < 100, `elapsed ${before} → ${after}`);
});

// ── playing laps ───────────────────────────────────────────────────────────
for (const id of Core.TRACK_IDS) {
  test(`${id}: a full lap through the keyboard saves score and ghost on this device only`, async () => {
    const env = boot(); env.win.rahOpenRace(id); startRace(env, 'Ana');
    const loadsAtStart = env.fetchCalls.length;
    env.race(lapDone(env), { maxFrames: 6000 });
    const key = Core.scoresKey(id);
    const board = JSON.parse(env.ls.getItem(key)).entries;
    assert.equal(board.length, 1); assert.equal(board[0].name, 'ANA');
    const ms = board[0].ms;
    assert.ok(ms >= Core.trackById(id).minLapMs && ms < 80000);
    assert.match(env.text('rr-msg'), /^LAP 1 {2}\d:\d\d\.\d{3} {2}★ BEST!$/);
    assert.equal(env.text('rr-hbest'), `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`);
    const ghostRaw = env.ls.getItem(Core.ghostKey(id, 'ANA'));
    assert.ok(ghostRaw.length < 120000);
    const g = JSON.parse(ghostRaw);
    assert.equal(g.ms, ms); assert.ok(g.frames.length <= Core.MAX_FRAMES); assert.equal(g.frames[g.frames.length - 1][0], ms);
    assert.ok(lsKeys(env).every(k => k === 'rah-race-last' || k.startsWith('rah-racing-v4:')), lsKeys(env).join());
    assert.equal(env.ls.getItem('rah-racing-lb-wide-v2'), null);
    await env.flush();
    assert.equal(env.fetchCalls.length, loadsAtStart);                     // Firebase and the API are untouched
    assert.match(env.text('rr-info'), /GHOST: YOUR BEST \(THIS DEVICE\)/);
    assert.doesNotMatch(env.text('rr-info') + env.text('rr-name'), /raul|reference lap/i);
  });
}

test('the personal ghost replays the saved lap at the right time and is only replaced by a faster lap', async () => {
  const env = boot(); env.win.rahOpenRace('cadiz-city-v3'); startRace(env, 'Ana');
  assert.match(env.text('rr-info'), /GHOST: NONE YET/);
  env.race(lapDone(env), { maxFrames: 6000 });
  const key = Core.ghostKey('cadiz-city-v3', 'ANA'), first = JSON.parse(env.ls.getItem(key));
  const ctx = env.byId('rr-canvas').getContext();
  // lap 2 (slower driver): the ghost drawn each frame equals the stored frames at the lap clock
  let checked = 0;
  for (let i = 0; i < 6000 && env.session.lapCount < 2; i++) {
    env.autopilot({ vScale: 0.4 }); ctx.calls.length = 0; env.frame();
    const el = env.session.elapsed(), mark = ctx.calls.filter(c => c[0] === 'fillText' && c[1] === 'GHOST').pop();
    if (el !== null && el > 2000 && el < first.ms && mark) {
      const exp = Core.ghostAt(first.frames, el);
      assert.ok(Math.abs(mark[2] - exp.x) < 1e-6 && Math.abs(mark[3] - (exp.y - 13)) < 1e-6, `ghost at ${el}`);
      checked++;
    }
  }
  assert.ok(checked > 100, 'ghost was drawn through most of the lap');
  assert.equal(env.session.lapCount, 2);
  const slow = JSON.parse(env.ls.getItem(key));
  assert.equal(slow.ms, first.ms); assert.deepEqual(slow.frames, first.frames);               // slower lap: untouched
  assert.equal(JSON.parse(env.ls.getItem(Core.scoresKey('cadiz-city-v3'))).entries[0].ms, first.ms);
  assert.match(env.text('rr-msg'), /^LAP 2 {2}\d:\d\d\.\d{3} {2}✓$/);
  // lap 3 (the original, quicker pace) can only replace it by being strictly faster
  env.race(lapDone(env, 3), { maxFrames: 6000 });
  const after = JSON.parse(env.ls.getItem(key));
  assert.ok(after.ms <= first.ms);
  if (after.ms < first.ms) assert.match(env.text('rr-msg'), /BEST/); else assert.deepEqual(after, first);
});


test('private/blocked storage is tolerated: the race runs and says the time was not saved', () => {
  const env = boot(); env.lsFail.get = true; env.lsFail.set = true;
  env.win.rahOpenRace('cadiz-city-v3'); startRace(env, 'Ana');
  env.race(lapDone(env), { maxFrames: 6000 });
  assert.match(env.text('rr-msg'), /★ BEST \(NOT SAVED\)/);
  assert.notEqual(env.text('rr-hbest'), '—:——.———');
  env.key('keydown', 'Escape');
  env.lsFail.get = false; env.lsFail.set = false; env.lsFail.access = true;      // even window.localStorage throwing
  env.win.rahOpenRace('legacy'); startRace(env, 'Ana');
  env.race(() => env.session.running, { maxFrames: 4000 });
  env.key('keydown', 'Escape');
  env.win.rahOpenRace('spa-francorchamps-v3'); assert.ok(env.byId('rr-lb0'));
  startRace(env, 'Ana'); env.frames(10);
});

test('legacy circuit: same rules, local cache key and Firebase PATCH as before', async () => {
  const env = boot({ api: API + '/' }); env.apiHandler = () => { throw new Error('legacy must not use the API'); };
  env.win.rahOpenRace('legacy'); startRace(env, 'Ana');
  assert.equal(env.session.track.legacy, true);
  assert.equal(env.session.track.points.length, 84);
  assert.deepEqual(Array.from(env.session.track.sectors), [12, 34, 48, 68]);
  assert.match(env.text('rr-info'), /LEGACY CIRCUIT/);
  assert.equal(env.byId('rr-export').style.display, undefined);          // legacy keeps its leaderboard download button
  env.race(lapDone(env), { maxFrames: 7000 });
  await env.flush();
  const lb = JSON.parse(env.ls.getItem('rah-racing-lb-wide-v2'));
  assert.deepEqual(Object.keys(lb), ['ANA']);
  assert.ok(lb.ANA > 5000 && lb.ANA < 80000);
  assert.match(env.text('rr-msg'), /^LAP 1 {2}\d:\d\d\.\d{3} {2}★ BEST!$/);
  const patch = env.fetchCalls.find(c => c.init && c.init.method === 'PATCH');
  assert.equal(patch.url, FB + '/rah-lb-wide-v2.json?auth=tok');
  assert.deepEqual(JSON.parse(patch.init.body), { ANA: lb.ANA });
  assert.ok(env.fetchCalls.some(c => c.url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=')));
  assert.ok(env.fetchCalls.filter(c => c.url.startsWith(FB)).length >= 3);
  assert.ok(!env.fetchCalls.some(c => c.url.startsWith(API)), 'legacy never talks to the new API');
  assert.ok(lsKeys(env).every(k => k === 'rah-racing-lb-wide-v2' || k === 'rah-race-last'), lsKeys(env).join());
  assert.match(env.text('rr-lb1'), /P1 ANA {8}\d:\d\d\.\d{3}/);
});

test('legacy leaderboard renders names as text, never as markup', async () => {
  const env = boot(); env.fbBoard = { '<img src=x onerror=alert(1)>': 31000, '<b>X</b>': 32000 };
  env.win.rahOpenRace('legacy'); await env.flush();
  const lb = env.byId('rr-lb0');
  assert.ok(lb.textContent.includes('<img src=x o'));          // names are cut to 12 characters, as before
  assert.equal(env.all(n => ['IMG', 'B', 'SCRIPT'].includes(n.tagName)).length, 0);
});

// ── optional community API ─────────────────────────────────────────────────
test('API: board is fetched for new tracks only, shown as text, laps are posted once per personal best', async () => {
  const env = boot({ api: ' ' + API + '/?x=1 ' });
  const posted = [];
  env.apiHandler = (url, init) => {
    if (url.startsWith(API + '/api/leaderboard')) return env.resp(200, { entries: [{ name: '<img src=x onerror=alert(1)>', ms: 21000 }, { name: 'Zed', ms: 22000 }] });
    if (url === API + '/api/laps') { posted.push(JSON.parse(init.body)); return env.resp(200, { saved: true }); }
    return env.resp(404, {});
  };
  env.win.rahOpenRace('cadiz-city-v3'); await env.flush();
  assert.equal(env.fetchCalls.filter(c => c.url.startsWith(API)).map(c => c.url)[0], API + '/api/leaderboard?track=cadiz-city-v3');
  assert.equal(env.fetchCalls.find(c => c.url.startsWith(API)).init.credentials, 'omit');
  const lb = env.byId('rr-lb0').textContent;
  assert.ok(lb.includes('ONLINE BOARD · COMMUNITY SCORES, UNVERIFIED') && lb.includes('Zed') && lb.includes('0:21.000'));
  assert.ok(!lb.includes('<') && !lb.includes('onerror=alert(1)>'));
  assert.equal(env.all(n => ['IMG', 'SCRIPT'].includes(n.tagName)).length, 0);
  const n = env.fetchCalls.length;
  trackButtons(env).find(b => b.getAttribute('data-track') === 'legacy').click(); await env.flush();
  assert.ok(env.fetchCalls.slice(n).every(c => c.url.startsWith(FB)), 'choosing legacy never calls the API');
  trackButtons(env).find(b => b.getAttribute('data-track') === 'noob-gp-v3').click(); await env.flush();
  assert.ok(env.fetchCalls.some(c => c.url === API + '/api/leaderboard?track=noob-gp-v3'));
  trackButtons(env).find(b => b.getAttribute('data-track') === 'cadiz-city-v3').click();
  startRace(env, 'Ana'); await env.flush();
  env.race(lapDone(env), { maxFrames: 6000 }); await env.flush();
  assert.equal(posted.length, 1);
  const body = posted[0], g = Core.sanitizeGhost({ ms: body.ms, frames: body.frames }, Core.trackById('cadiz-city-v3'));
  assert.deepEqual(Object.keys(body), ['trackId', 'challengeId', 'name', 'ms', 'frames']);
  assert.deepEqual([body.trackId, body.challengeId, body.name], ['cadiz-city-v3', null, 'ANA']);
  assert.ok(g);
  assert.match(env.text('rr-info'), /ONLINE: SAVED \(COMMUNITY, UNVERIFIED\)/);
  // a slower lap neither stores a new best nor posts
  env.race(lapDone(env, 2), { maxFrames: 6000, vScale: 0.75 }); await env.flush();
  assert.equal(posted.length, 1);
});

test('a slow valid lap (over 90 s, played with real key events) still stores its ghost and posts the same frames', async () => {
  const env = boot({ api: API }); const posted = [];
  env.apiHandler = (url, init) => url === API + '/api/laps' ? (posted.push(JSON.parse(init.body)), env.resp(200, { saved: true })) : env.resp(200, { entries: [] });
  env.win.rahOpenRace('noob-gp-v3'); startRace(env, 'Ana');
  env.race(lapDone(env), { maxFrames: 9000, vScale: 0.25 }); await env.flush();
  const stored = JSON.parse(env.ls.getItem(Core.ghostKey('noob-gp-v3', 'ANA')));
  assert.ok(stored.ms > 92000 && stored.ms < 107000, `lap ${stored.ms}`);
  assert.ok(stored.frames.length > 1000 && stored.frames.length <= Core.MAX_FRAMES);
  assert.equal(stored.frames[stored.frames.length - 1][0], stored.ms);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].frames, stored.frames);
  assert.equal(posted[0].ms, stored.ms);
  assert.match(env.text('rr-info'), /GHOST: YOUR BEST \(THIS DEVICE\) 1:\d\d\.\d{3}/);
  assert.match(env.text('rr-info'), /ONLINE: SAVED/);
});


test('API unavailable or insecure: falls back to this device honestly', async () => {
  const env = boot({ api: API });
  env.apiHandler = () => { throw new Error('down'); };
  env.win.rahOpenRace('cadiz-city-v3'); await env.flush();
  assert.match(env.byId('rr-lb0').textContent, /ONLINE BOARD UNAVAILABLE · SHOWING THIS DEVICE/);
  startRace(env, 'Ana'); env.race(lapDone(env), { maxFrames: 6000 }); await env.flush();
  assert.match(env.text('rr-info'), /ONLINE: UNAVAILABLE · SAVED ON THIS DEVICE/);
  assert.equal(JSON.parse(env.ls.getItem(Core.scoresKey('cadiz-city-v3'))).entries.length, 1);
  const env2 = boot({ api: 'http://insecure.test' });
  env2.win.rahOpenRace('cadiz-city-v3'); await env2.flush();
  assert.match(env2.byId('rr-lb0').textContent, /SCORES: THIS DEVICE ONLY/);
  assert.ok(!env2.fetchCalls.some(c => c.url.includes('insecure.test')));
  const env3 = boot({}); env3.win.rahOpenRace('cadiz-city-v3'); await env3.flush();
  assert.equal(env3.fetchCalls.length, 1);                               // only the legacy Firebase sync at load
});

test('closing while a request is in flight does not touch the removed dialog', async () => {
  const env = boot({ api: API });
  let release; env.apiHandler = () => new Promise(r => { release = () => r(env.resp(200, { entries: [{ name: 'Late', ms: 20000 }] })); });
  env.win.rahOpenRace('cadiz-city-v3'); await env.flush();
  const lb = env.byId('rr-lb0');
  env.key('keydown', 'Escape');
  release(); await env.flush();
  assert.ok(!lb.textContent.includes('Late'));
  assert.equal(env.byId('rah-race-ov'), null);
});

test('touch devices get the controls and the photo-sized window auto-expands', () => {
  const env = boot({ touch: true }); env.addPhoto().photo.click();
  const ov = env.byId('rah-race-ov');
  assert.equal(ov.dataset.mode, 'photo');
  env.advance(100);
  assert.equal(ov.dataset.mode, 'expanded');
  startRace(env);
  assert.equal(env.byId('rr-tch').style.display, 'block');
  assert.equal(env.byId('rr-export').style.display, 'none');
  const up = env.byId('rr-tg'), t0 = env.session.car.y;
  env.dispatch(up, { type: 'touchstart' }); env.frames(40);
  assert.ok(Math.hypot(env.session.car.vx, env.session.car.vy) > 0.2);       // throttle held by the touch button
  env.dispatch(env.win, { type: 'blur' });
  assert.equal(env.byId('rr-tg').style.opacity, '0.5');
  env.dispatch(up, { type: 'touchend' });
});

test('expand button toggles photo-sized and expanded window', () => {
  const env = boot(); env.addPhoto().photo.click();
  const ov = env.byId('rah-race-ov');
  const btn = env.all(n => n.attributes.class === 'rr-expbtn')[0];
  btn.click(); assert.equal(ov.dataset.mode, 'expanded'); assert.equal(env.backdrops().length, 1);
  btn.click(); assert.equal(ov.dataset.mode, 'photo'); assert.equal(env.backdrops().length, 0);
  btn.click();
  env.backdrops()[0].click();                          // backdrop click contracts again
  assert.equal(ov.dataset.mode, 'photo');
  env.key('keydown', 'Escape');
  assert.equal(env.pendingTimers().length, 0);
});

test('without racing-core.js the entry point fails safely instead of throwing', () => {
  const env = makeEnv(); env.loadAll(['racing-game.js']);
  const errs = []; env.win.console = { error: m => errs.push(m) };
  env.win.rahOpenRace();
  assert.equal(env.byId('rah-race-ov'), null);
  assert.equal(errs.length, 1);
});


test('presence starts only on Play, pauses/leaves, resumes, and stops on Quit', async () => {
  const env = boot({api:API});
  env.win.crypto = { getRandomValues(bytes) { bytes.fill(42); return bytes; } };
  env.apiHandler = () => env.resp(200, {ok:true,entries:[]});
  env.win.rahOpenRace('noob-gp-v3'); await env.flush();
  const posts = () => env.fetchCalls.filter(c => c.url.endsWith('/api/presence')).map(c=>JSON.parse(c.init.body));
  assert.equal(posts().length,0);
  startRace(env); await env.flush(); assert.equal(posts().at(-1).active,true);
  env.advance(15001); await env.flush(); assert.equal(posts().length,2);
  env.dispatch(env.win,{type:'blur'}); await env.flush(); assert.equal(posts().at(-1).active,false);
  const pausedCount = posts().length; env.advance(15001); await env.flush(); assert.equal(posts().length,pausedCount);
  env.dispatch(env.win,{type:'focus'}); await env.flush(); assert.equal(posts().at(-1).active,true);
  env.byId('rr-quit').click(); await env.flush(); assert.equal(posts().at(-1).active,false);
  const closedCount = posts().length; env.advance(60000); await env.flush(); assert.equal(posts().length,closedCount);
  assert.ok(posts().every((p,i)=>p.sequence===i+1));
});


test('live peer cars render with names; switching tab parks locally but does not remove the peer', () => {
  const env=boot();let updates=[],closed=false;
  env.win.RacingLive={join:(id,name)=>({id:'a'.repeat(32),update:(car,driving)=>updates.push(driving),sync:()=>Promise.resolve(),close:()=>{closed=true;}}),
    peers:()=>[{sessionId:'b'.repeat(32),name:'Other driver',x:200,y:200,angle:0,driving:false}]};
  env.win.rahOpenRace('noob-gp-v3');startRace(env);env.frames(3);
  assert.ok(env.byId('rr-canvas').getContext().calls.some(c=>c[0]==='fillText'&&c[1].includes('Other driver')));
  env.dispatch(env.win,{type:'blur'});env.frames(3);
  assert.equal(updates.at(-1),false);
  env.byId('rr-quit').click();assert.equal(closed,true);
});


test('an occupied live spawn chooses a separate lane, and peer labels sit below own name', () => {
  const env=boot(),track=Core.tracks[0];
  env.win.RacingLive={join:()=>({id:'a'.repeat(32),update(){},sync(){},close(){}}),
    peers:()=>[{sessionId:'b'.repeat(32),name:'VISIBLE PEER',...track.spawn,driving:false}]};
  env.win.rahOpenRace(track.id);startRace(env);env.frames(2);
  assert.ok(Math.hypot(env.session.car.x-track.spawn.x,env.session.car.y-track.spawn.y)>=10);
  const call=env.byId('rr-canvas').getContext().calls.find(c=>c[0]==='fillText'&&c[1].includes('VISIBLE PEER'));
  assert.ok(call && call[3]>track.spawn.y,'peer label stays visible below car');
  env.byId('rr-quit').click();
});


test('late server discovery separates a stationary overlapping car once and cleans up subscription', () => {
  const env=boot(),track=Core.tracks[0];let peers=[],listener,unsubscribed=false,updates=0;
  env.win.RacingLive={join:()=>({id:'f'.repeat(32),update(){updates++;},sync(){},close(){}}),
    peers:()=>peers,subscribe:fn=>{listener=fn;return()=>{unsubscribed=true;};}};
  env.win.rahOpenRace(track.id);startRace(env);
  assert.ok(Math.hypot(env.session.car.x-track.spawn.x,env.session.car.y-track.spawn.y)<1);
  peers=[{sessionId:'1'.repeat(32),name:'REMOTE',...track.spawn,driving:false}];listener();
  assert.ok(Math.hypot(env.session.car.x-track.spawn.x,env.session.car.y-track.spawn.y)>=10);
  const x=env.session.car.x,y=env.session.car.y,count=updates;listener();
  assert.equal(env.session.car.x,x);assert.equal(env.session.car.y,y);assert.equal(updates,count);
  env.byId('rr-quit').click();assert.equal(unsubscribed,true);
});

test('deprecated weekly argument cannot enable challenge mode; free play still posts null challenge',async()=>{
 const env=boot({api:API});let posted=[];env.apiHandler=(url,init)=>url===API+'/api/laps'?(posted.push(JSON.parse(init.body)),env.resp(200,{saved:true})):env.resp(200,{entries:[]});
 env.win.rahOpenRace('cadiz-city-v3',true);assert.equal(env.byId('rr-chal'),null);startRace(env,'Ana');assert.equal(env.session.track.id,'cadiz-city-v3');assert.doesNotMatch(env.text('rr-info'),/WEEKLY/);
 env.race(lapDone(env),{maxFrames:6000});await env.flush();assert.equal(posted.length,1);assert.equal(posted[0].challengeId,null);
});
test('visible game board polls5s with active racers,15s idle, never overlaps, stops hidden/closed',async()=>{
 const env=boot({api:API});let count=2,reads=0,hold=null;
 env.win.RacingLive={counts:()=>({'cadiz-city-v3':count}),join:()=>({id:'a'.repeat(32),update(){},sync(){},close(){}}),peers:()=>[]};
 env.apiHandler=(url)=>{if(url.includes('/api/leaderboard')){reads++;if(hold)return hold;return env.resp(200,{entries:[{name:'OTHER',ms:20000-reads}]});}return env.resp(200,{});};
 env.win.rahOpenRace('cadiz-city-v3');await env.flush();startRace(env,'Ana');await env.flush();const initial=reads;
 env.advance(5000);await env.flush();assert.equal(reads,initial+1);assert.match(env.text('rr-lb1'),/OTHER/);const ms=20000-reads;assert.ok(env.text('rr-lb1').includes('0:'+String(Math.floor(ms/1000)).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0')),'poll renders the new lap time, not only the old name');
 count=0;env.advance(5000);await env.flush();const idle=reads;env.advance(5000);await env.flush();assert.equal(reads,idle);env.advance(10000);await env.flush();assert.equal(reads,idle+1);
 let release;hold=new Promise(r=>release=r);env.advance(15000);await env.flush();const pending=reads;env.advance(15000);await env.flush();assert.equal(reads,pending);release(env.resp(200,{entries:[]}));hold=null;await env.flush();
 env.doc.hidden=true;env.dispatch(env.doc,{type:'visibilitychange'});const hidden=reads;env.advance(30000);await env.flush();assert.equal(reads,hidden);
 env.key('keydown','Escape');env.advance(60000);await env.flush();assert.equal(reads,hidden);
});

test('Legacy polling reuses its pending initial Firebase read instead of overlapping it',async()=>{
 const env=boot();const original=env.win.fetch;let reads=0,release;
 const slow=new Promise(r=>release=r);env.win.fetch=(url,init)=>String(url).endsWith('/rah-lb-wide-v2.json')?(reads++,slow):original(url,init);
 env.win.RacingLive={counts:()=>({legacy:1})};env.win.rahOpenRace('legacy');assert.equal(reads,1);
 env.advance(5000);await env.flush();assert.equal(reads,1);env.advance(5000);await env.flush();assert.equal(reads,1);
 release(env.resp(200,{PEER:12345}));await env.flush();assert.match(env.text('rr-lb0'),/PEER/);
 env.key('keydown','Escape');const closed=reads;env.advance(30000);await env.flush();assert.equal(reads,closed);
});

test('modal locks background scrolling and restores previous overflow on close',()=>{
 const env=boot();env.doc.body.style.overflow='auto';env.win.rahOpenRace('cadiz-city-v3');assert.equal(env.doc.body.style.overflow,'hidden');env.key('keydown','Escape');assert.equal(env.doc.body.style.overflow,'auto');
});
test('pointer touch captures fingers independently and releases on cancel, lost capture and blur',()=>{
 const env=boot({touch:true});env.win.PointerEvent=function(){};env.win.rahOpenRace('cadiz-city-v3');startRace(env);
 const up=env.byId('rr-tg'),left=env.byId('rr-tl'),captures=[],initial={x:env.session.car.x,y:env.session.car.y};up.setPointerCapture=id=>captures.push(id);left.setPointerCapture=id=>captures.push(id);
 env.dispatch(up,{type:'pointerdown',pointerId:11,button:0});env.dispatch(left,{type:'pointerdown',pointerId:12,button:0});env.frames(40);assert.ok(Math.hypot(env.session.car.x-initial.x,env.session.car.y-initial.y)>2);assert.deepEqual(captures,[11,12]);
 env.dispatch(up,{type:'pointercancel',pointerId:11});assert.equal(up.style.opacity,'0.5');assert.equal(left.style.opacity,'0.92');
 env.dispatch(left,{type:'lostpointercapture',pointerId:12});assert.equal(left.style.opacity,'0.5');env.dispatch(up,{type:'pointerdown',pointerId:15,button:0});env.dispatch(env.win,{type:'blur'});assert.equal(up.style.opacity,'0.5');
 env.key('keydown','Escape');for(const el of [up,left])for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture'])assert.equal(env.listeners(el,type),0);
});
test('game exposes an explicit mobile leaderboard toggle while desktop board stays mounted',()=>{
 const env=boot({touch:true});env.win.rahOpenRace('cadiz-city-v3');startRace(env);const btn=env.byId('rr-board-toggle');assert.ok(btn);assert.equal(btn.getAttribute('aria-expanded'),'false');btn.click();assert.equal(btn.getAttribute('aria-expanded'),'true');assert.equal(env.byId('rah-race-ov').dataset.boardOpen,'true');btn.click();assert.equal(btn.getAttribute('aria-expanded'),'false');assert.ok(env.byId('rr-lb1'));
});

test('visual viewport resize updates mobile dialog height and removes listeners on close',()=>{
 const env=boot({touch:true}),listeners=new Map(),values={};env.win.visualViewport={height:600,offsetTop:0,scale:1,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)};
 env.win.rahOpenRace('cadiz-city-v3');const ov=env.byId('rah-race-ov');ov.style.setProperty=(k,v)=>values[k]=v;env.win.visualViewport.height=360;
 assert.ok(listeners.has('resize'));listeners.get('resize')();assert.equal(values['--rr-viewport-height'],'360px');env.key('keydown','Escape');assert.equal(listeners.size,0);
});

test('touch hardware without ontouchstart still gets controls through maxTouchPoints',()=>{
 const env=boot();env.win.navigator={maxTouchPoints:2};env.win.rahOpenRace('cadiz-city-v3');startRace(env);assert.equal(env.byId('rr-tch').style.display,'block');env.key('keydown','Escape');
});

for(const ratio of [1,1.5,2])test('new-track minimap preserves CSS size at DPR '+ratio,()=>{
 const env=boot();env.win.devicePixelRatio=ratio;env.win.rahOpenRace('cadiz-city-v3');startRace(env);env.frames(2);
 const calls=env.byId('rr-canvas').getContext('2d').calls;const index=calls.findLastIndex(c=>c[0]==='strokeRect');assert.ok(index>=0);
 assert.deepEqual(calls[index].slice(1),[7,7,114,76]);const transform=calls.slice(0,index).findLast(c=>c[0]==='setTransform');assert.deepEqual(transform.slice(1),[ratio,0,0,ratio,0,0]);
 env.key('keydown','Escape');
});
test('Legacy minimap keeps its track-space transform at DPR2',()=>{
 const env=boot();env.win.devicePixelRatio=2;env.win.rahOpenRace('legacy');startRace(env);env.frames(2);const canvas=env.byId('rr-canvas'),calls=canvas.getContext('2d').calls,index=calls.findLastIndex(c=>c[0]==='strokeRect');
 const transform=calls.slice(0,index).findLast(c=>c[0]==='setTransform');assert.equal(transform[1],Math.min(canvas.width/900,canvas.height/560));env.key('keydown','Escape');
});
