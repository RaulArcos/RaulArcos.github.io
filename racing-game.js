// racing-game.js — RAH Portfolio Racing Minigame
// Physics & drift marks from pakastin/car (MIT)
(() => {
  'use strict';

  // ── Physics (pakastin/car exact values) ──────────────────────────────────
  const MAX_POWER    = 0.075;
  const MAX_REVERSE  = 0.0375;
  const POWER_FACTOR = 0.001;
  const REV_FACTOR   = 0.0005;
  const DRAG         = 0.95;
  const ANG_DRAG     = 0.95;
  const TURN_SPEED   = 0.002;
  const PHYS_HZ      = 120;
  const STEP         = 1 / PHYS_HZ;

  const W = 900, H = 560;
  const TRACK_W = 80;
  const CAR_R   = 6;

  // ── Circuit — traced from reference image ────────────────────────────────
  // Clockwise: S/F bottom-right → diagonal main straight → bottom-left hairpin
  // → left-side climb → top sweep → right-side inner S → closes to S/F
  const CL = [
    [739, 471],  //  0  S/F — bottom-right
    [661, 491],  //  1  spawn
    [557, 497],  //  2  main straight
    [446, 491],  //  3  SECTOR 1
    [336, 475],  //  4
    [245, 449],  //  5
    [180, 415],  //  6  main straight end
    [134, 374],  //  7  bottom-left complex
    [112, 321],  //  8  SECTOR 2
    [115, 270],  //  9
    [143, 224],  // 10
    [186, 192],  // 11
    [238, 163],  // 12  SECTOR 3 — left side
    [299, 142],  // 13
    [362, 127],  // 14
    [446, 108],  // 15  top section
    [550,  98],  // 16
    [650,  94],  // 17
    [700,  98],  // 18
    [726, 103],  // 19
    [762, 127],  // 20  inner section entry
    [780, 159],  // 21
    [767, 192],  // 22
    [741, 220],  // 23
    [736, 251],  // 24  SECTOR 4 — inner S
    [745, 283],  // 25
    [767, 311],  // 26
    [784, 348],  // 27
    [788, 397],  // 28
    [775, 441],  // 29
    [739, 471],  // 30  closes to 0
  ];
  const N = CL.length; // 31

  const SECTOR_IDX = [3, 8, 12, 24];
  const MIN_LAP_MS = 5000;
  const LB_KEY = 'rah-racing-lb-v3';

  // ── Leaderboard — localStorage + leaderboard.json seed ───────────────────
  function loadLB()    { try { return JSON.parse(localStorage.getItem(LB_KEY)) || {}; } catch { return {}; } }
  function saveLB(lb)  { try { localStorage.setItem(LB_KEY, JSON.stringify(lb)); } catch {} }
  function updateBest(u, ms) {
    const lb = loadLB();
    if (lb[u] === undefined || ms < lb[u]) { lb[u] = ms; saveLB(lb); return true; }
    return false;
  }
  function getTop(n) { return Object.entries(loadLB()).sort((a,b) => a[1]-b[1]).slice(0,n); }
  function fmtT(ms) {
    const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000), c = Math.floor(ms%1000);
    return `${m}:${String(s).padStart(2,'0')}.${String(c).padStart(3,'0')}`;
  }

  // Fetch leaderboard.json on first load and merge (file wins only if it has
  // a better time — so manual edits to the file always take precedence)
  fetch('./leaderboard.json?_=' + Date.now())
    .then(r => r.ok ? r.json() : null)
    .then(fileData => {
      if (!fileData || typeof fileData !== 'object') return;
      const local  = loadLB();
      const merged = { ...local };
      for (const [name, ms] of Object.entries(fileData)) {
        if (typeof ms === 'number' && (merged[name] === undefined || ms < merged[name]))
          merged[name] = ms;
      }
      saveLB(merged);
    })
    .catch(() => {}); // silently ignore if file missing (local dev, etc.)

  function exportLB() {
    const data = JSON.stringify(loadLB(), null, 2);
    const blob = new Blob([data], {type:'application/json'});
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'leaderboard.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── Geometry ──────────────────────────────────────────────────────────────
  function nearestPtOnSeg(px, py, ax, ay, bx, by) {
    const dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy;
    if (!l2) return {x:ax, y:ay};
    const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/l2));
    return {x: ax+t*dx, y: ay+t*dy};
  }
  function nearestOnTrack(px, py) {
    let best = {dist:Infinity, nx:0, ny:0};
    for (let i=0; i<N-1; i++) {
      const [ax,ay]=CL[i], [bx,by]=CL[i+1];
      const pt = nearestPtOnSeg(px, py, ax, ay, bx, by);
      const d  = Math.hypot(px-pt.x, py-pt.y);
      if (d < best.dist) best = {dist:d, nx:pt.x, ny:pt.y};
    }
    return best;
  }
  function segsIntersect(ax,ay,bx,by,cx,cy,dx,dy) {
    const d1x=bx-ax, d1y=by-ay, d2x=dx-cx, d2y=dy-cy;
    const cross = d1x*d2y - d1y*d2x;
    if (Math.abs(cross)<1e-10) return false;
    const t = ((cx-ax)*d2y-(cy-ay)*d2x)/cross;
    const u = ((cx-ax)*d1y-(cy-ay)*d1x)/cross;
    return t>0 && t<1 && u>0 && u<1;
  }
  function makeGate(i) {
    const [ax,ay]=CL[i], [bx,by]=CL[(i+1)%(N-1)];
    const dx=bx-ax, dy=by-ay, len=Math.hypot(dx,dy);
    const ndx=dx/len, ndy=dy/len, px=-ndy, py=ndx, half=TRACK_W/2+10;
    return {x1:ax+px*half, y1:ay+py*half, x2:ax-px*half, y2:ay-py*half, dirX:ndx, dirY:ndy};
  }
  const FINISH_GATE  = makeGate(0);
  const SECTOR_GATES = SECTOR_IDX.map(makeGate);

  // ── Expand / backdrop ─────────────────────────────────────────────────────
  let backdrop  = null;
  let photoRect = null;

  function showBackdrop(ov) {
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.65);cursor:pointer;';
    backdrop.addEventListener('click', () => toggleExpand(ov));
    document.body.appendChild(backdrop);
  }
  function hideBackdrop() { if (backdrop) { backdrop.remove(); backdrop = null; } }

  function toggleExpand(ov) {
    if (!ov) return;
    if (ov.dataset.mode === 'photo') {
      ov.dataset.mode = 'expanded';
      Object.assign(ov.style, {left:'50%',top:'50%',width:'min(96vw,1100px)',height:'min(90vh,660px)',transform:'translate(-50%,-50%)'});
      showBackdrop(ov);
      document.querySelectorAll('.rr-expbtn').forEach(b => { b.textContent='⊡'; b.title='Contract'; });
    } else {
      ov.dataset.mode = 'photo';
      if (photoRect) Object.assign(ov.style, {left:photoRect.left+'px',top:photoRect.top+'px',width:photoRect.width+'px',height:photoRect.height+'px',transform:'none'});
      hideBackdrop();
      document.querySelectorAll('.rr-expbtn').forEach(b => { b.textContent='⛶'; b.title='Expand'; });
    }
    setTimeout(() => { if (window._rrResize) window._rrResize(); }, 380);
  }

  // ── Overlay ───────────────────────────────────────────────────────────────
  function buildOverlay(photoEl) {
    photoRect = photoEl.getBoundingClientRect();
    const ov = document.createElement('div');
    ov.id = 'rah-race-ov';
    ov.style.cssText = `position:fixed;z-index:9999;overflow:hidden;
      left:${photoRect.left}px;top:${photoRect.top}px;
      width:${photoRect.width}px;height:${photoRect.height}px;
      background:#0B0B0C;color:#EDEDEA;font-family:IBM Plex Mono,monospace;
      display:flex;align-items:center;justify-content:center;
      transition:left .36s cubic-bezier(.16,1,.3,1),top .36s cubic-bezier(.16,1,.3,1),
                 width .36s cubic-bezier(.16,1,.3,1),height .36s cubic-bezier(.16,1,.3,1),
                 transform .36s cubic-bezier(.16,1,.3,1);`;
    ov.dataset.mode = 'photo';
    ov.innerHTML = `
<div id="rr-name" style="text-align:center;position:relative;padding:18px 20px;width:100%;box-sizing:border-box;overflow-y:auto;max-height:100%;">
  <div style="font-size:9px;letter-spacing:.18em;color:#E2483D;margin-bottom:10px;">RAH // CIRCUIT</div>
  <div style="font-family:Antonio,sans-serif;font-size:clamp(22px,5vw,50px);font-weight:700;text-transform:uppercase;line-height:1;margin-bottom:4px;">Race</div>
  <div style="font-size:9px;color:#5B5B58;letter-spacing:.12em;margin-bottom:14px;">ARROWS OR WASD · COMPLETE LAPS</div>
  <input id="rr-input" placeholder="YOUR NAME" maxlength="20" autocomplete="off" style="display:block;margin:0 auto 10px;background:transparent;border:1px solid rgba(255,255,255,.22);color:#EDEDEA;font-family:IBM Plex Mono,monospace;font-size:12px;letter-spacing:.14em;padding:8px 14px;outline:none;width:min(200px,75%);box-sizing:border-box;text-transform:uppercase;text-align:center;">
  <button id="rr-go" style="background:#E2483D;border:none;color:#0B0B0C;font-family:IBM Plex Mono,monospace;font-size:10px;letter-spacing:.16em;padding:8px 22px;cursor:pointer;">START ▶</button>
  <div id="rr-lb0" style="margin-top:14px;font-size:9px;color:#5B5B58;letter-spacing:.09em;line-height:1.9;"></div>
  <button id="rr-x" style="position:absolute;top:8px;right:8px;background:none;border:1px solid rgba(255,255,255,.15);color:#5B5B58;font-family:IBM Plex Mono,monospace;font-size:9px;padding:3px 8px;cursor:pointer;">✕</button>
  <button class="rr-expbtn" style="position:absolute;top:8px;right:40px;background:none;border:1px solid rgba(255,255,255,.15);color:#5B5B58;font-family:IBM Plex Mono,monospace;font-size:9px;padding:3px 8px;cursor:pointer;" title="Expand">⛶</button>
</div>
<div id="rr-game" style="display:none;position:absolute;inset:0;">
  <canvas id="rr-canvas" style="position:absolute;inset:0;display:block;width:100%;height:100%;"></canvas>
  <div id="rr-hud" style="position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:flex-start;background:rgba(11,11,12,.82);border:1px solid rgba(255,255,255,.09);padding:6px 16px;pointer-events:none;white-space:nowrap;">
    <div><div style="font-size:7px;color:#5B5B58;letter-spacing:.16em;margin-bottom:2px;">LAP</div><div id="rr-hlap" style="font-family:Antonio,sans-serif;font-size:clamp(14px,2.5vw,24px);">—</div></div>
    <div><div style="font-size:7px;color:#5B5B58;letter-spacing:.16em;margin-bottom:2px;">CURRENT</div><div id="rr-hcur" style="font-family:Antonio,sans-serif;font-size:clamp(14px,2.5vw,24px);color:#E2483D;">—:——.———</div></div>
    <div><div style="font-size:7px;color:#5B5B58;letter-spacing:.16em;margin-bottom:2px;">BEST</div><div id="rr-hbest" style="font-family:Antonio,sans-serif;font-size:clamp(14px,2.5vw,24px);">—:——.———</div></div>
  </div>
  <div id="rr-msg" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:Antonio,sans-serif;font-size:clamp(16px,4vw,38px);letter-spacing:.06em;color:#E2483D;text-transform:uppercase;pointer-events:none;opacity:0;transition:opacity .2s;text-shadow:0 0 18px rgba(226,72,61,.55);"></div>
  <div id="rr-lb1" style="position:absolute;top:52px;right:6px;font-size:9px;letter-spacing:.09em;color:#5B5B58;line-height:1.9;background:rgba(11,11,12,.78);padding:6px 10px;border:1px solid rgba(255,255,255,.07);"></div>
  <button id="rr-quit" style="position:absolute;bottom:8px;right:8px;background:none;border:1px solid rgba(255,255,255,.15);color:#5B5B58;font-family:IBM Plex Mono,monospace;font-size:9px;padding:3px 8px;cursor:pointer;">✕ QUIT</button>
  <button class="rr-expbtn" style="position:absolute;bottom:8px;right:62px;background:none;border:1px solid rgba(255,255,255,.15);color:#5B5B58;font-family:IBM Plex Mono,monospace;font-size:9px;padding:3px 8px;cursor:pointer;" title="Expand">⛶</button>
  <button id="rr-export" style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:none;border:1px solid rgba(255,255,255,.10);color:#3a3a38;font-family:IBM Plex Mono,monospace;font-size:8px;letter-spacing:.12em;padding:3px 10px;cursor:pointer;" title="Download leaderboard.json">↓ LB</button>
  <div style="position:absolute;bottom:10px;left:10px;font-size:8px;letter-spacing:.12em;color:#252523;">CROSS S/F TO BEGIN TIMING</div>
</div>`;
    document.body.appendChild(ov);
    return ov;
  }

  // ── Static track ──────────────────────────────────────────────────────────
  function buildTrackCanvas() {
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const c = oc.getContext('2d');

    c.fillStyle = '#111a10';
    c.fillRect(0,0,W,H);

    function strokeCL(lw, style) {
      c.save(); c.strokeStyle=style; c.lineWidth=lw; c.lineCap='round'; c.lineJoin='round';
      c.beginPath(); c.moveTo(CL[0][0],CL[0][1]);
      for (let i=1;i<N;i++) c.lineTo(CL[i][0],CL[i][1]);
      c.closePath(); c.stroke(); c.restore();
    }
    strokeCL(TRACK_W+14, 'rgba(255,255,255,0.10)');
    strokeCL(TRACK_W,    '#2a2a2f');
    strokeCL(TRACK_W-8,  '#2e2e34');

    // Dashed centre line
    c.save(); c.strokeStyle='rgba(255,255,255,0.07)'; c.lineWidth=1.5; c.lineCap='round';
    c.setLineDash([12,20]);
    c.beginPath(); c.moveTo(CL[0][0],CL[0][1]);
    for (let i=1;i<N;i++) c.lineTo(CL[i][0],CL[i][1]);
    c.closePath(); c.stroke(); c.setLineDash([]); c.restore();

    // Finish line (checkered)
    const fl=FINISH_GATE, flen=Math.hypot(fl.x2-fl.x1,fl.y2-fl.y1);
    const fdx=(fl.x2-fl.x1)/flen, fdy=(fl.y2-fl.y1)/flen, SZ=8;
    for (let i=0,cnt=Math.ceil(flen/SZ); i<cnt; i++) {
      c.fillStyle = i%2===0?'#FFFFFF':'#111111';
      c.fillRect(fl.x1+fdx*(i*SZ)-3, fl.y1+fdy*(i*SZ)-3, Math.abs(fdx*SZ)+4, Math.abs(fdy*SZ)+4);
    }
    c.save(); c.font='bold 7px IBM Plex Mono,monospace'; c.fillStyle='rgba(226,72,61,0.6)';
    c.textAlign='center'; c.fillText('S/F', CL[0][0]-18, CL[0][1]+4); c.restore();

    return oc;
  }

  // ── Game ──────────────────────────────────────────────────────────────────
  function startGame(username, ov) {
    document.getElementById('rr-name').style.display = 'none';
    document.getElementById('rr-game').style.display = 'block';

    const canvas = document.getElementById('rr-canvas');
    const ctx    = canvas.getContext('2d');

    // Persistent drift canvas — accumulates marks every physics step (pakastin/car)
    const driftCanvas = document.createElement('canvas');
    driftCanvas.width = W; driftCanvas.height = H;
    const driftCtx = driftCanvas.getContext('2d');

    let sc=1, ox=0, oy=0;
    function resize() {
      // Use the overlay's known BoundingClientRect — reliable regardless of layout timing
      const ovEl = document.getElementById('rah-race-ov');
      let w=0, h=0;
      if (ovEl) { const r=ovEl.getBoundingClientRect(); w=r.width; h=r.height; }
      if (!w) w = canvas.parentElement ? canvas.parentElement.offsetWidth : 0;
      if (!h) h = canvas.parentElement ? canvas.parentElement.offsetHeight : 0;
      if (!w) w=400; if (!h) h=400;
      canvas.width  = Math.floor(w);
      canvas.height = Math.floor(h);
      sc = Math.min(canvas.width/W, canvas.height/H);
      ox = (canvas.width  - W*sc) / 2;
      oy = (canvas.height - H*sc) / 2;
    }
    window._rrResize = resize;
    resize();
    requestAnimationFrame(resize); // second pass after first paint
    window.addEventListener('resize', resize);

    // Car state
    const car = {x:CL[1][0], y:CL[1][1], vx:0, vy:0, angle:0, angVel:0, power:0, reverse:0, wallMult:1};
    { const dx=CL[2][0]-CL[1][0], dy=CL[2][1]-CL[1][1]; car.angle=Math.atan2(dx,-dy); }

    // Input
    const K = {};
    const kd = e => { K[e.code]=true;  e.stopPropagation(); };
    const ku = e => { K[e.code]=false; e.stopPropagation(); };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup',   ku, true);
    const inp = () => ({
      up:    !!(K['ArrowUp']   ||K['KeyW']),
      down:  !!(K['ArrowDown'] ||K['KeyS']),
      left:  !!(K['ArrowLeft'] ||K['KeyA']),
      right: !!(K['ArrowRight']||K['KeyD']),
    });

    // Timing
    let lapCount=0, curLapStart=null, sessionBest=null;
    let sectorsOk=new Set(), raceOn=false, flCooldown=200;
    let prevX=car.x, prevY=car.y;
    const lbNow=loadLB(); if (lbNow[username]!==undefined) sessionBest=lbNow[username];

    let msgFrames=0;
    function flash(txt, frames) {
      const el=document.getElementById('rr-msg'); if (!el) return;
      el.textContent=txt; el.style.opacity='1'; msgFrames=frames;
    }

    // Physics — exact pakastin/car mechanics
    function physStep() {
      const c=inp();
      const canTurn = car.power>0.0025 || car.reverse>0;
      const dir     = car.power>=car.reverse ? 1 : -1;

      car.power   = Math.max(0, Math.min(MAX_POWER,  car.power   +(c.up   ?POWER_FACTOR:-POWER_FACTOR)));
      car.reverse = Math.max(0, Math.min(MAX_REVERSE, car.reverse +(c.down ?REV_FACTOR  :-REV_FACTOR)));

      if (canTurn) {
        if (c.left)  car.angVel -= dir*TURN_SPEED;
        if (c.right) car.angVel += dir*TURN_SPEED;
      }

      const thrust = (car.power - car.reverse) * car.wallMult;
      car.vx += Math.sin(car.angle) * thrust;
      car.vy -= Math.cos(car.angle) * thrust;

      car.vx     *= DRAG;
      car.vy     *= DRAG;
      car.angVel *= ANG_DRAG;
      car.wallMult = Math.min(1, car.wallMult+0.003);

      prevX=car.x; prevY=car.y;
      car.x += car.vx; car.y += car.vy; car.angle += car.angVel;

      // Wall: slow down, never hard-stop
      const near=nearestOnTrack(car.x, car.y), limit=TRACK_W/2-CAR_R;
      if (near.dist > limit && near.dist > 0) {
        const nx=(car.x-near.nx)/near.dist, ny=(car.y-near.ny)/near.dist;
        const push=near.dist-limit;
        car.x -= nx*push*1.05; car.y -= ny*push*1.05;
        const dot=car.vx*nx+car.vy*ny;
        if (dot>0) { car.vx-=1.7*dot*nx; car.vy-=1.7*dot*ny; }
        const spd=Math.hypot(car.vx,car.vy);
        if (spd>0.15) { car.vx*=0.38; car.vy*=0.38; car.angVel*=0.55; car.wallMult=Math.max(0.12,car.wallMult-0.22); }
        else          { car.vx*=0.65; car.vy*=0.65; car.wallMult=Math.max(0.20,car.wallMult-0.06); }
      }

      // Sector gates
      SECTOR_GATES.forEach((g,i) => {
        if (sectorsOk.has(i)) return;
        if (segsIntersect(prevX,prevY,car.x,car.y,g.x1,g.y1,g.x2,g.y2))
          if ((car.x-prevX)*g.dirX+(car.y-prevY)*g.dirY>0) sectorsOk.add(i);
      });

      if (flCooldown>0) { flCooldown--; return; }
      const fg=FINISH_GATE;
      if (segsIntersect(prevX,prevY,car.x,car.y,fg.x1,fg.y1,fg.x2,fg.y2)) {
        if ((car.x-prevX)*fg.dirX+(car.y-prevY)*fg.dirY>0) {
          if (!raceOn) {
            raceOn=true; lapCount=0; curLapStart=performance.now(); sectorsOk.clear(); flash('GO!',80);
          } else {
            const allSectors=sectorsOk.size>=SECTOR_GATES.length, lapMs=performance.now()-curLapStart;
            if (allSectors && lapMs>=MIN_LAP_MS) {
              lapCount++; curLapStart=performance.now(); sectorsOk.clear();
              let msg=`LAP ${lapCount}  ${fmtT(lapMs)}`;
              if (sessionBest===null || lapMs<sessionBest) {
                sessionBest=lapMs;
                if (updateBest(username,lapMs)) msg+='  ★ BEST!'; else msg+='  ✓';
                updateLBPanel();
              }
              flash(msg,210);
            } else if (!allSectors) { curLapStart=performance.now(); sectorsOk.clear(); flash('INVALID — SHORTCUT',130); }
            else { curLapStart=performance.now(); sectorsOk.clear(); flash('INVALID LAP',110); }
          }
        }
      }
    }

    // Drift marks — pakastin/car rear-wheel positions, light warm colour on dark track
    function drawDriftMarks() {
      const {x,y,power,reverse,angVel,angle:a}=car;
      if (power>0.0025 || reverse>0) {
        if ((reverse>=MAX_REVERSE || power>=MAX_POWER) && Math.abs(angVel)<0.002) return;
        driftCtx.fillStyle='rgba(170,158,140,0.28)';
        // Left rear:  -cos(a+270°)=sin(a),  cos(a+180°)=-cos(a)
        driftCtx.fillRect(x-Math.sin(a)*3-Math.cos(a)*3, y+Math.cos(a)*3-Math.sin(a)*3, 1.5,1.5);
        // Right rear: -cos(a+270°)=sin(a),  cos(a+0°)=cos(a)
        driftCtx.fillRect(x-Math.sin(a)*3+Math.cos(a)*3, y+Math.cos(a)*3+Math.sin(a)*3, 1.5,1.5);
      }
    }

    function updateHUD() {
      const l=document.getElementById('rr-hlap'), c=document.getElementById('rr-hcur'), b=document.getElementById('rr-hbest');
      if (l) l.textContent=raceOn?String(lapCount):'—';
      if (c) c.textContent=curLapStart?fmtT(performance.now()-curLapStart):'—:——.———';
      if (b) b.textContent=sessionBest!==null?fmtT(sessionBest):'—:——.———';
    }
    function updateLBPanel() {
      const top=getTop(8), el=document.getElementById('rr-lb1'); if (!top.length||!el) return;
      el.innerHTML='<div style="color:#E2483D;margin-bottom:3px;font-size:8px;letter-spacing:.18em;">LEADERBOARD</div>'+
        top.map(([n,t],i)=>`<div style="${n===username?'color:#EDEDEA;':''}">`+
          `P${i+1} ${n.slice(0,10).padEnd(10,' ')} ${fmtT(t)}</div>`).join('');
    }
    updateLBPanel();

    const trackCanvas = buildTrackCanvas();

    function render() {
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.setTransform(sc,0,0,sc,ox,oy);

      ctx.drawImage(trackCanvas,0,0);   // static tarmac
      ctx.drawImage(driftCanvas,0,0);   // accumulated tyre marks

      // Sector gates
      SECTOR_GATES.forEach((g,i) => {
        ctx.save(); ctx.strokeStyle=sectorsOk.has(i)?'rgba(226,72,61,0.5)':'rgba(255,255,255,0.08)';
        ctx.lineWidth=1.5; ctx.setLineDash([5,5]);
        ctx.beginPath(); ctx.moveTo(g.x1,g.y1); ctx.lineTo(g.x2,g.y2); ctx.stroke();
        ctx.setLineDash([]); ctx.restore();
      });

      // Car — pakastin/car model: 8×16 body + windshield
      ctx.save();
      ctx.translate(car.x,car.y); ctx.rotate(car.angle);
      ctx.fillStyle='#808080';
      // Body with 2px rounded corners (roundRect has broad support; fallback to rect)
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(-4,-8,8,16,2); ctx.fill(); }
      else { ctx.fillRect(-4,-8,8,16); }
      ctx.fillStyle='hsla(0,0%,100%,0.375)'; // windshield
      ctx.fillRect(-4,-2,8,6);
      ctx.restore();

      // Name
      ctx.save(); ctx.font='9px IBM Plex Mono,monospace'; ctx.fillStyle='#E2483D'; ctx.textAlign='center';
      ctx.fillText(username.slice(0,14).toUpperCase(), car.x, car.y-14); ctx.restore();

      renderMinimap(ctx);
    }

    function renderMinimap(c) {
      const mx=10,my=10,mw=108,mh=70;
      c.save();
      c.fillStyle='rgba(11,11,12,0.82)'; c.fillRect(mx-3,my-3,mw+6,mh+6);
      c.strokeStyle='rgba(255,255,255,0.09)'; c.lineWidth=0.5; c.strokeRect(mx-3,my-3,mw+6,mh+6);
      const msc=Math.min(mw/W,mh/H)*0.9, mox=mx+(mw-W*msc)/2, moy=my+(mh-H*msc)/2;
      c.strokeStyle='#323234'; c.lineWidth=TRACK_W*msc; c.lineCap='round'; c.lineJoin='round';
      c.beginPath(); c.moveTo(mox+CL[0][0]*msc,moy+CL[0][1]*msc);
      for (let i=1;i<N;i++) c.lineTo(mox+CL[i][0]*msc,moy+CL[i][1]*msc);
      c.closePath(); c.stroke();
      c.fillStyle='#E2483D'; c.beginPath(); c.arc(mox+car.x*msc,moy+car.y*msc,2.5,0,Math.PI*2); c.fill();
      c.restore();
    }

    let acc=0, lastT=performance.now(), running=true, animId;
    function loop(now) {
      if (!running) return;
      animId=requestAnimationFrame(loop);
      acc += Math.min((now-lastT)/1000,0.1); lastT=now;
      while (acc>=STEP) { physStep(); drawDriftMarks(); acc-=STEP; }
      if (msgFrames>0 && --msgFrames===0) { const el=document.getElementById('rr-msg'); if (el) el.style.opacity='0'; }
      render(); updateHUD();
    }
    animId=requestAnimationFrame(ts=>{ lastT=ts; requestAnimationFrame(loop); });

    function quit() {
      running=false; cancelAnimationFrame(animId);
      window.removeEventListener('keydown',kd,true); window.removeEventListener('keyup',ku,true);
      window.removeEventListener('resize',resize); window._rrResize=null;
      hideBackdrop(); const ovEl=document.getElementById('rah-race-ov'); if (ovEl) ovEl.remove();
    }
    document.getElementById('rr-quit').addEventListener('click',quit);
    document.getElementById('rr-export').addEventListener('click', exportLB);
  }

  // ── Click delegation ──────────────────────────────────────────────────────
  document.addEventListener('click', e => {
    if (e.target.closest('#rah-photo') || e.target.closest('#rah-race-label')) window.rahOpenRace();
  });

  // ── Entry point ───────────────────────────────────────────────────────────
  window.rahOpenRace = function() {
    if (document.getElementById('rah-race-ov')) return;
    const photoEl = document.getElementById('rah-photo');
    const ov = buildOverlay(photoEl || document.body);

    const top=getTop(5);
    if (top.length) {
      const el=document.getElementById('rr-lb0');
      if (el) el.innerHTML='<div style="color:#E2483D;margin-bottom:4px;font-size:8px;letter-spacing:.18em;">LEADERBOARD</div>'+
        top.map(([n,t],i)=>`P${i+1} ${n.slice(0,12).padEnd(12,' ')} ${fmtT(t)}`).join('<br>');
    }

    document.getElementById('rr-x').addEventListener('click', ()=>{ hideBackdrop(); ov.remove(); });
    document.querySelectorAll('.rr-expbtn').forEach(b => b.addEventListener('click',()=>toggleExpand(ov)));

    const nameInput=document.getElementById('rr-input'), startBtn=document.getElementById('rr-go');
    const last=localStorage.getItem('rah-race-last'); if (last) nameInput.value=last;
    nameInput.focus();
    startBtn.addEventListener('click',()=>{
      const name=nameInput.value.trim().toUpperCase(); if (!name) { nameInput.focus(); return; }
      localStorage.setItem('rah-race-last',name); startGame(name,ov);
    });
    nameInput.addEventListener('keydown',e=>{ if (e.key==='Enter') startBtn.click(); });
  };
})();
