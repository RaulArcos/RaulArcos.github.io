// racing-lab.js — page integration for the Racing Lab section of index.html.
// Draws the track outline previews, translates the section (EN/ES)
// and turns clicks on [data-race-track] into rahOpenRace(...) calls.
// Load order (outside the DC template): racing-config.js, racing-core.js, racing-game.js, racing-lab.js.
// It never captures keys and never starts a race: the game does that after its own Start button.
(function (win) {
  'use strict';
  if (win.RacingLabPage && typeof win.RacingLabPage.destroy === 'function') win.RacingLabPage.destroy();

  const doc = win.document;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const I18N = {
    en: {
      'target': 'TIME TO BEAT', 'empty': 'No time yet — set the first lap',
      'browser': 'this browser', 'local': 'this device', 'online': 'community', 'unknown': 'Presence unavailable',
      'racing': 'racing', 'kicker': '00 — RACING LAB',
      'title': 'Race the circuits I built.',
      'lead': 'Cádiz City, Spa-Francorchamps, Noob GP and the Legacy circuit. Pick one: nothing starts, and no keys are captured, until you press Start.',
      'track.cta': 'RACE {name} ▶',
      'legacy.label': 'LEGACY CIRCUIT',
      'legacy.title': 'The original circuit',
      'legacy.desc': 'The original outline with a wider road and a fresh leaderboard. Earlier records are kept separately.',
      'legacy.cta': 'RACE THE LEGACY CIRCUIT ▶',
      'ghost.label': 'PERSONAL GHOST',
      'ghost.title': 'Race your own best lap',
      'ghost.body': 'Record your own first valid lap and it becomes your ghost on this device. Only a faster valid lap replaces it. No reference lap by anyone else is included.',
      'ir.label': 'IRACING IDENTITY',
      'ir.cust': 'CUSTOMER ID',
      'ir.note': 'Static identity only. Ratings and results are unavailable: iRacing API access is not connected, so no live stats are shown. The profile page may ask you to log in to iRacing.',
      'ir.link': 'OPEN IRACING PROFILE ↗',
      'status.engine': 'The race engine did not load. Reload the page and try again.',
      'diff.Easy': 'Easy',
      'diff.Medium': 'Medium',
      'diff.Hard': 'Hard',
      'desc.cadiz-city-v3': 'Cádiz coastline: La Caleta, Genovés, Puerta de Tierra, Playa Victoria and Cortadura.',
      'desc.spa-francorchamps-v3': 'A simplified Spa outline, from La Source and Eau Rouge to Kemmel and Blanchimont.',
      'desc.noob-gp-v3': 'Long mountain grand prix: sweeping esses, a downhill double-apex and a fast final bend.',
    },
    es: {
      'target': 'TIEMPO A BATIR', 'empty': 'Sin tiempo — marca la primera vuelta',
      'browser': 'este navegador', 'local': 'este dispositivo', 'online': 'comunidad', 'unknown': 'Presencia no disponible',
      'racing': 'corriendo', 'kicker': '00 — RACING LAB',
      'title': 'Corre los circuitos que construí.',
      'lead': 'Cádiz City, Spa-Francorchamps, Noob GP y el circuito clásico. Elige uno: nada empieza, y no se capturan teclas, hasta que pulses Start.',
      'track.cta': 'CORRER {name} ▶',
      'legacy.label': 'CIRCUITO CLÁSICO',
      'legacy.title': 'El circuito original',
      'legacy.desc': 'El trazado original con una pista más ancha y una clasificación nueva. Los récords anteriores se conservan por separado.',
      'legacy.cta': 'CORRER EL CIRCUITO CLÁSICO ▶',
      'ghost.label': 'FANTASMA PERSONAL',
      'ghost.title': 'Corre contra tu mejor vuelta',
      'ghost.body': 'Registra tu primera vuelta válida y se convierte en tu fantasma en este dispositivo. Solo una vuelta válida más rápida lo reemplaza. No se incluye ninguna vuelta de referencia de otra persona.',
      'ir.label': 'IDENTIDAD EN IRACING',
      'ir.cust': 'ID DE CLIENTE',
      'ir.note': 'Solo identidad estática. Valoraciones y resultados no disponibles: el acceso a la API de iRacing no está conectado, así que no se muestran estadísticas en vivo. La página del perfil puede pedirte iniciar sesión en iRacing.',
      'ir.link': 'ABRIR PERFIL DE IRACING ↗',
      'status.engine': 'El motor de carreras no se cargó. Recarga la página e inténtalo de nuevo.',
      'diff.Easy': 'Fácil',
      'diff.Medium': 'Media',
      'diff.Hard': 'Difícil',
      'desc.cadiz-city-v3': 'Costa de Cádiz: La Caleta, Genovés, Puerta de Tierra, Playa Victoria y Cortadura.',
      'desc.spa-francorchamps-v3': 'Trazado simplificado de Spa: La Source, Eau Rouge, Kemmel y Blanchimont.',
      'desc.noob-gp-v3': 'Gran premio de montaña largo: eses amplias, un doble vértice cuesta abajo y una curva final rápida.',
    },
  };

  let lang = 'en';
  let root = null;
  let timer = null;
  let observer = null;
  let statusKey = null;
  let destroyed = false, refreshing = false, lastRefresh = 0, generation = 0;
  let counts = null;
  const remoteBoards = new Map();
  const api = win.RacingLabCore && win.RacingLabCore.createApi(win.RACING_API_URL);
  const storage = () => { try { return win.localStorage; } catch { return null; } };
  const lapTime = ms => Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2,'0') + '.' + String(Math.floor(ms % 1000)).padStart(3,'0');
  function renderCards() {
    const c = core(); if (!root || !c) return;
    all('[data-lab-target]').forEach(el => {
      const id = el.getAttribute('data-lab-target');
      const local = c.loadScores(storage(), id, null)[0];
      const online = (remoteBoards.get(id) || [])[0];
      const useOnline = online && (!local || online.ms <= local.ms);
      const best = useOnline ? online : local;
      setText(el, tr('target') + ' · ' + (best ? lapTime(best.ms) + ' — ' + best.name + ' (' + tr(useOnline ? 'online' : 'local') + ')' : tr('empty')));
    });
    const local = win.RacingLive ? win.RacingLive.counts() : null;
    all('[data-lab-presence]').forEach(el => {
      const id=el.getAttribute('data-lab-presence');
      const useLocal = local && (!counts || local[id] > counts[id]);
      const value = useLocal ? local[id] : counts && counts[id];
      const known=Number.isInteger(value) && value>0;
      if(known)el.removeAttribute('hidden');else el.setAttribute('hidden','');
      setText(el, !known ? '' : (value + ' ' + tr('racing')) + (useLocal ? ' · '+tr('browser') : ''));
      el.setAttribute('data-active', value > 0 ? 'true' : 'false');
    });
    scheduleTimer();
  }
  async function refreshCards(force) {
    renderCards();
    if (!api || !root || doc.hidden || refreshing || (!force && Date.now() - lastRefresh < pollInterval())) return;
    refreshing = true; lastRefresh = Date.now(); const version = generation;
    try {
      const ids = core().tracks.map(t => t.id);
      const [presence, ...boards] = await Promise.all([api.presence(), ...ids.map(id => api.leaderboard(id, null))]);
      if (destroyed || version !== generation) return;
      counts = presence;
      ids.forEach((id,i) => { if (boards[i] !== null) remoteBoards.set(id, boards[i]); else remoteBoards.delete(id); });
      renderCards();
    } finally { refreshing = false; scheduleTimer(); }
  }

  const core = () => win.RacingLabCore || null;
  const trackOf = id => {
    const c = core();
    return (c && Array.isArray(c.tracks) && c.tracks.find(t => t.id === id)) || null;
  };
  const tr = (key, name) => {
    const s = I18N[lang][key] !== undefined ? I18N[lang][key] : I18N.en[key];
    return s === undefined ? '' : s.replace('{name}', name === undefined ? '' : name);
  };
  const trackName = id => { const t = trackOf(id); return t ? t.name : id || ''; };
  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
  const all = sel => (root ? root.querySelectorAll(sel) : []);
  const normLang = v => (v === 'es' || v === 'en' ? v : null);
  const readLang = () => {
    let stored = null;
    try { stored = win.localStorage.getItem('rah-lang'); } catch (e) { /* storage blocked */ }
    return normLang(doc.documentElement.getAttribute('data-language')) || normLang(stored) || 'en';
  };

  // ── previews ────────────────────────────────────────────────────────────
  const svgEl = (tag, attrs) => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  };
  const buildPreview = track => {
    const b = track.bounds || { x: 0, y: 0, w: 900, h: 560 };
    const p = track.points;
    const r = v => Math.round(v * 10) / 10;
    const svg = svgEl('svg', { viewBox: b.x + ' ' + b.y + ' ' + b.w + ' ' + b.h, 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid meet' });
    const d = p.map((q, i) => (i ? 'L' : 'M') + r(q[0]) + ' ' + r(q[1])).join('') + 'Z';
    svg.appendChild(svgEl('rect', {x:b.x,y:b.y,width:b.w,height:b.h,fill:track.geography?'#102b38':'#173e26','data-terrain':track.geography?'sea':'grass'}));
    if (!track.geography) {
      for(let y=b.y;y<b.y+b.h;y+=48)svg.appendChild(svgEl('rect',{x:b.x,y,width:b.w,height:20,fill:'#1d492d'}));
    }
    if (track.geography) {
      svg.appendChild(svgEl('path', {d,fill:'#21342f'}));
    }
    svg.appendChild(svgEl('path', { 'class': 'rl-road', d, 'stroke-width': track.width }));
    svg.appendChild(svgEl('path', { 'class': 'rl-line', d, 'vector-effect': 'non-scaling-stroke' }));
    const a = p[0], n = p[1 % p.length];
    const len = Math.hypot(n[0] - a[0], n[1] - a[1]) || 1;
    const nx = -(n[1] - a[1]) / len * track.width / 2, ny = (n[0] - a[0]) / len * track.width / 2;
    svg.appendChild(svgEl('path', { 'class': 'rl-start', d: 'M' + r(a[0] - nx) + ' ' + r(a[1] - ny) + 'L' + r(a[0] + nx) + ' ' + r(a[1] + ny), 'vector-effect': 'non-scaling-stroke' }));
    (track.sectors || []).forEach(i => {
      if (p[i]) svg.appendChild(svgEl('circle', { 'class': 'rl-sector', cx: r(p[i][0]), cy: r(p[i][1]), r: Math.max(4, track.width / 8) }));
    });
    return svg;
  };
  const renderPreviews = () => {
    all('[data-lab-preview]').forEach(box => {
      const key = box.getAttribute('data-lab-preview');
      const id = key;
      const track = trackOf(id);
      if (!track) return;
      if (box.getAttribute('data-lab-ready') === id && box.querySelector('svg')) return;
      box.textContent = '';
      box.appendChild(buildPreview(track));
      box.setAttribute('data-lab-ready', id);
    });
  };

  // Idle pages wake every15 seconds, not once per second for a removed countdown.
  function pollInterval() {
    const local=win.RacingLive ? win.RacingLive.counts() : null;
    return [local,counts].some(c=>c && Object.values(c).some(n=>Number.isInteger(n)&&n>0)) ? 5000 : 15000;
  }
  let timerDelay=null;
  function scheduleTimer() {
    if (destroyed || !root || doc.hidden) { stopTimer(); return; }
    const delay=pollInterval();
    if (timer!==null && timerDelay===delay) return;
    stopTimer();timerDelay=delay;
    timer=win.setInterval(()=>{if(!root || !root.isConnected)sync();else refreshCards(false);},delay);
  }

  // ── rendering ────────────────────────────────────────────────────────────
  const setStatus = key => {
    statusKey = key;
    all('[data-lab-status]').forEach(el => setText(el, key ? tr('status.' + key) : ''));
  };
  const render = () => {
    if (!root) return;
    root.setAttribute('lang', lang);
    all('[data-lab-i18n]').forEach(el => {
      const arg = el.getAttribute('data-lab-arg');
      if (arg && !trackOf(arg)) return;               // no core: keep the static fallback text
      setText(el, tr(el.getAttribute('data-lab-i18n'), arg ? trackName(arg).toUpperCase() : undefined));
    });
    all('[data-lab-name]').forEach(el => { const t = trackOf(el.getAttribute('data-lab-name')); if (t) setText(el, t.name); });
    all('[data-lab-diff]').forEach(el => { const t = trackOf(el.getAttribute('data-lab-diff')); if (t) setText(el, tr('diff.' + t.difficulty)); });
    all('[data-lab-desc]').forEach(el => { const id = el.getAttribute('data-lab-desc'); const s = tr('desc.' + id); if (s) setText(el, s); });
    setStatus(statusKey);
    renderPreviews();
    renderCards();
  };

  // ── lifecycle: the DC template mounts asynchronously and may re-render ──
  const stopTimer = () => { if (timer !== null) { win.clearInterval(timer); timer = null; timerDelay=null; } };
  function sync() {
    let el = doc.getElementById('racing-lab');
    if (!el) {
      const slot=doc.getElementById('racing-lab-slot'), template=doc.getElementById('racing-lab-template');
      // Do not mutate the source x-dc template before React adopts it. React owns only this empty slot.
      if (slot && !slot.closest('x-dc') && template && template.content) {
        slot.appendChild(template.content.cloneNode(true));
        el=doc.getElementById('racing-lab');
      }
    }
    if (el !== root) { generation++; root = el; if (!root) statusKey = null; }
    if (root) { lang = readLang(); render(); refreshCards(false); scheduleTimer(); } else stopTimer();
  }

  // ── events ───────────────────────────────────────────────────────────────
  const KNOWN = id => id === 'legacy' || !!trackOf(id);
  const onClick = e => {
    const t = e.target;
    const btn = t && typeof t.closest === 'function' ? t.closest('[data-race-track]') : null;
    if (!btn) return;
    try {
      if (typeof win.rahOpenRace !== 'function') throw new Error('rahOpenRace is not available');
      const id = btn.getAttribute('data-race-track');
      if (KNOWN(id) || !core()) win.rahOpenRace(id);
      if (statusKey === 'engine') setStatus(null);
    } catch (err) {
      win.console.error('[racing-lab] cannot open the race:', err);
      setStatus('engine');
    }
  };
  const onLang = e => {
    lang = normLang(e && e.detail && e.detail.lang) || readLang();
    render();
  };

  const onVisibility = () => { if(doc.hidden)stopTimer();else {refreshCards(true);scheduleTimer();} };
  doc.addEventListener('visibilitychange',onVisibility);
  const onScores = () => refreshCards(true);
  win.addEventListener('storage', onScores);
  doc.addEventListener('racing-lap', onScores);
  const stopLive = win.RacingLive ? win.RacingLive.subscribe(renderCards) : null;
  doc.addEventListener('click', onClick);
  doc.addEventListener('rah-lang', onLang);
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(records => {
      for (const rec of records) {
        const changed = [...(rec.addedNodes || []), ...(rec.removedNodes || [])];
        if (changed.some(node => node.nodeType === 1)) { sync(); return; }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  } else {
    doc.addEventListener('DOMContentLoaded', sync);
    win.addEventListener('load', sync);
  }
  sync();

  win.RacingLabPage = {
    sync, refreshCards, pollInterval,
    destroy() {
      destroyed = true; generation++;
      if(stopLive)stopLive();
      doc.removeEventListener('visibilitychange',onVisibility);
      win.removeEventListener('storage', onScores);
      doc.removeEventListener('racing-lap', onScores);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('rah-lang', onLang);
      doc.removeEventListener('DOMContentLoaded', sync);
      win.removeEventListener('load', sync);
      if (observer) observer.disconnect();
      stopTimer();
      root = null;
      if (win.RacingLabPage && win.RacingLabPage.destroy === this.destroy) delete win.RacingLabPage;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
