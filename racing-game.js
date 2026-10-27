// racing-game.js — RAH Portfolio Racing Minigame
// Physics & drift marks from pakastin/car (MIT)
// Needs racing-core.js (window.RacingLabCore); racing-config.js is optional (window.RACING_API_URL).
(() => {
  'use strict';

  const Core = window.RacingLabCore;

  const W = 900, H = 560;
  const TRACK_W = 80;

  // Spline-smoothed centerline traced from the reference PNG. 84 pts,
  // clockwise, index 0 = S/F on the right-hand sweep. This is the "Legacy Circuit".
  const CL = [
    [778, 336],  //  0  S/F
    [777, 362],  //  1  spawn (faces CL[2])
    [765, 384],  //  2
    [746, 401],  //  3
    [724, 413],  //  4
    [700, 423],  //  5
    [676, 430],  //  6
    [651, 437],  //  7
    [627, 444],  //  8
    [602, 450],  //  9
    [577, 457],  // 10
    [553, 463],  // 11
    [528, 470],  // 12  SECTOR 1
    [504, 477],  // 13
    [479, 483],  // 14
    [454, 487],  // 15
    [428, 488],  // 16
    [403, 483],  // 17
    [381, 471],  // 18
    [364, 453],  // 19
    [348, 433],  // 20
    [332, 413],  // 21
    [315, 394],  // 22
    [299, 375],  // 23
    [284, 354],  // 24
    [272, 331],  // 25
    [260, 309],  // 26
    [250, 285],  // 27
    [239, 262],  // 28
    [228, 239],  // 29
    [216, 217],  // 30
    [203, 195],  // 31
    [188, 174],  // 32
    [173, 154],  // 33
    [156, 135],  // 34  SECTOR 2
    [139, 116],  // 35
    [129,  93],  // 36
    [144,  74],  // 37
    [169,  68],  // 38
    [194,  68],  // 39
    [219,  70],  // 40
    [245,  73],  // 41
    [270,  78],  // 42
    [295,  82],  // 43
    [320,  87],  // 44
    [345,  90],  // 45
    [370,  94],  // 46
    [396,  97],  // 47
    [421,  99],  // 48  SECTOR 3
    [446, 102],  // 49
    [472, 105],  // 50
    [496, 111],  // 51
    [513, 128],  // 52
    [510, 153],  // 53
    [492, 172],  // 54
    [469, 181],  // 55
    [444, 185],  // 56
    [418, 186],  // 57
    [393, 184],  // 58
    [368, 183],  // 59
    [342, 186],  // 60
    [320, 198],  // 61
    [315, 222],  // 62
    [321, 247],  // 63
    [331, 270],  // 64
    [346, 290],  // 65
    [365, 307],  // 66
    [389, 309],  // 67
    [412, 298],  // 68  SECTOR 4
    [435, 287],  // 69
    [459, 278],  // 70
    [484, 271],  // 71
    [509, 266],  // 72
    [534, 263],  // 73
    [559, 261],  // 74
    [585, 261],  // 75
    [610, 261],  // 76
    [636, 262],  // 77
    [661, 264],  // 78
    [686, 266],  // 79
    [712, 269],  // 80
    [736, 276],  // 81
    [757, 290],  // 82
    [771, 311],  // 83
    [778, 336],  // closes to 0
  ];

  const SECTOR_IDX = [12, 34, 48, 68];

  const MIN_LAP_MS = 5000;
  const LB_KEY = 'rah-racing-lb-wide-v2';

  // The original circuit as a track descriptor for the shared race session (ring: no repeated end point).
  const LEGACY = {
    id: 'legacy', name: 'Legacy Circuit', difficulty: 'Classic', legacy: true,
    description: 'The original outline, wider road, fresh shared leaderboard.',
    points: CL.slice(0, -1), width: TRACK_W, sectors: SECTOR_IDX, startIndex: 0, minLapMs: MIN_LAP_MS,
    bounds: { x: 0, y: 0, w: W, h: H },
    spawn: { x: CL[1][0], y: CL[1][1], angle: Math.atan2(CL[2][0] - CL[1][0], -(CL[2][1] - CL[1][1])) },
  };

  // ── Shared leaderboard via Firebase Realtime Database (Legacy Circuit only) ─
  // 1. Go to console.firebase.google.com → create project → Realtime Database
  // 2. In Rules tab set: { "rules": { ".read": true, ".write": true } }
  // 3. Copy the database URL (e.g. https://xxx-rtdb.firebaseio.com) and paste below.
  // Leave empty → localStorage only (each visitor sees only their own scores).
  const FB_URL     = 'https://personalwebpage-c3328-default-rtdb.europe-west1.firebasedatabase.app';
  const FB_API_KEY = 'AIzaSyBUXNV1xlumxyeLHQduq6panTv6xwyPxW8';

  function loadLB()   { try { return JSON.parse(localStorage.getItem(LB_KEY)) || {}; } catch { return {}; } }
  function saveLB(lb) { try { localStorage.setItem(LB_KEY, JSON.stringify(lb)); } catch {} }
  function lbKey(name) { return name.replace(/[.#$[\]/]/g, '_').slice(0, 50); }
  function updateBest(u, ms) {
    const k = lbKey(u), lb = loadLB();
    if (lb[k] === undefined || ms < lb[k]) { lb[k] = ms; saveLB(lb); return true; }
    return false;
  }
  function getTop(n) { return Object.entries(loadLB()).sort((a,b) => a[1]-b[1]).slice(0,n); }
  function fmtT(ms) {
    const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000), c = Math.floor(ms%1000);
    return `${m}:${String(s).padStart(2,'0')}.${String(c).padStart(3,'0')}`;
  }

  function mergeLB(remote) {
    // Firebase is the single source of truth — overwrite local cache entirely.
    // null means the database path doesn't exist yet (no scores posted).
    saveLB((remote && typeof remote === 'object') ? remote : {});
  }

  // Anonymous auth token — cached for the browser session (tokens last 1 hour)
  async function getAuthToken() {
    const tok = sessionStorage.getItem('rah-fb-tok');
    const exp = sessionStorage.getItem('rah-fb-exp');
    if (tok && exp && Date.now() < parseInt(exp)) return tok;
    if (!FB_API_KEY) return null;
    try {
      const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({returnSecureToken:true}) }
      );
      const j = await r.json();
      if (j.idToken) {
        sessionStorage.setItem('rah-fb-tok', j.idToken);
        sessionStorage.setItem('rah-fb-exp', String(Date.now() + 3500_000)); // ~58 min
        return j.idToken;
      }
    } catch {}
    return null;
  }

  // Pull remote scores → merge with local → call onDone when finished (reads are public)
  async function syncLB(onDone) {
    if (FB_URL) {
      try {
        const r = await fetch(FB_URL + '/rah-lb-wide-v2.json');
        if (r.ok) mergeLB(await r.json());
      } catch {}
    }
    if (onDone) onDone();
  }

  // Push only this player's best — PATCH leaves every other entry untouched
  async function pushBest(name, ms) {
    if (!FB_URL) return;
    try {
      const tok = await getAuthToken();
      const url = FB_URL + '/rah-lb-wide-v2.json' + (tok ? `?auth=${tok}` : '');
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [lbKey(name)]: ms }),
      });
    } catch {}
  }

  function exportLB() {
    const data = JSON.stringify(loadLB(), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'leaderboard.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  syncLB(); // pull Firebase into localStorage cache on page load

  // ── Small DOM / storage helpers ───────────────────────────────────────────
  // Every string reaches the page through text nodes — leaderboard names are never parsed as HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in (props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const store = () => { try { return window.localStorage; } catch { return null; } };
  const nowMs = () => performance.now();

  const MONO = 'IBM Plex Mono,monospace';
  const BTN = `background:none;border:1px solid rgba(255,255,255,.15);color:#5B5B58;font-family:${MONO};font-size:9px;padding:3px 8px;cursor:pointer;`;

  function fmtCountdown(ms) {
    const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${hh}h` : `${hh}h ${m % 60}m`;
  }

  // ── Expand / backdrop ─────────────────────────────────────────────────────
  let backdrop  = null;
  let photoRect = null;
  let onBackdrop = null;

  function showBackdrop() {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.65);cursor:pointer;';
    backdrop.addEventListener('click', () => { if (onBackdrop) onBackdrop(); });
    document.body.appendChild(backdrop);
  }
  function hideBackdrop() { if (backdrop) { backdrop.remove(); backdrop = null; } }

  // ── Track drawing ─────────────────────────────────────────────────────────
  function tracePath(c, pts, ox, oy, s) {
    c.beginPath(); c.moveTo(ox + pts[0][0] * s, oy + pts[0][1] * s);
    for (let i = 1; i < pts.length; i++) c.lineTo(ox + pts[i][0] * s, oy + pts[i][1] * s);
    c.closePath();
  }

  // Small outline used by the menu preview.
  function drawPreview(canvas, track) {
    const c = canvas.getContext && canvas.getContext('2d'); if (!c) return;
    const w = canvas.width, hh = canvas.height, b = track.bounds;
    const s = Math.min((w - 10) / b.w, (hh - 10) / b.h), ox = (w - b.w * s) / 2 - b.x * s, oy = (hh - b.h * s) / 2 - b.y * s;
    c.clearRect(0, 0, w, hh);
    c.save(); c.strokeStyle = '#323234'; c.lineWidth = Math.max(2, track.width * s); c.lineCap = 'round'; c.lineJoin = 'round';
    tracePath(c, track.points, ox, oy, s); c.stroke();
    c.fillStyle = '#E2483D'; c.beginPath(); c.arc(ox + track.points[0][0] * s, oy + track.points[0][1] * s, 3, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function buildTrackCanvas(track, finishGate) {
    const b = track.bounds, pts = track.points;
    const oc = document.createElement('canvas');
    oc.width = b.w; oc.height = b.h;
    const c = oc.getContext('2d');
    c.translate(-b.x, -b.y);

    c.fillStyle = track.geography ? '#102b38' : '#173e26';
    c.fillRect(b.x, b.y, b.w, b.h);

    if (!track.geography) {
      c.fillStyle='#1d492d';
      for(let y=b.y;y<b.y+b.h;y+=48)c.fillRect(b.x,y,b.w,20);
    }
    if (track.geography) {
      c.fillStyle='#21342f';tracePath(c,pts,0,0,1);c.fill();
      c.save();c.fillStyle='rgba(204,224,214,.45)';c.font=`10px ${MONO}`;c.textAlign='center';
      c.fillText('CÁDIZ',290,195);c.fillText('LA CALETA',225,235);c.fillText('PUERTA DE TIERRA',390,260);
      c.fillText('PLAYA VICTORIA',560,390);c.fillText('CORTADURA',712,470);c.restore();
    }
    function strokeCL(lw, style) {
      c.save(); c.strokeStyle=style; c.lineWidth=lw; c.lineCap='round'; c.lineJoin='round';
      tracePath(c, pts, 0, 0, 1); c.stroke(); c.restore();
    }
    strokeCL(track.width+14, 'rgba(255,255,255,0.10)');
    strokeCL(track.width,    '#2a2a2f');
    strokeCL(track.width-8,  '#2e2e34');

    // Dashed centre line
    c.save(); c.strokeStyle='rgba(255,255,255,0.07)'; c.lineWidth=1.5; c.lineCap='round';
    c.setLineDash([12,20]); tracePath(c, pts, 0, 0, 1); c.stroke(); c.setLineDash([]); c.restore();

    // Finish line (checkered)
    const fl=finishGate, flen=Math.hypot(fl.x2-fl.x1,fl.y2-fl.y1);
    const fdx=(fl.x2-fl.x1)/flen, fdy=(fl.y2-fl.y1)/flen, SZ=8;
    for (let i=0,cnt=Math.ceil(flen/SZ); i<cnt; i++) {
      c.fillStyle = i%2===0?'#FFFFFF':'#111111';
      c.fillRect(fl.x1+fdx*(i*SZ)-3, fl.y1+fdy*(i*SZ)-3, Math.abs(fdx*SZ)+4, Math.abs(fdy*SZ)+4);
    }
    c.save(); c.font=`bold 7px ${MONO}`; c.fillStyle='rgba(226,72,61,0.6)';
    c.textAlign='center';
    if (track.legacy) c.fillText('S/F', pts[0][0]-18, pts[0][1]+4);
    else c.fillText('S/F', pts[0][0]-fl.dirX*18, pts[0][1]-fl.dirY*18+4);
    c.restore();

    return oc;
  }

  // ── Entry point ───────────────────────────────────────────────────────────
  // rahOpenRace()                      → original behaviour: opens from the photo, default track
  // rahOpenRace(trackId?) opens free play. The old challenge argument is ignored.
  let rahHasRaced = false;

  function openRace(trackId, wantChallenge, fromPhoto) {
    if (document.getElementById('rah-race-ov')) return;
    if (!Core) { if (window.console) console.error('racing-core.js must be loaded before racing-game.js'); return; }
    rahHasRaced = true;
    const frame = document.getElementById('rah-photo-frame');
    const tip   = document.getElementById('rah-clickme');
    if (frame) frame.classList.remove('rah-photo-glow');
    if (tip) tip.classList.remove('rah-clickme-show');

    // ── lifecycle bookkeeping: everything registered here is undone by close()
    const cleanups = [], timers = new Set();
    let closed = false, stopGame = null;
    const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); cleanups.push(() => target.removeEventListener(type, fn, opt)); };
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms); timers.add(id); return id; };
    const opener = document.activeElement;
    const touchDevice=('ontouchstart' in window) || !!(window.navigator && window.navigator.maxTouchPoints>0);
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';

    const api = Core.createApi(window.RACING_API_URL);
    const tracksById = { legacy: LEGACY };
    Core.tracks.forEach(t => { tracksById[t.id] = t; });
    const menuTracks = [LEGACY].concat(Core.tracks);
    const sel = { id: tracksById[trackId] ? trackId : 'cadiz-city-v3', challenge: false };
    // Archived weekly records remain untouched; the browser now opens only free play.
    const challengeOf = () => null;

    // ── boards: legacy = Firebase cache; new tracks = this device, or the optional API when it answers
    const remote = {};              // scope → [{name,ms}] from the API, or null if it failed
    const scopeKey = s => s.id + '@' + (challengeOf(s) || '');
    function board(s) {
      if (s.id === 'legacy') return { rows: getTop(999).map(([name, ms]) => ({ name, ms })), note: 'LEGACY BOARD · SHARED, UNVERIFIED' };
      const r = remote[scopeKey(s)];
      if (r) return { rows: r, note: 'ONLINE BOARD · COMMUNITY SCORES, UNVERIFIED' };
      const local = Core.loadScores(store(), s.id, challengeOf(s));
      if (!api) return { rows: local, note: 'SCORES: THIS DEVICE ONLY' };
      return { rows: local, note: r === null ? 'ONLINE BOARD UNAVAILABLE · SHOWING THIS DEVICE' : 'CONNECTING TO ONLINE BOARD…' };
    }
    const pendingBoards = new Map();
    let boardScope=null, refreshVisibleBoard=null, boardTimer=null, boardDelay=null, boardDriving=false;
    function fetchRemote(s, then) {
      if ((!api && s.id !== 'legacy') || document.hidden || closed) return;
      const key = scopeKey(s);
      if (pendingBoards.has(key)) { if(then)pendingBoards.get(key).add(then); return; }
      const callbacks=new Set(then?[then]:[]);pendingBoards.set(key,callbacks);
      const finish=rows=>{pendingBoards.delete(key);if(closed)return;if(s.id!=='legacy')remote[key]=rows;for(const fn of callbacks)fn();};
      if(s.id==='legacy')syncLB().then(()=>finish(null),()=>finish(null));
      else api.leaderboard(s.id, null).then(finish,()=>finish(null));
    }
    function scheduleBoardPoll() {
      const local=window.RacingLive && typeof window.RacingLive.counts==='function' ? window.RacingLive.counts() : null;
      const active=local && Object.values(local).some(n=>Number.isInteger(n)&&n>0);
      const fallbackActive=boardDriving && (!window.RacingLive || (boardScope && boardScope.id==='legacy'));
      const pageDelay=window.RacingLabPage && window.RacingLabPage.pollInterval ? window.RacingLabPage.pollInterval() : 15000;
      const delay=active || fallbackActive || pageDelay===5000 ? 5000 : 15000;
      if(boardTimer!==null && !document.hidden && boardDelay===delay)return;
      if(boardTimer!==null){clearTimeout(boardTimer);timers.delete(boardTimer);boardTimer=null;}
      if(closed || document.hidden)return;
      boardDelay=delay;
      boardTimer=later(()=>{
        boardTimer=null;const scope=boardScope || sel;
        fetchRemote(scope,refreshVisibleBoard);
        scheduleBoardPoll();
      },delay);
    }
    on(document,'visibilitychange',scheduleBoardPoll);
    if(window.RacingLive && typeof window.RacingLive.subscribe==='function')cleanups.push(window.RacingLive.subscribe(scheduleBoardPoll));

    // Writes rows as text-only nodes. opts: pad (name width), limit, expanded, onToggle, me
    function renderBoard(el, b, title, opts) {
      el.textContent = '';
      if (!b.rows.length) { el.appendChild(h('div', { text: b.note })); el.appendChild(h('div', { text: 'No times yet — be the first!' })); return; }
      const shown = opts.expanded ? b.rows : b.rows.slice(0, opts.limit);
      el.appendChild(h('div', { style: 'color:#E2483D;margin-bottom:4px;font-size:8px;letter-spacing:.18em;', text: title }));
      shown.forEach((r, i) => el.appendChild(h('div', { style: 'white-space:pre;' + (opts.me && r.name.toUpperCase() === opts.me ? 'color:#EDEDEA;' : ''),
        text: `P${i + 1} ${r.name.slice(0, opts.pad).padEnd(opts.pad, ' ')} ${fmtT(r.ms)}` })));
      if (b.rows.length > opts.limit) {
        el.appendChild(h('button', { type: 'button', style: 'cursor:pointer;color:#76766F;background:none;border:0;border-top:1px solid rgba(255,255,255,.08);font:inherit;letter-spacing:inherit;margin-top:4px;padding-top:4px;width:100%;text-align:center;',
          'aria-expanded': opts.expanded ? 'true' : 'false',
          title: opts.expanded ? `Show top ${opts.limit}` : 'Show full leaderboard',
          text: opts.expanded ? '▴ SHOW LESS' : `▾ SHOW ALL (${b.rows.length})`,
          onclick: e => { e.stopPropagation(); opts.onToggle(); } }));
      }
      el.appendChild(h('div', { style: 'margin-top:4px;color:#3e3e3c;', text: b.note }));
    }
    const boardTitle = () => 'LEADERBOARD';

    // ── overlay
    const ov = h('div', { id: 'rah-race-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Racing game', tabindex: '-1', style: '' });
    ov.dataset.mode = 'photo';
    const rect = fromPhoto ? document.getElementById('rah-photo').getBoundingClientRect() : null;
    photoRect = rect;
    const EXPANDED = 'left:50%;top:50%;width:min(96vw,1100px);height:min(90vh,660px);transform:translate(-50%,-50%);';
    ov.style.cssText = `position:fixed;z-index:9999;overflow:hidden;
      ${rect ? `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` : EXPANDED}
      background:#0B0B0C;color:#EDEDEA;font-family:${MONO};
      display:flex;align-items:center;justify-content:center;
      ${rect ? `transition:left .36s cubic-bezier(.16,1,.3,1),top .36s cubic-bezier(.16,1,.3,1),
                 width .36s cubic-bezier(.16,1,.3,1),height .36s cubic-bezier(.16,1,.3,1),
                 transform .36s cubic-bezier(.16,1,.3,1);` : ''}`;
    if (!rect) ov.dataset.mode = 'expanded';
    // Address-bar and software-keyboard changes do not always fire window.resize on phones.
    if(window.visualViewport){
      const viewport=window.visualViewport;let lastHeight=null,lastTop=null;
      const syncViewport=()=>{
        if(viewport.scale!==undefined && viewport.scale!==1)return; // keep native pinch zoom
        const height=viewport.height,top=viewport.offsetTop || 0;
        if(!Number.isFinite(height)||height<=0||(height===lastHeight&&top===lastTop))return;
        lastHeight=height;lastTop=top;
        if(typeof ov.style.setProperty==='function'){
          ov.style.setProperty('--rr-viewport-height',height+'px');ov.style.setProperty('--rr-viewport-top',top+'px');
        }
        if(typeof window._rrResize==='function')window._rrResize();
      };
      on(viewport,'resize',syncViewport);on(viewport,'scroll',syncViewport);syncViewport();
    }


    const expBtns = [];
    const mkExpBtn = style => {
      const b = h('button', { type: 'button', class: 'rr-expbtn', title: 'Expand', 'aria-label': 'Expand or contract the game window',
        style: style + 'background:rgba(226,72,61,.12);border:1px solid rgba(226,72,61,.6);color:#E2483D;font-family:' + MONO + ';font-size:14px;line-height:1;padding:4px 9px;cursor:pointer;', text: '⛶',
        onclick: () => toggleExpand() });
      if (!rect) b.style.display = 'none';
      expBtns.push(b); return b;
    };

    function toggleExpand() {
      if (!photoRect) return;
      if (ov.dataset.mode === 'photo') {
        ov.dataset.mode = 'expanded';
        Object.assign(ov.style, {left:'50%',top:'50%',width:'min(96vw,1100px)',height:'min(90vh,660px)',transform:'translate(-50%,-50%)'});
        showBackdrop();
        expBtns.forEach(b => { b.textContent='⊡'; b.title='Contract'; });
      } else {
        ov.dataset.mode = 'photo';
        Object.assign(ov.style, {left:photoRect.left+'px',top:photoRect.top+'px',width:photoRect.width+'px',height:photoRect.height+'px',transform:'none'});
        hideBackdrop();
        expBtns.forEach(b => { b.textContent='⛶'; b.title='Expand'; });
      }
      later(() => { if (window._rrResize) window._rrResize(); }, 380);
    }

    // Menu
    const nameInput = h('input', { id: 'rr-input', placeholder: 'YOUR NAME', maxlength: '20', autocomplete: 'off', 'aria-label': 'Your name',
      style: `display:block;margin:0 auto 10px;background:transparent;border:1px solid rgba(255,255,255,.22);color:#EDEDEA;font-family:${MONO};font-size:12px;letter-spacing:.14em;padding:8px 14px;outline:none;width:min(200px,75%);box-sizing:border-box;text-transform:uppercase;text-align:center;` });
    const startBtn = h('button', { id: 'rr-go', type: 'button', text: 'START ▶', style: `background:#E2483D;border:none;color:#0B0B0C;font-family:${MONO};font-size:10px;letter-spacing:.16em;padding:8px 22px;cursor:pointer;` });
    const trackBtns = menuTracks.map(t => h('button', { type: 'button', 'data-track': t.id, 'aria-pressed': 'false',
      style: `background:none;border:1px solid rgba(255,255,255,.22);color:#EDEDEA;font-family:${MONO};font-size:9px;letter-spacing:.1em;padding:5px 9px;margin:2px;cursor:pointer;`,
      text: t.name.toUpperCase(), onclick: () => { sel.id = t.id; sel.challenge = false; renderMenu(); } }));
    const descEl = h('div', { id: 'rr-desc', style: 'font-size:9px;color:#8a8a85;letter-spacing:.06em;line-height:1.6;margin:4px auto 6px;max-width:340px;' });
    const prev = h('canvas', { id: 'rr-prev', width: '160', height: '96', 'aria-hidden': 'true', style: 'display:block;margin:0 auto 6px;width:160px;max-width:60%;height:auto;' });
    const lb0 = h('div', { id: 'rr-lb0', style: 'margin-top:14px;font-size:9px;color:#5B5B58;letter-spacing:.09em;line-height:1.9;' });
    const closeBtn = h('button', { id: 'rr-x', type: 'button', 'aria-label': 'Close', text: '✕', style: 'position:absolute;top:8px;right:8px;' + BTN, onclick: () => close() });
    const menu = h('div', { id: 'rr-name', style: 'text-align:center;position:relative;padding:18px 20px;width:100%;box-sizing:border-box;overflow-y:auto;max-height:100%;' },
      h('div', { style: 'font-size:9px;letter-spacing:.18em;color:#E2483D;margin-bottom:10px;', text: 'RAH // CIRCUIT' }),
      h('div', { style: 'font-family:Antonio,sans-serif;font-size:clamp(22px,5vw,50px);font-weight:700;text-transform:uppercase;line-height:1;margin-bottom:4px;', text: 'Race' }),
      h('div', { style: 'font-size:9px;color:#5B5B58;letter-spacing:.12em;margin-bottom:10px;', text: 'ARROWS / WASD / TOUCH · COMPLETE LAPS' }),
      h('div', { role: 'group', 'aria-label': 'Track', style: 'margin-bottom:4px;' }, ...trackBtns),
      prev, descEl, nameInput, startBtn, lb0, closeBtn, mkExpBtn('position:absolute;top:8px;right:40px;'));

    let lb0Expanded = false;
    function refreshLB0() {
      const s = sel; renderBoard(lb0, board(s), boardTitle(s), { pad: 12, limit: 5, expanded: lb0Expanded, onToggle: () => { lb0Expanded = !lb0Expanded; refreshLB0(); } });
    }
    refreshVisibleBoard=refreshLB0;
    function renderMenu() {
      const t = tracksById[sel.id];
      trackBtns.forEach((b, i) => b.setAttribute('aria-pressed', menuTracks[i].id === sel.id && !sel.challenge ? 'true' : 'false'));
      descEl.textContent = `${t.name.toUpperCase()} · ${String(t.difficulty).toUpperCase()} — ${t.description}`;
      drawPreview(prev, t);
      lb0Expanded = false; refreshLB0();
      fetchRemote(sel, refreshLB0);scheduleBoardPoll();
    }
    ov.appendChild(menu);

    // Game container (filled by startGame)
    const game = h('div', { id: 'rr-game', tabindex: '-1', style: 'display:none;position:absolute;inset:0;outline:none;' });
    ov.appendChild(game);
    document.body.appendChild(ov);
    if (!rect) { showBackdrop(); }
    onBackdrop = () => { if (photoRect) toggleExpand(); else if (menu.style.display !== 'none') close(); };

    // ── focus trap + Escape (menu); the running game handles the same keys in its capture listener
    function focusables() {
      const out = [];
      (function walk(n) {
        for (const c of (n.children || [])) {
          if (c.style && c.style.display === 'none') continue;
          if (typeof window.getComputedStyle==='function' && window.getComputedStyle(c).display==='none') continue;
          const tag = String(c.tagName).toUpperCase();
          if ((tag === 'BUTTON' || tag === 'INPUT') && !c.disabled && c.getAttribute('tabindex') !== '-1') out.push(c);
          walk(c);
        }
      })(ov);
      return out;
    }
    function trapTab(e) {
      const list = focusables(); e.preventDefault();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement), last = list.length - 1;
      list[e.shiftKey ? (i <= 0 ? last : i - 1) : (i < 0 || i === last ? 0 : i + 1)].focus();
    }
    on(document, 'keydown', e => {      // only Escape/Tab: every other key stays with the page until Play
      if (e.key === 'Escape' || e.code === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab' || e.code === 'Tab') trapTab(e);
    });

    function close() {
      if (closed) return;
      if (stopGame) stopGame();
      closed = true;
      cleanups.forEach(f => f()); cleanups.length = 0;
      timers.forEach(clearTimeout); timers.clear();
      window._rrResize = null; onBackdrop = null; photoRect = null;
      hideBackdrop(); ov.remove();document.body.style.overflow=previousOverflow || '';
      if (opener && opener.isConnected !== false && typeof opener.focus === 'function') { try { opener.focus(); } catch {} }
    }

    // ── start
    const last = lsGet('rah-race-last'); if (last) nameInput.value = last;
    renderMenu();
    if (rect && touchDevice) later(() => toggleExpand(), 60);   // photo-sized window is too small to play on mobile
    if (!(touchDevice)) nameInput.focus();
    startBtn.addEventListener('click', () => {
      const track = tracksById[sel.id];
      const name = track.legacy ? nameInput.value.trim().toUpperCase() : Core.cleanName(Core.cleanName(nameInput.value).toUpperCase());
      if (!name) { nameInput.focus(); return; }
      lsSet('rah-race-last', name);
      startGame(name, track, challengeOf(sel));
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startBtn.click(); });

    // ── game ────────────────────────────────────────────────────────────────
    function startGame(username, track, challengeId) {
      menu.style.display = 'none';
      game.style.display = 'block';ov.dataset.playing='true';
      const legacy = !!track.legacy;
      let liveRoom = null;
      const peerVisuals = new Map();
      const b = track.bounds;
      let netNote = '';

      const canvas = h('canvas', { id: 'rr-canvas', style: 'position:absolute;inset:0;display:block;width:100%;height:100%;' });
      const hud = (label, id, extra) => h('div', null, h('div', { style: 'font-size:7px;color:#5B5B58;letter-spacing:.16em;margin-bottom:2px;', text: label }),
        h('div', { id, style: 'font-family:Antonio,sans-serif;font-size:clamp(14px,2.5vw,24px);' + (extra || ''), text: id === 'rr-hlap' ? '—' : '—:——.———' }));
      const infoEl = h('div', { id: 'rr-info', style: 'position:absolute;top:92px;left:10px;font-size:8px;letter-spacing:.1em;line-height:1.7;color:#76766F;max-width:230px;pointer-events:none;white-space:pre-wrap;' });
      const msgEl = h('div', { id: 'rr-msg', 'aria-live': 'polite', style: `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:Antonio,sans-serif;font-size:clamp(16px,4vw,38px);letter-spacing:.06em;color:#E2483D;text-transform:uppercase;pointer-events:none;opacity:0;transition:opacity .2s;text-shadow:0 0 18px rgba(226,72,61,.55);` });
      const lb1 = h('div', { id: 'rr-lb1', style: 'position:absolute;top:52px;right:6px;font-size:9px;letter-spacing:.09em;color:#5B5B58;line-height:1.9;background:rgba(11,11,12,.78);padding:6px 10px;border:1px solid rgba(255,255,255,.07);max-width:220px;box-sizing:border-box;' });
      const hudBox = h('div', { id: 'rr-hud', style: 'position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:flex-start;background:rgba(11,11,12,.82);border:1px solid rgba(255,255,255,.09);padding:6px 16px;pointer-events:none;white-space:nowrap;' },
        hud('LAP', 'rr-hlap'), hud('CURRENT', 'rr-hcur', 'color:#E2483D;'), hud('BEST', 'rr-hbest'));
      const quitBtn = h('button', { id: 'rr-quit', type: 'button', text: '✕ QUIT', 'aria-label': 'Quit the race', style: 'position:absolute;bottom:8px;right:8px;' + BTN, onclick: () => close() });
      const exportBtn = h('button', { id: 'rr-export', type: 'button', text: '↓ LB', title: 'Download leaderboard.json', 'aria-label': 'Download leaderboard',
        style: `position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:none;border:1px solid rgba(255,255,255,.10);color:#3a3a38;font-family:${MONO};font-size:8px;letter-spacing:.12em;padding:3px 10px;cursor:pointer;`, onclick: exportLB });
      if (!legacy) exportBtn.style.display = 'none';
      const tbtn = (id, css, txt, label, color) => h('button', { id, type: 'button', 'aria-label': label, text: txt,
        style: `position:absolute;${css}width:68px;height:68px;background:rgba(0,0,0,.55);border:1px solid ${color || 'rgba(255,255,255,.2)'};color:${color ? '#E2483D' : 'rgba(255,255,255,.75)'};font-size:26px;border-radius:12px;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;opacity:.5;` });
      const tchEl = h('div', { id: 'rr-tch', style: 'display:none;position:absolute;inset:0;pointer-events:none;' },
        tbtn('rr-tl', 'left:12px;bottom:70px;', '◄', 'Steer left'), tbtn('rr-tr', 'left:90px;bottom:70px;', '►', 'Steer right'),
        tbtn('rr-tg', 'right:12px;bottom:148px;', '▲', 'Accelerate', 'rgba(226,72,61,.4)'), tbtn('rr-tb2', 'right:12px;bottom:70px;', '▼', 'Brake or reverse'));
      const boardToggle=h('button',{id:'rr-board-toggle',type:'button',text:'LEADERBOARD','aria-controls':'rr-lb1','aria-expanded':'false',onclick:()=>{
        const open=ov.dataset.boardOpen!=='true';ov.dataset.boardOpen=String(open);boardToggle.setAttribute('aria-expanded',String(open));
      }});
      game.appendChild(boardToggle);
      game.appendChild(canvas); game.appendChild(hudBox); game.appendChild(msgEl); game.appendChild(infoEl); game.appendChild(lb1);
      game.appendChild(quitBtn); game.appendChild(mkExpBtn('position:absolute;bottom:8px;right:62px;')); game.appendChild(exportBtn);
      game.appendChild(h('div', { id:'rr-help',style: 'position:absolute;bottom:10px;left:10px;font-size:8px;letter-spacing:.12em;color:#4a4a47;', text: touchDevice ? 'Hold arrows to steer + accelerate. Rotate for a wider track.' : 'CROSS S/F TO BEGIN TIMING · ESC TO QUIT' }));
      game.appendChild(tchEl);
      game.focus();

      const ctx = canvas.getContext('2d');
      const session = Core.createSession({ track, wallNow: nowMs });
      const car = session.car;

      // Persistent drift canvas — accumulates marks every physics step (pakastin/car)
      const driftCanvas = document.createElement('canvas');
      driftCanvas.width = b.w; driftCanvas.height = b.h;
      const driftCtx = driftCanvas.getContext('2d');
      driftCtx.translate(-b.x, -b.y);

      let sc=1, ox=0, oy=0, pixelRatio=1;
      function resize() {
        // Use the overlay's known BoundingClientRect — reliable regardless of layout timing
        let w=0, hh=0;
        const r=canvas.getBoundingClientRect(); w=r.width; hh=r.height;
        if (!w) w = canvas.parentElement ? canvas.parentElement.offsetWidth : 0;
        if (!hh) hh = canvas.parentElement ? canvas.parentElement.offsetHeight : 0;
        if (!w) w=400; if (!hh) hh=400;
        pixelRatio=Math.min(window.devicePixelRatio || 1,2);
        canvas.width  = Math.round(w*pixelRatio);
        canvas.height = Math.round(hh*pixelRatio);
        sc = Math.min(canvas.width/b.w, canvas.height/b.h);
        ox = (canvas.width  - b.w*sc) / 2 - b.x*sc;
        oy = (canvas.height - b.h*sc) / 2 - b.y*sc;
      }
      window._rrResize = resize;
      resize();
      let resizeRaf = requestAnimationFrame(resize); // second pass after first paint
      on(window, 'resize', resize);

      // Input — keyboard + touch. Keys are only captured from here on (after Play).
      const K = {};
      const T = {up:false, down:false, left:false, right:false};
      const GAME_KEYS = new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','Space']);
      const kd = e => {
        e.stopPropagation();
        if (e.code === 'Escape' || e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.code === 'Tab' || e.key === 'Tab') { trapTab(e); return; }
        if (GAME_KEYS.has(e.code)) e.preventDefault();
        K[e.code]=true;
      };
      const ku = e => { K[e.code]=false; e.stopPropagation(); };
      on(window, 'keydown', kd, true);
      on(window, 'keyup',   ku, true);
      const touchPointers=new Map();
      const clearInput = () => { for (const k in K) K[k] = false; T.up = T.down = T.left = T.right = false;for(const ids of touchPointers.values())ids.clear();for(const el of tchEl.children)el.style.opacity='0.5'; };
      const inp = () => ({
        up:    !!(K['ArrowUp']   ||K['KeyW'] ||T.up),
        down:  !!(K['ArrowDown'] ||K['KeyS'] ||T.down),
        left:  !!(K['ArrowLeft'] ||K['KeyA'] ||T.left),
        right: !!(K['ArrowRight']||K['KeyD'] ||T.right),
      });

      // Touch controls
      if (touchDevice) {
        ov.dataset.touch='true';tchEl.style.display='block';
        const bindBtn=(id,key)=>{
          const el=Array.from(tchEl.children).find(x=>x.id===id);if(!el)return;
          const ids=new Set();touchPointers.set(key,ids);
          if(typeof window.PointerEvent==='function'){
            on(el,'pointerdown',e=>{
              if(e.button!==undefined && e.button!==0)return;
              e.preventDefault();ids.add(e.pointerId);T[key]=true;el.style.opacity='0.92';
              try{el.setPointerCapture(e.pointerId);}catch{}
            });
            const release=e=>{e.preventDefault();ids.delete(e.pointerId);T[key]=ids.size>0;el.style.opacity=T[key]?'0.92':'0.5';};
            for(const type of ['pointerup','pointercancel','lostpointercapture'])on(el,type,release);
          }else{
            on(el,'touchstart',e=>{e.preventDefault();T[key]=true;el.style.opacity='0.92';},{passive:false});
            const release=e=>{e.preventDefault();T[key]=!!(e.targetTouches&&e.targetTouches.length);el.style.opacity=T[key]?'0.92':'0.5';};
            on(el,'touchend',release,{passive:false});on(el,'touchcancel',release,{passive:false});
          }
        };
        bindBtn('rr-tl','left');bindBtn('rr-tr','right');bindBtn('rr-tg','up');bindBtn('rr-tb2','down');
        exportBtn.style.display='none';
      }

      // Scores / ghost for this run
      let sessionBest=null, ghost=null;
      if (legacy) { const lbNow=loadLB(); if (lbNow[username]!==undefined) sessionBest=lbNow[username]; }
      else {
        const mine = Core.loadScores(store(), track.id, challengeId).find(r => r.name.toUpperCase() === username);
        if (mine) sessionBest = mine.ms;
        ghost = Core.loadGhost(store(), track.id, challengeId, username);
      }

      let msgFrames=0, pausedMsg=false;
      function flash(txt, frames) {
        msgEl.textContent=txt; msgEl.style.opacity='1'; msgFrames=frames;
      }
      function updateInfo() {
        const lines = [track.name.toUpperCase() + (challengeId ? ` · WEEKLY ${challengeId}` : legacy ? '' : ' · FREE PLAY')];
        if (!legacy) {
          lines.push(ghost ? `GHOST: YOUR BEST (THIS DEVICE) ${fmtT(ghost.ms)}` : 'GHOST: NONE YET — SET A VALID LAP');
          lines.push(netNote || board({ id: track.id, challenge: !!challengeId }).note);
        }
        infoEl.textContent = lines.join('\n');
      }

      let lb1Expanded = false;
      function updateLBPanel() {
        const s = { id: track.id, challenge: !!challengeId }, bd = board(s);
        if (legacy && !bd.rows.length) return;
        lb1.style.maxHeight = lb1Expanded ? 'calc(100% - 60px)' : 'none';
        lb1.style.overflowY = lb1Expanded ? 'auto' : 'visible';
        renderBoard(lb1, bd, boardTitle(s), { pad: 10, limit: 8, expanded: lb1Expanded, me: username, onToggle: () => { lb1Expanded = !lb1Expanded; updateLBPanel(); } });
      }
      boardScope={id:track.id};refreshVisibleBoard=updateLBPanel;
      updateLBPanel(); updateInfo();scheduleBoardPoll();
      fetchRemote({ id: track.id, challenge: !!challengeId }, () => { updateLBPanel(); updateInfo(); });

      function onLap(ev) {
        const lapMs = ev.ms;
        let msg=`LAP ${ev.lap}  ${fmtT(lapMs)}`;
        if (legacy) {
          if (sessionBest===null || lapMs<sessionBest) {
            sessionBest=lapMs;
            if (updateBest(username,lapMs)) { pushBest(username,lapMs).then(()=>fetchRemote({id:'legacy'},updateLBPanel)); msg+='  ★ BEST!'; } else msg+='  ✓';
            updateLBPanel();
          }
          flash(msg,210); return;
        }
        const pb = sessionBest===null || lapMs<sessionBest;
        if (pb) sessionBest = lapMs;
        const res = Core.recordLap(store(), { trackId: track.id, challengeId, name: username, ms: lapMs, frames: ev.frames });
        if (res.ghost.improved) ghost = res.ghost.ghost;
        if (pb) {
          msg += res.score.persisted ? '  ★ BEST!' : '  ★ BEST (NOT SAVED)';
          if (res.score.improved && api) submitOnline(lapMs, ev.frames);
        } else msg += '  ✓';
        updateLBPanel(); updateInfo();
        if (typeof window.CustomEvent === 'function') document.dispatchEvent(new window.CustomEvent('racing-lap'));
        flash(msg,210);
      }
      function submitOnline(ms, frames) {
        netNote = 'ONLINE: SENDING…'; updateInfo();
        api.submit({ trackId: track.id, challengeId, name: username, ms, frames }).then(r => {
          if (closed) return;
          netNote = r === 'saved' ? 'ONLINE: SAVED (COMMUNITY, UNVERIFIED)' : r === 'skipped' ? 'ONLINE: NOT SENT · SAVED ON THIS DEVICE' :
                    r === 'not-saved' ? 'ONLINE: NOT ACCEPTED · SAVED ON THIS DEVICE' : 'ONLINE: UNAVAILABLE · SAVED ON THIS DEVICE';
          updateInfo();
          if (typeof window.CustomEvent === 'function') document.dispatchEvent(new window.CustomEvent('racing-lap'));
          if (r === 'saved') fetchRemote({ id: track.id, challenge: !!challengeId }, () => { updateLBPanel(); updateInfo(); });
        });
      }

      // Drift marks — pakastin/car rear-wheel positions, light warm colour on dark track
      function drawDriftMarks() {
        const {x,y,power,reverse,angVel,angle:a}=car;
        if (power>0.0025 || reverse>0) {
          if ((reverse>=Core.PHYS.MAX_REVERSE || power>=Core.PHYS.MAX_POWER) && Math.abs(angVel)<0.002) return;
          driftCtx.fillStyle='rgba(170,158,140,0.28)';
          // Left rear:  -cos(a+270°)=sin(a),  cos(a+180°)=-cos(a)
          driftCtx.fillRect(x-Math.sin(a)*3-Math.cos(a)*3, y+Math.cos(a)*3-Math.sin(a)*3, 1.5,1.5);
          // Right rear: -cos(a+270°)=sin(a),  cos(a+0°)=cos(a)
          driftCtx.fillRect(x-Math.sin(a)*3+Math.cos(a)*3, y+Math.cos(a)*3+Math.sin(a)*3, 1.5,1.5);
        }
      }

      const hLap = hudBox.children[0].children[1], hCur = hudBox.children[1].children[1], hBest = hudBox.children[2].children[1];
      function updateHUD() {
        const el = session.elapsed();
        hLap.textContent  = session.running ? String(session.lapCount) : '—';
        hCur.textContent  = el !== null ? fmtT(el) : '—:——.———';
        hBest.textContent = sessionBest!==null ? fmtT(sessionBest) : '—:——.———';
      }

      const trackCanvas = buildTrackCanvas(track, session.finishGate);

      function drawCar(c, x, y, angle, body, glass) {
        c.save();
        c.translate(x,y); c.rotate(angle);
        const size=Math.max(1,5*pixelRatio/(8*sc));c.scale(size,size);
        c.fillStyle=body;
        // Body with 2px rounded corners (roundRect has broad support; fallback to rect)
        if (c.roundRect) { c.beginPath(); c.roundRect(-4,-8,8,16,2); c.fill(); }
        else { c.fillRect(-4,-8,8,16); }
        c.fillStyle=glass; // windshield
        c.fillRect(-4,-2,8,6);
        c.restore();
      }

      function render() {
        ctx.setTransform(1,0,0,1,0,0);
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.setTransform(sc,0,0,sc,ox,oy);

        ctx.drawImage(trackCanvas,b.x,b.y);   // static tarmac
        ctx.drawImage(driftCanvas,b.x,b.y);   // accumulated tyre marks

        // Sector gates
        session.gates.forEach((g,i) => {
          const done = legacy ? session.sectorsOk.has(i) : i < session.nextSector;
          ctx.save(); ctx.strokeStyle=done?'rgba(226,72,61,0.5)':'rgba(255,255,255,0.08)';
          ctx.lineWidth=1.5; ctx.setLineDash([5,5]);
          ctx.beginPath(); ctx.moveTo(g.x1,g.y1); ctx.lineTo(g.x2,g.y2); ctx.stroke();
          ctx.setLineDash([]); ctx.restore();
        });

        // Personal-best ghost, replayed against the current lap clock
        if (ghost) {
          const el = session.elapsed(), gp = Core.ghostAt(ghost.frames, el === null ? 0 : el);
          if (gp) {
            ctx.save(); ctx.globalAlpha = 0.45; drawCar(ctx, gp.x, gp.y, gp.angle, '#7fc4ff', 'hsla(0,0%,100%,0.375)'); ctx.restore();
            ctx.save(); ctx.font=`${Math.max(8,10*pixelRatio/sc)}px ${MONO}`; ctx.fillStyle='rgba(127,196,255,0.7)'; ctx.textAlign='center'; ctx.fillText('GHOST', gp.x, gp.y-13); ctx.restore();
          }
        }

        // Live peers use a bounded time-based playout buffer, independent of display frame rate.
        if (liveRoom && window.RacingLive) {
          const peers=window.RacingLive.peers(track.id,liveRoom.id), present=new Set();
          for (const peer of peers) {
            present.add(peer.sessionId);
            const view=peerVisuals.get(peer.sessionId)||Core.createPeerInterpolator();
            const time=nowMs();view.push(peer,time);const shown=view.sample(time);
            peerVisuals.set(peer.sessionId,view);
            if (!shown) continue;
            drawCar(ctx,shown.x,shown.y,shown.angle,'#e8ba67','rgba(255,255,255,.6)');
            ctx.save();ctx.font=`${Math.max(9,10*pixelRatio/sc)}px ${MONO}`;ctx.fillStyle='#e8ba67';ctx.textAlign='center';
            ctx.strokeStyle='#e8ba67';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(shown.x,shown.y,12,0,Math.PI*2);ctx.stroke();
            ctx.fillText(peer.name+(peer.driving?'':' · PAUSED'),shown.x,shown.y+24);ctx.restore();
          }
          for(const id of peerVisuals.keys())if(!present.has(id))peerVisuals.delete(id);
        }

        // Car — pakastin/car model: 8×16 body + windshield
        drawCar(ctx, car.x, car.y, car.angle, '#808080', 'hsla(0,0%,100%,0.375)');

        // Name
        ctx.save(); ctx.font=`${Math.max(9,10*pixelRatio/sc)}px ${MONO}`; ctx.fillStyle='#E2483D'; ctx.textAlign='center';
        ctx.fillText(username.slice(0,14).toUpperCase(), car.x, car.y-14); ctx.restore();

        renderMinimap(ctx);
      }

      // The legacy minimap lives in track space (as originally); new tracks pin it to the screen corner.
      function renderMinimap(c) {
        const mx=10,my=10,mw=108,mh=70;
        c.save();
        if (!legacy) c.setTransform(pixelRatio,0,0,pixelRatio,0,0);
        c.fillStyle='rgba(11,11,12,0.82)'; c.fillRect(mx-3,my-3,mw+6,mh+6);
        c.strokeStyle='rgba(255,255,255,0.09)'; c.lineWidth=0.5; c.strokeRect(mx-3,my-3,mw+6,mh+6);
        const msc=Math.min(mw/b.w,mh/b.h)*0.9, mox=mx+(mw-b.w*msc)/2-b.x*msc, moy=my+(mh-b.h*msc)/2-b.y*msc;
        c.strokeStyle='#323234'; c.lineWidth=track.width*msc; c.lineCap='round'; c.lineJoin='round';
        tracePath(c, track.points, mox, moy, msc); c.stroke();
        c.fillStyle='#E2483D'; c.beginPath(); c.arc(mox+car.x*msc,moy+car.y*msc,2.5,0,Math.PI*2); c.fill();
        c.restore();
      }

      // Pause on blur / hidden tab: no stuck keys, no catch-up steps, wall-clock laps stay honest.
      const STEP = 1/Core.PHYS.HZ;
      let paused=false, pausedAt=0, acc=0, lastT=null, running=true, animId=0;
      let presenceId = null, presenceSequence = 0, spawnShifted = false;
      if (window.RacingLive) {
        liveRoom = window.RacingLive.join(track.id, username);
        // Other drivers can already be parked at the start; do not hide beneath their cars.
        if (liveRoom) {
          const peers=window.RacingLive.peers(track.id,liveRoom.id);
          const lanes=[0,-track.width*0.22,track.width*0.22,-track.width*0.35,track.width*0.35];
          const offset=lanes.find(d=>peers.every(p=>Math.hypot(car.x+Math.cos(car.angle)*d-p.x,car.y+Math.sin(car.angle)*d-p.y)>=14));
          if(offset!==undefined){car.x+=Math.cos(car.angle)*offset;car.y+=Math.sin(car.angle)*offset;spawnShifted=offset!==0;}
        }
      }
      if (liveRoom && typeof window.RacingLive.subscribe === 'function') {
        const stopSpawnCheck=window.RacingLive.subscribe(()=>{
          if (!liveRoom || spawnShifted || Math.hypot(car.x-track.spawn.x,car.y-track.spawn.y)>6) return;
          const peers=window.RacingLive.peers(track.id,liveRoom.id);
          // Remote discovery is asynchronous; one stable ID yields if both initially chose the center.
          if (!peers.some(p=>p.sessionId<liveRoom.id && Math.hypot(p.x-car.x,p.y-car.y)<14)) return;
          const offset=[-track.width*0.22,track.width*0.22,-track.width*0.35,track.width*0.35]
            .find(d=>peers.every(p=>Math.hypot(car.x+Math.cos(car.angle)*d-p.x,car.y+Math.sin(car.angle)*d-p.y)>=14));
          if (offset!==undefined) {
            spawnShifted=true;car.x+=Math.cos(car.angle)*offset;car.y+=Math.sin(car.angle)*offset;
            reportPresence(!paused);
          }
        });
        cleanups.push(stopSpawnCheck);
      }
      if (!liveRoom && api && !legacy && window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
        presenceId = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
      }
      function reportPresence(active) {
        boardDriving=!!active;scheduleBoardPoll();
        if (liveRoom) { liveRoom.update(car,active); liveRoom.sync(); }
        else if (presenceId) api.heartbeat(presenceId, track.id, active, ++presenceSequence);
      }
      function presenceTick() {
        if (!running) return;
        if (liveRoom) reportPresence(!paused);
        else if (!paused) reportPresence(true);
        later(presenceTick, liveRoom ? 200 : 15000);
      }
      function pause() {
        if (paused || !running) return;
        paused=true; pausedAt=nowMs(); clearInput(); reportPresence(false);
        msgEl.textContent='PAUSED'; msgEl.style.opacity='1'; pausedMsg=true;
      }
      function resume() {
        if (!paused || !running) return;
        if (document.hidden) return;
        paused=false; reportPresence(true); session.shiftClock(nowMs()-pausedAt); lastT=null; acc=0;
        if (pausedMsg) { pausedMsg=false; msgEl.style.opacity='0'; msgEl.textContent=''; }
      }
      on(window, 'pagehide', pause);
      on(window, 'blur', pause);
      on(window, 'focus', resume);
      on(document, 'visibilitychange', () => { if (document.hidden) pause(); else resume(); });

      function loop(now) {
        if (!running) return;
        animId=requestAnimationFrame(loop);
        if (lastT===null) lastT=now;
        if (paused) { lastT=now; render(); return; }
        acc += Math.min((now-lastT)/1000,0.1); lastT=now;
        while (acc>=STEP) {
          const ev = session.step(inp());
          if (ev) {
            if (ev.type==='start') flash('GO!',80);
            else if (ev.type==='lap') onLap(ev);
            else if (ev.reason==='shortcut') flash('INVALID — SHORTCUT',130);
            else flash('INVALID LAP',110);
          }
          drawDriftMarks(); acc-=STEP;
        }
        if (msgFrames>0 && --msgFrames===0) msgEl.style.opacity='0';
        render(); updateHUD();
      }
      if (document.hidden || (document.hasFocus && !document.hasFocus())) pause();
      else reportPresence(true);
      if (liveRoom || presenceId) later(presenceTick, liveRoom ? 200 : 15000);
      animId=requestAnimationFrame(loop);

      stopGame = () => {
        if (liveRoom) { liveRoom.close(); liveRoom=null; }
        else reportPresence(false);
        running=false; cancelAnimationFrame(animId); cancelAnimationFrame(resizeRaf); clearInput();
      };
    }
  }

  // ── Click delegation ──────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    if (e.target.closest('#rah-photo') || e.target.closest('#rah-race-label')) window.rahOpenRace();
  });

  // ── Attract glow — invite the click if the photo hasn't been played yet ────
  setTimeout(() => {
    if (rahHasRaced) return;
    const frame = document.getElementById('rah-photo-frame');
    const tip   = document.getElementById('rah-clickme');
    if (frame) frame.classList.add('rah-photo-glow');
    if (tip) tip.classList.add('rah-clickme-show');
  }, 5000);

  window.rahOpenRace = function(trackId, challengeMode) {
    // No arguments = the original photo click; anything else (parent buttons) opens the expanded menu.
    let fromPhoto = false;
    if (arguments.length === 0) {
      const photoEl = document.getElementById('rah-photo');
      if (photoEl) {
        const r = photoEl.getBoundingClientRect();
        fromPhoto = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      }
    }
    openRace(trackId, challengeMode, fromPhoto);
  };
})();
