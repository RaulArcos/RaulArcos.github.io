'use strict';
// Racing Lab page section: structural checks on index.html / racing-lab.css / README.md, and behavior checks
// that run the real racing-core.js + racing-lab.js in a node:vm context against a tiny fake DOM built from
// the real #racing-lab markup of index.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const INDEX = read('index.html');
const Core = require(path.join(ROOT, 'racing-core.js'));
const IDS = Core.tracks.map(t => t.id);
const PROFILE = 'https://members.iracing.com/membersite/member/CareerStats.do?custid=533432';

const sectionHtml = () => {
  const a = INDEX.indexOf('<section id="racing-lab"');
  assert.ok(a >= 0, 'index.html has a <section id="racing-lab">');
  return INDEX.slice(a, INDEX.indexOf('</section>', a) + '</section>'.length);
};
const flat = s => s.replace(/\s+/g, ' ').trim();

// ── structural: index.html ────────────────────────────────────────────────
test('index.html loads the stylesheet in <head> and the scripts in order outside the template', () => {
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.match(head, /<link rel="stylesheet" href="\.\/racing-lab\.css\?v=[^"]+">/);
  const tplStart = INDEX.indexOf('<x-dc>'), tplEnd = INDEX.indexOf('</x-dc>');
  const at = f => INDEX.indexOf(`<script src="./${f}?v=20261024-phone-ready"></script>`);
  const order = ['racing-config.js', 'racing-core.js', 'racing-live.js', 'racing-game.js', 'racing-lab.js'].map(at);
  assert.ok(order.every(i => i > tplEnd), 'all four scripts come after </x-dc>');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'config < core < game < lab');
  assert.ok(!INDEX.slice(tplStart, tplEnd).includes('<script'), 'no script inside the DC template');
  assert.equal(INDEX.split('racing-game.js').length - 1, 1, 'racing-game.js is loaded once');
});

test('the Racing Lab section sits after the marquee and before Experience', () => {
  const m = INDEX.indexOf('data-screen-label="Marquee"'), s = INDEX.indexOf('<div id="racing-lab-slot"'), e = INDEX.indexOf('<section id="experience"');
  assert.ok(m > 0 && m < s && s < e);
});

test('header navigation and a prominent hero anchor point at #racing-lab', () => {
  const nav = INDEX.slice(INDEX.indexOf('<nav class="rah-nav"'), INDEX.indexOf('</nav>'));
  assert.match(nav, /<a href="#racing-lab"[^>]*data-i18n="nav\.racing"/);
  const hero = INDEX.slice(INDEX.indexOf('<section id="hero"'), INDEX.indexOf('</section>', INDEX.indexOf('<section id="hero"')));
  assert.match(hero, /<a href="#racing-lab"[^>]*class="rl-hero-cta"[^>]*data-i18n="hero\.racing"/);
});

test('site dictionaries translate the new nav/hero strings and announce the language', () => {
  for (const key of ['nav.racing', 'hero.racing']) assert.equal(INDEX.split(`'${key}':`).length - 1, 2, `${key} in EN and ES`);
  assert.match(INDEX, /setAttribute\('data-language', lang\)/);
  assert.match(INDEX, /new CustomEvent\('rah-lang'/);
});

test('the section exposes three track cards, no weekly challenge and the Legacy Circuit as plain buttons', () => {
  const html = sectionHtml();
  for (const id of IDS) assert.match(html, new RegExp(`<button type="button"[^>]*data-race-track="${id}"`), id);
  assert.match(html, /<button type="button"[^>]*data-race-track="legacy"/);
  assert.doesNotMatch(html, /data-race-weekly|data-lab-week/);
  assert.equal((html.match(/data-lab-preview="/g) || []).length, 3, 'three tracks');
  assert.ok(!/\sonclick=/i.test(html), 'no inline handlers (the DC runtime consumes them as React props)');
  assert.ok(!/<svg|<script/i.test(html), 'previews are drawn by racing-lab.js, not hand-written');
  for (const t of Core.tracks) assert.ok(html.includes(t.name), `static fallback names ${t.name}`);
});

test('personal ghost copy is honest and no reference lap by anyone else is claimed', () => {
  const text = flat(sectionHtml().replace(/<[^>]+>/g, ' '));
  assert.match(text, /your own first valid lap/i);
  assert.match(text, /this device/i);
  assert.ok(!/(race|beat|chase|vs\.?)\s+ra[uú]l|ra[uú]l'?s (ghost|best|record)/i.test(text), 'no fabricated Raul reference');
});

test('iRacing card is a static identity with a real profile link and no invented stats', () => {
  const html = sectionHtml();
  assert.ok(html.includes(`href="${PROFILE}"`), 'profile link');
  const card = html.slice(html.indexOf('data-lab-iracing'));
  const text = flat(card.replace(/<[^>]+>/g, ' '));
  assert.match(text, /RaulArcos2/);
  assert.match(text, /533432/);
  assert.match(text, /unavailable/i);
  assert.match(text, /not connected/i);
  assert.match(text, /log ?in/i);
  assert.ok(!/updated|last sync|as of|\d+\s*(ir|irating)\b|safety rating\s*[:\d]/i.test(text), 'no fake timestamps or ratings');
  assert.ok(!/<time\b/.test(card));
});

// ── structural: racing-lab.css ────────────────────────────────────────────
test('racing-lab.css is scoped, responsive, accessible and respects reduced motion', () => {
  const css = read('racing-lab.css');
  assert.match(css, /prefers-reduced-motion:\s*no-preference/, 'animations only when motion is welcome');
  assert.match(css, /html:root\s*\{\s*scroll-behavior:\s*auto/, 'reduce smooth scrolling');
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height:\s*4[4-9]px/, 'touch targets');
  assert.match(css, /@media \(max-width:\s*760px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.ok(!/\b100vw\b/.test(css), '100vw causes horizontal overflow');
  let outside = css;                                      // brace-aware removal of the no-preference block
  const open = outside.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(open >= 0);
  let depth = 0, end = outside.indexOf('{', open);
  for (let i = end; i < outside.length; i++) { if (outside[i] === '{') depth++; else if (outside[i] === '}' && --depth === 0) { end = i; break; } }
  outside = outside.slice(0, open) + outside.slice(end + 1);
  assert.ok(!/animation\s*:|@keyframes/.test(outside), 'no animation outside the no-preference media query');
});

// ── structural: README ────────────────────────────────────────────────────
test('README documents local preview, tests, load order and deployed VPS backend', () => {
  const md = read('README.md');
  assert.match(md, /python -m http\.server 8000/);
  assert.match(md, /node --test tests\/\*\.test\.cjs/);
  for (const f of ['racing-config.js', 'racing-core.js', 'racing-game.js', 'racing-lab.js']) assert.ok(md.includes(f), f);
  assert.ok(md.indexOf('racing-config.js') < md.indexOf('racing-core.js') && md.indexOf('racing-core.js') < md.indexOf('racing-game.js') && md.indexOf('racing-game.js') < md.indexOf('racing-lab.js'));
  assert.match(md, /server\/README\.md/);
  assert.match(md, /api\.ircopilot\.com\/racing/);
  assert.match(md, /publishing remains manual/i);
});

// ── behavior: fake DOM harness ────────────────────────────────────────────
function makeEnv(opts = {}) {
  const env = { nowMs: opts.nowMs !== undefined ? opts.nowMs : Date.UTC(2026, 9, 22, 12), intervals: new Map(), nextId: 0, openCalls: [], observers: [], errors: [] };
  const target = o => {
    o._l = [];
    o.addEventListener = (type, fn) => { if (!o._l.some(l => l.type === type && l.fn === fn)) o._l.push({ type, fn }); };
    o.removeEventListener = (type, fn) => { o._l = o._l.filter(l => !(l.type === type && l.fn === fn)); };
    return o;
  };
  const matcher = sel => sel.split(',').map(s => s.trim()).map(s => {
    if (/^[a-z]+$/i.test(s)) return n => n.localName === s.toLowerCase();
    let m = /^#([\w-]+)$/.exec(s);
    if (m) return n => n.attributes.id === m[1];
    m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
    if (m) return n => m[1] in n.attributes && (m[2] === undefined || n.attributes[m[1]] === m[2]);
    throw new Error('fake DOM: unsupported selector ' + s);
  });
  const matches = (n, sel) => n.nodeType === 1 && matcher(sel).some(f => f(n));
  const doc = target({ nodeType: 9, parentNode: null, readyState: 'complete' });
  class El {
    constructor(tag, ns) { this.tagName = String(tag).toUpperCase(); this.localName = tag; this.namespaceURI = ns || null; this.nodeType = 1; this.attributes = {}; this.childNodes = []; this.parentNode = null; target(this); }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get isConnected() { for (let n = this; n; n = n.parentNode) if (n === doc) return true; return false; }
    get textContent() { return this.childNodes.map(n => (n.nodeType === 3 ? n.data : n.textContent)).join(''); }
    set textContent(v) { this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild({ nodeType: 3, data: String(v), parentNode: null }); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(n => n !== c); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    setAttributeNS(ns, k, v) { this.setAttribute(k, v); }
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
    hasAttribute(k) { return k in this.attributes; }
    removeAttribute(k) { delete this.attributes[k]; }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
    querySelectorAll(sel) { const out = []; const w = n => n.children.forEach(c => { if (matches(c, sel)) out.push(c); w(c); }); w(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  doc.createElement = t => new El(t);
  doc.createElementNS = (ns, t) => new El(t, ns);
  doc.documentElement = new El('html'); doc.documentElement.parentNode = doc;
  doc.body = new El('body'); doc.documentElement.appendChild(doc.body);
  doc.querySelectorAll = sel => doc.documentElement.querySelectorAll(sel);
  doc.getElementById = id => { let f = null; const w = n => n.children.forEach(c => { if (!f && c.attributes.id === id) f = c; w(c); }); w(doc.documentElement); return f; };

  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, '\u00a0');
  const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link']);
  env.parse = html => {
    const top = new El('div'); let cur = top, m;
    const re = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    while ((m = re.exec(html))) {
      if (m[1]) { let n = cur; while (n && n !== top && n.localName !== m[1]) n = n.parentNode; if (n && n !== top) cur = n.parentNode; }
      else if (m[2]) {
        const el = new El(m[2]); const ar = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g; let a;
        while ((a = ar.exec(m[3]))) el.attributes[a[1]] = decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : '');
        cur.appendChild(el);
        if (!VOID.has(m[2].toLowerCase()) && !/\/\s*$/.test(m[3])) cur = el;
      } else if (m[4] !== undefined && m[4].trim() !== '') cur.appendChild({ nodeType: 3, data: decode(m[4]), parentNode: null });
    }
    return top.children[0];
  };
  env.mount = () => doc.body.appendChild(env.parse(sectionHtml()));

  env.dispatch = (node, e) => {
    const path = []; for (let n = node; n; n = n.parentNode) path.push(n);
    e.target = node; e.defaultPrevented = false; e.preventDefault = () => { e.defaultPrevented = true; };
    for (const n of path) for (const l of n._l.slice()) if (l.type === e.type) { e.currentTarget = n; l.fn.call(n, e); }
    return e;
  };
  env.click = node => env.dispatch(node, { type: 'click' });

  const win = target({ document: doc, console: { error: (...a) => env.errors.push(a.join(' ')), log() {}, warn() {} }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } } });
  env.store = new Map();
  win.localStorage = { getItem: k => (env.store.has(k) ? env.store.get(k) : null), setItem: (k, v) => { env.store.set(k, String(v)); } };
  doc.dispatchEvent = e => env.dispatch(doc, e);
  win.window = win;
  win.setInterval = (fn, ms) => { env.intervals.set(++env.nextId, { fn, ms, last: env.nowMs }); return env.nextId; };
  win.clearInterval = id => { env.intervals.delete(id); };
  win.MutationObserver = class { constructor(cb) { this.cb = cb; this.connected = false; env.observers.push(this); } observe(t, o) { this.connected = true; this.target = t; this.options = o; } disconnect() { this.connected = false; } };
  win.__env = env;
  env.win = win; env.doc = doc;
  const ctx = vm.createContext(win);
  env.ctx = ctx;
  vm.runInContext(`(function () { const D = Date; class FD extends D { constructor(...a) { if (a.length === 0) super(__env.nowMs); else super(...a); } static now() { return __env.nowMs; } } window.Date = FD; })()`, ctx);
  env.load = f => vm.runInContext(read(f), ctx, { filename: f });
  env.boot = (files = ['racing-core.js', 'racing-lab.js']) => { for (const f of files) env.load(f); };
  win.rahOpenRace = (...a) => { env.openCalls.push(a); };

  env.advance = ms => {                                    // move virtual time and fire due intervals
    const end = env.nowMs + ms;
    for (;;) {
      const due = [...env.intervals.values()].filter(t => t.last + t.ms <= end).sort((a, b) => a.last - b.last)[0];
      if (!due) break;
      due.last += due.ms; env.nowMs = Math.max(env.nowMs, due.last); due.fn();
    }
    env.nowMs = end;
  };
  env.remount = () => {                                    // what a React re-render does: new nodes, then mutation records
    const old = doc.getElementById('racing-lab'); const fresh = env.parse(sectionHtml());
    if (old) { old.parentNode.appendChild(fresh); old.remove(); } else doc.body.appendChild(fresh);
    env.mutate(fresh);
    return fresh;
  };
  env.mutate = node => env.observers.filter(o => o.connected).forEach(o => o.cb([{ type: 'childList', addedNodes: [node], removedNodes: [], target: doc.body }]));
  env.setLang = lang => { doc.documentElement.setAttribute('data-language', lang); env.dispatch(doc, { type: 'rah-lang', detail: { lang } }); };

  const q = sel => doc.getElementById('racing-lab').querySelector(sel);
  env.q = q;
  env.text = sel => flat(q(sel).textContent);
  env.qa = sel => doc.getElementById('racing-lab').querySelectorAll(sel);
  env.listeners = (t, type) => t._l.filter(l => l.type === type).length;
  return env;
}
// The site's own i18n code (kept verbatim in index.html's DC script), run against the same fake DOM.
const loadSiteI18n = env => {
  const from = INDEX.indexOf('// ── i18n'), to = INDEX.indexOf('</script>', from);
  assert.ok(from > 0 && to > from, 'i18n block found');
  env.doc.body.appendChild(env.parse('<div><a data-i18n="nav.contact">CONTACT</a><a data-i18n="nav.racing">RACING LAB</a><a data-i18n="hero.racing">x</a><button id="rah-lang">EN / ES</button></div>'));
  vm.runInContext(INDEX.slice(from, to), env.ctx, { filename: 'index.html#i18n' });
};
const boot = (opts = {}, { mountFirst = true } = {}) => {
  const env = makeEnv(opts);
  if (opts.lang) env.doc.documentElement.setAttribute('data-language', opts.lang);
  if (mountFirst) env.mount();
  env.boot(opts.files);
  return env;
};
const countCmds = d => (d.match(/[ML]/g) || []).length;

// ── behavior ──────────────────────────────────────────────────────────────
test('three original track outlines are drawn from core.tracks points, plus this week\'s track', () => {
  const env = boot();
  for (const t of Core.tracks) {
    const box = env.q(`[data-lab-preview="${t.id}"]`);
    const svg = box.firstChild;
    assert.ok(svg && svg.localName === 'svg', `${t.id} svg`);
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.match(svg.getAttribute('viewBox'), new RegExp(`^${t.bounds.x} ${t.bounds.y} ${t.bounds.w} ${t.bounds.h}$`));
    const road = svg.querySelectorAll('[class="rl-road"]')[0];
    assert.equal(countCmds(road.getAttribute('d')), t.points.length, `${t.id} uses every centerline point`);
    assert.match(road.getAttribute('d'), /Z$/, 'closed ring');
    assert.equal(road.getAttribute('stroke-width'), String(t.width));
    assert.equal(box.getAttribute('data-lab-ready'), t.id);
  }

});



test('click delegation calls rahOpenRace with explicit arguments and no player name', () => {
  const env = boot();
  const press = sel => env.click(env.q(sel));
  press('[data-race-track="cadiz-city-v3"]');
  press('[data-race-track="spa-francorchamps-v3"]');
  press('[data-race-track="noob-gp-v3"]');
  press('[data-race-track="legacy"]');
  assert.deepEqual(env.openCalls, [['cadiz-city-v3'], ['spa-francorchamps-v3'], ['noob-gp-v3'], ['legacy']]);
  assert.equal(env.openCalls[0].length, 1, 'no extra arguments');
});

test('clicks on a child of a race button and on unrelated elements', () => {
  const env = boot();
  const child = env.parse('<span>x</span>'); env.q('[data-race-track="noob-gp-v3"]').appendChild(child);
  env.click(child);
  env.click(env.q('[data-lab-status]'));
  env.click(env.doc.body);
  assert.deepEqual(env.openCalls, [['noob-gp-v3']]);
});


test('no keyboard or gameplay listeners are attached by the page section', () => {
  const env = boot();
  for (const t of [env.win, env.doc, env.doc.body]) for (const type of ['keydown', 'keyup', 'keypress', 'blur', 'resize']) assert.equal(env.listeners(t, type), 0, type);
  assert.equal(env.openCalls.length, 0, 'nothing opens on load');
});

test('a missing or throwing race engine shows a status instead of throwing', () => {
  const env = boot();
  delete env.win.rahOpenRace;
  env.click(env.q('[data-race-track="cadiz-city-v3"]'));
  assert.match(env.text('[data-lab-status]'), /did not load/i);
  env.win.rahOpenRace = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => env.click(env.q('[data-race-track="cadiz-city-v3"]')));
  assert.match(env.text('[data-lab-status]'), /did not load|could not/i);
});

test('without racing-core.js the buttons still delegate and nothing throws', () => {
  const env = boot({ files: ['racing-lab.js'] });
  env.click(env.q('[data-race-track="legacy"]'));
  assert.deepEqual(env.openCalls, [['legacy']]);
  assert.equal(env.q('[data-lab-preview="cadiz-city-v3"]').firstChild, null);
  assert.deepEqual(env.errors, []);
});

test('EN/ES: every translated key changes language, in both directions', () => {
  const env = boot();
  const keyed = () => env.qa('[data-lab-i18n]').map(e => [e.getAttribute('data-lab-i18n') + '|' + (e.getAttribute('data-lab-arg') || ''), flat(e.textContent)]);
  const en = keyed();
  assert.ok(en.length >= 14, 'plenty of translated strings');
  env.setLang('es');
  const es = keyed();
  const same = en.filter(([k, v], i) => es[i][1] === v).map(([k]) => k);
  assert.deepEqual(same.filter(k => !/^(kicker|ir\.id)\|/.test(k)), [], 'every string except language-neutral ones changes');
  assert.ok(es.every(([, v]) => v !== ''));
  assert.equal(env.doc.getElementById('racing-lab').getAttribute('lang'), 'es');
  assert.match(env.text('[data-race-track="noob-gp-v3"]'), /^CORRER NOOB GP/);
  assert.match(env.text('[data-lab-desc="noob-gp-v3"]'), /monta|sierra|esses|curvas|grand premio|gran premio/i);
  assert.equal(env.text('[data-lab-diff="spa-francorchamps-v3"]'), 'Difícil');
  env.setLang('en');
  assert.deepEqual(keyed(), en);
  assert.match(env.text('[data-race-track="noob-gp-v3"]'), /^RACE NOOB GP/);
  assert.equal(env.text('[data-lab-diff="spa-francorchamps-v3"]'), 'Hard');
});

test('EN/ES: language already chosen before the section mounts is honoured, and dates/names stay stable', () => {
  const env = boot({ lang: 'es' }, { mountFirst: false });
  env.mount(); env.mutate(env.doc.getElementById('racing-lab'));
  assert.equal(env.q('[data-lab-preview="noob-gp-v3"]').getAttribute('data-lab-ready'), 'noob-gp-v3');
});

test('a section that mounts after the script (async DC template) gets previews, text and one timer', () => {
  const env = boot({}, { mountFirst: false });
  assert.equal(env.intervals.size, 0, 'no timer before the section exists');
  assert.ok(env.observers.some(o => o.connected && o.options.childList && o.options.subtree));
  env.mount(); env.mutate(env.doc.getElementById('racing-lab'));
  assert.equal(env.qa('[data-lab-ready]').length, 3);
  assert.equal(env.intervals.size, 1);
});

test('React re-render keeps previews, re-translates, and never duplicates handlers or timers', () => {
  const env = boot();
  env.setLang('es');
  const fresh = env.remount();
  assert.ok(fresh.isConnected);
  assert.equal(env.qa('[data-lab-ready]').length, 3, 'previews redrawn on the new nodes');
  assert.match(env.text('[data-race-track="cadiz-city-v3"]'), /^CORRER/, 'language kept');
  assert.equal(env.intervals.size, 1, 'one countdown timer');
  assert.equal(env.listeners(env.doc, 'click'), 1);
  assert.equal(env.listeners(env.doc, 'rah-lang'), 1);
  env.remount(); env.remount();
  env.click(env.q('[data-race-track="noob-gp-v3"]'));
  assert.deepEqual(env.openCalls, [['noob-gp-v3']], 'one call per click');
  env.advance(1000);
  // an unrelated mutation (the game overlay, say) leaves everything as it was
  const svg = env.q('[data-lab-preview="noob-gp-v3"]').firstChild;
  env.mutate(env.parse('<div>overlay</div>'));
  assert.equal(env.qa('[data-lab-ready]').length, 3);
  assert.equal(env.q('[data-lab-preview="noob-gp-v3"]').firstChild, svg, 'drawn previews are kept, not rebuilt');
});

test('timers do not leak when the section is removed, and resume when it returns', () => {
  const env = boot();
  assert.equal(env.intervals.size, 1);
  env.doc.getElementById('racing-lab').remove();
  env.advance(15000);
  assert.equal(env.intervals.size, 0, 'the countdown stops once its section is gone');
  env.remount();
  assert.equal(env.intervals.size, 1);
});

test('loading the script twice replaces the first instance', () => {
  const env = boot();
  env.load('racing-lab.js');
  assert.equal(env.listeners(env.doc, 'click'), 1);
  assert.equal(env.listeners(env.doc, 'rah-lang'), 1);
  assert.equal(env.intervals.size, 1);
  assert.equal(env.observers.filter(o => o.connected).length, 1);
  env.click(env.q('[data-race-track="legacy"]'));
  assert.deepEqual(env.openCalls, [['legacy']]);
});

test('destroy() detaches everything', () => {
  const env = boot();
  env.win.RacingLabPage.destroy();
  assert.equal(env.listeners(env.doc, 'click'), 0);
  assert.equal(env.listeners(env.doc, 'rah-lang'), 0);
  assert.equal(env.intervals.size, 0);
  assert.equal(env.observers.filter(o => o.connected).length, 0);
  env.click(env.q('[data-race-track="legacy"]'));
  assert.deepEqual(env.openCalls, []);
});

test('hostile text from storage or the DOM is never interpreted as markup', () => {
  const env = boot();
  const src = read('racing-lab.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src));
});

// ── preserve: the site's language toggle keeps working and now also announces the language ──
test('rahApplyLang still translates [data-i18n], labels the toggle and stores the choice', () => {
  const env = boot();
  loadSiteI18n(env);
  const nav = env.doc.body.querySelector('[data-i18n="nav.contact"]'), btn = env.doc.getElementById('rah-lang');
  env.win.rahApplyLang('es');
  assert.equal(nav.textContent, 'CONTACTO');
  assert.equal(env.doc.body.querySelector('[data-i18n="nav.racing"]').textContent, 'RACING LAB');
  assert.match(env.doc.body.querySelector('[data-i18n="hero.racing"]').textContent, /CORRE EN ESTA WEB/);
  assert.equal(btn.textContent, 'ES / EN');
  assert.equal(env.store.get('rah-lang'), 'es');
  env.win.rahApplyLang('en');
  assert.equal(nav.textContent, 'CONTACT');
  assert.match(env.doc.body.querySelector('[data-i18n="hero.racing"]').textContent, /RACE ON THIS SITE/);
  assert.equal(btn.textContent, 'EN / ES');
  assert.equal(env.store.get('rah-lang'), 'en');
});

test('the real language toggle drives the Racing Lab section end to end', () => {
  const env = boot();
  loadSiteI18n(env);
  env.win.rahToggleLang();
  assert.equal(env.doc.documentElement.getAttribute('data-language'), 'es');
  assert.equal(env.doc.documentElement.getAttribute('lang'), 'es');
  env.win.rahToggleLang();
});


test('Lab is always visible on load, language change and remount; hero remains an anchor', () => {
  const env=boot();assert.equal(env.q('#rl-content').hasAttribute('hidden'),false);
  assert.equal(env.q('[data-lab-toggle]'),null);assert.equal(env.openCalls.length,0);
  env.setLang('es');assert.equal(env.q('#rl-content').hasAttribute('hidden'),false);
  env.remount();assert.equal(env.q('#rl-content').hasAttribute('hidden'),false);
  const link=env.parse('<a href="#racing-lab">Race</a>');env.doc.body.appendChild(link);env.click(link);
  assert.equal(env.openCalls.length,0);assert.equal(env.q('#rl-content').hasAttribute('hidden'),false);
  env.win.RacingLabPage.destroy();
});
test('cards show real device bests and unknown presence without a backend', () => {
  const env = makeEnv(); env.mount(); env.boot(['racing-core.js']);
  const core = env.win.RacingLabCore;
  core.recordScore(env.win.localStorage, 'cadiz-city-v3', null, 'Driver', 65432);
  env.boot(['racing-lab.js']);
  assert.match(env.text('[data-lab-target="cadiz-city-v3"]'), /1:05\.432/);
  assert.match(env.text('[data-lab-target="spa-francorchamps-v3"]'), /no time/i);
  assert.equal(env.text('[data-lab-presence="cadiz-city-v3"]'), '');
  assert.equal(env.q('[data-lab-presence="cadiz-city-v3"]').hasAttribute('hidden'),true);
  env.setLang('es');
  assert.equal(env.text('[data-lab-presence="cadiz-city-v3"]'), '');
  env.win.RacingLabPage.destroy();
});


test('card bubbles distinguish live zero, active racers and service failure; target uses real fastest time', async () => {
  const env = makeEnv(); env.mount(); env.boot(['racing-core.js']);
  let counts = {'cadiz-city-v3':2,'spa-francorchamps-v3':0,'noob-gp-v3':1};
  let calls = 0;
  env.win.RacingLabCore.createApi = () => ({
    presence: async()=> { calls++;return counts; },
    leaderboard: async id => id === 'cadiz-city-v3' ? [{name:'Fast',ms:54321}] : [],
  });
  env.boot(['racing-lab.js']);
  assert.equal(calls,1,'visible section requests real card data on mount');
  await new Promise(setImmediate);
  assert.match(env.text('[data-lab-presence="cadiz-city-v3"]'),/^2 racing$/);
  assert.equal(env.text('[data-lab-presence="spa-francorchamps-v3"]'),'');
  assert.equal(env.q('[data-lab-presence="spa-francorchamps-v3"]').hasAttribute('hidden'),true);
  assert.match(env.text('[data-lab-target="cadiz-city-v3"]'),/0:54\.321.*Fast.*community/);
  counts=null;await env.win.RacingLabPage.refreshCards(true);
  assert.equal(env.text('[data-lab-presence="cadiz-city-v3"]'),'');
  assert.equal(env.q('[data-lab-presence="cadiz-city-v3"]').hasAttribute('hidden'),true);
  env.doc.hidden=true;const last=calls;env.advance(16000);
  assert.equal(calls,last,'background document does not poll');
  env.win.RacingLabPage.destroy();
});


test('removal-only React preview changes repair before any Play action', () => {
  const env=boot();const box=env.q('[data-lab-preview="cadiz-city-v3"]');const old=box.firstChild;
  box.textContent='';
  for(const observer of env.observers.filter(o=>o.connected))observer.cb([{type:'childList',target:box,addedNodes:[],removedNodes:[old]}]);
  assert.ok(box.querySelector('svg'),'preview must return without opening the race');
  assert.equal(env.openCalls.length,0);
  env.win.RacingLabPage.destroy();
});


test('React owns an empty slot; the Lab template is outside x-dc ownership', () => {
  const start=INDEX.indexOf('<x-dc>'),end=INDEX.indexOf('</x-dc>');
  assert.match(INDEX.slice(start,end),/<div id="racing-lab-slot"><\/div>/);
  assert.equal(INDEX.slice(start,end).includes('<section id="racing-lab"'),false);
  assert.ok(INDEX.indexOf('<template id="racing-lab-template">')>end);
});


test('every preview has terrain before Play: sea for Cádiz, grass for the other circuits', () => {
  const env=boot();
  for(const track of Core.tracks) {
    const rect=env.q('[data-lab-preview="'+track.id+'"]').querySelector('[data-terrain]');
    assert.ok(rect);assert.equal(rect.getAttribute('data-terrain'),track.geography?'sea':'grass');
  }
  assert.equal(env.openCalls.length,0);env.win.RacingLabPage.destroy();
});

test('requested difficulty labels; no weekly UI in either language',()=>{
 const env=boot();for(const [id,label] of [['noob-gp-v3','Easy'],['cadiz-city-v3','Medium'],['spa-francorchamps-v3','Hard']])assert.equal(env.text(`[data-lab-diff="${id}"]`),label);
 for(const lang of ['en','es']){env.setLang(lang);assert.equal(env.q('[data-race-weekly]'),null);assert.equal(env.q('[data-lab-week]'),null);}
});
test('page refresh cadence follows activity, hidden tabs suspend, idle remains15s',async()=>{
 const env=makeEnv();env.mount();env.load('racing-core.js');let n=0,active=2;
 env.win.RACING_API_URL='https://api.test';env.win.RacingLabCore.createApi=()=>({presence:async()=>Object.fromEntries(IDS.map(id=>[id,active])),leaderboard:async()=>{n++;return [{name:'PEER',ms:20000-n}];}});
 env.load('racing-lab.js');const flush=()=>new Promise(r=>setImmediate(r));await flush();assert.equal(n,3);
 env.advance(4999);await flush();assert.equal(n,3);env.advance(1);await flush();assert.equal(n,6);assert.match(env.text('[data-lab-target="cadiz-city-v3"]'),/0:19\.996.*PEER/);
 active=0;env.advance(5000);await flush();assert.equal(n,9);env.advance(5000);await flush();assert.equal(n,9);env.advance(10000);await flush();assert.equal(n,12);
 env.doc.hidden=true;env.dispatch(env.doc,{type:'visibilitychange'});assert.equal(env.intervals.size,0);env.advance(30000);await flush();assert.equal(n,12);
 env.doc.hidden=false;env.dispatch(env.doc,{type:'visibilitychange'});await flush();assert.equal(n,15);
 env.win.RacingLabPage.destroy();assert.equal(env.intervals.size,0);
});

test('zero local observations and remote zero both stay empty; stalled page reads never overlap',async()=>{
 const env=makeEnv();env.mount();env.load('racing-core.js');let reads=0,release;
 env.win.RACING_API_URL='https://api.test';env.win.RacingLive={counts:()=>Object.fromEntries(IDS.map(id=>[id,0])),subscribe:()=>()=>{}};
 const stalled=new Promise(r=>release=r);
 env.win.RacingLabCore.createApi=()=>({presence:async()=>Object.fromEntries(IDS.map(id=>[id,0])),leaderboard:()=>{reads++;return stalled;}});
 env.load('racing-lab.js');env.advance(30000);env.win.RacingLabPage.refreshCards(true);assert.equal(reads,3);
 for(const el of env.qa('[data-lab-presence]')){assert.equal(el.textContent,'');assert.ok(el.hasAttribute('hidden'));}
 release([]);await new Promise(r=>setImmediate(r));assert.equal(reads,3);env.win.RacingLabPage.destroy();
});
