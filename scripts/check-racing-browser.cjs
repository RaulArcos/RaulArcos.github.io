'use strict';
// Real Chrome/Edge checks over built-in CDP/WebSocket; no browser npm dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/check-racing-browser.cjs [--isolated] [--screenshot]\nRequires an isolated Chrome/Edge with remote debugging on127.0.0.1:9222.\nBROWSER_CDP_URL changes that address; RACING_PREVIEW_URL defaults to http://127.0.0.1:8000/.\n--isolated uses separate browser contexts to verify server relay without BroadcastChannel.\n--screenshot writes .atl/racing-browser.png. Creates/closes its own tabs and contexts only.');
  process.exit(0);
}
const endpoint = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
const site = process.env.RACING_PREVIEW_URL || 'http://127.0.0.1:8000/';
const sockets = [], targets = [], contexts = [], exceptions = [];
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(); let next = 0;
  sockets.push(ws);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage = e => {
    const m=JSON.parse(e.data);
    if(m.method==='Runtime.consoleAPICalled' && m.params.type==='error')exceptions.push(m.params.args.map(a=>a.value||a.description||'').join(' '));
    if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    const p=pending.get(m.id);
    if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
  };
  ws.onclose = ()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP disconnected'));}pending.clear();};
  return (method,params={})=>new Promise((resolve,reject)=>{
    const id=++next;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timed out: '+method));},12000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
}
async function main() {
  const version=await(await fetch(endpoint+'/json/version')).json();
  const browser=await connect(version.webSocketDebuggerUrl);
  async function page() {
    let browserContextId;
    if(process.argv.includes('--isolated')) {
      browserContextId=(await browser('Target.createBrowserContext')).browserContextId;contexts.push(browserContextId);
    }
    const {targetId}=await browser('Target.createTarget',{url:'about:blank',...(browserContextId?{browserContextId}:{})});targets.push(targetId);
    const send=await connect(endpoint.replace(/^http/,'ws')+'/devtools/page/'+targetId);
    const evaluate=async(expression,awaitPromise=false)=>{
      const out=await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});
      if(out.exceptionDetails)throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    };
    await send('Runtime.enable');await send('Page.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:site});
    await evaluate(`new Promise((resolve,reject)=>{
      const ready=()=>window.RacingLabPage&&document.querySelector('#dc-root #racing-lab');
      if(ready()){resolve(true);return;}
      const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve(true);}});
      observer.observe(document,{childList:true,subtree:true});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('DC page did not mount'));},8000);
    })`,true);
    return {targetId,send,evaluate};
  }
  try {
    const a=await page();
    await a.send('Page.bringToFront');
    assert.ok(await a.evaluate("!document.getElementById('rl-content').hidden && !document.querySelector('[data-lab-toggle]')"),'Lab permanently visible before interaction');
    assert.equal(await a.evaluate("document.querySelectorAll('[data-lab-preview] svg').length"),3,'previews before Play');
    assert.ok(await a.evaluate("window.RacingLabCore.tracks.every(t=>document.querySelector('[data-lab-preview=\"'+t.id+'\"] [data-terrain]').dataset.terrain===(t.geography?'sea':'grass'))"),'real preview terrain before Play');
    assert.equal(await a.evaluate(`new Promise(resolve=>{
      document.querySelectorAll('[data-lab-preview] svg').forEach(el=>el.remove());
      queueMicrotask(()=>resolve(document.querySelectorAll('[data-lab-preview] svg').length));
    })`,true),3,'removal-only preview repair before Play');
    assert.ok(await a.evaluate("!document.querySelector('[data-race-weekly],[data-lab-week]')"),'weekly UI removed');
    assert.deepEqual(await a.evaluate("Object.fromEntries([...document.querySelectorAll('[data-lab-diff]')].map(e=>[e.dataset.labDiff,e.textContent]))"),{'cadiz-city-v3':'Medium','spa-francorchamps-v3':'Hard','noob-gp-v3':'Easy'});
    const start=async(p,name)=>p.evaluate(`(()=>{
      window.__peerLabels=[];window.__smoothFrames=[];
      const original=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...rest){if(String(text).includes('CHECK '))window.__peerLabels.push(String(text));if(String(text).startsWith('SMOOTH PROBE'))window.__smoothFrames.push({at:performance.now(),x:rest[0]});return original.call(this,text,...rest);};
      document.querySelector('.rl-hero-cta').click();document.querySelector('[data-race-track]').click();
      document.getElementById('rr-input').value=${JSON.stringify(name)};document.getElementById('rr-go').click();
      return window.RacingLabCore.tracks[0].id;
    })()`);
    const track=await start(a,'CHECK A');
    const b=await page();await b.send('Page.bringToFront');await start(b,'CHECK B');
    const waiting=p=>p.evaluate(`new Promise((resolve,reject)=>{
      const state=()=>window.RacingLive.peers(${JSON.stringify(track)}).filter(p=>p.name==='CHECK A'||p.name==='CHECK B');
      const ready=()=>{const s=state();return s.length===2&&Math.hypot(s[0].x-s[1].x,s[0].y-s[1].y)>=10;};
      if(ready()){resolve(state());return;}
      const off=window.RacingLive.subscribe(()=>{if(ready()){off();clearTimeout(timer);resolve(state());}});
      const timer=setTimeout(()=>{off();reject(new Error('two actual peers not discovered'));},6000);
    })`,true);
    const states=await waiting(a);await waiting(b);
    assert.ok(Math.hypot(states[0].x-states[1].x,states[0].y-states[1].y)>=10,'separate occupied spawn lanes');
    const before=await b.evaluate(`window.RacingLive.peers(${JSON.stringify(track)}).find(p=>p.name==='CHECK B')`);
    await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
    await b.evaluate('new Promise(resolve=>{let frames=0;const step=()=>++frames>=45?resolve():requestAnimationFrame(step);requestAnimationFrame(step);})',true);
    await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
    await a.evaluate(`new Promise((resolve,reject)=>{
      const moved=()=>{const p=window.RacingLive.peers(${JSON.stringify(track)}).find(p=>p.name==='CHECK B');return p&&Math.hypot(p.x-${before.x},p.y-${before.y})>5;};
      if(moved()){resolve(true);return;}const off=window.RacingLive.subscribe(()=>{if(moved()){off();clearTimeout(timer);resolve(true);}});
      const timer=setTimeout(()=>{off();reject(new Error('peer movement not relayed'));},6000);
    })`,true);
    await a.send('Page.bringToFront');
    await a.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
    assert.ok(await a.evaluate("window.__peerLabels.some(s=>s.includes('CHECK B'))"),'peer name actually drawn on real canvas');
    if(process.argv.includes('--screenshot')) {
      const png=await a.send('Page.captureScreenshot',{format:'png'});
      fs.mkdirSync('.atl',{recursive:true});fs.writeFileSync('.atl/racing-browser.png',Buffer.from(png.data,'base64'));
    }
    await b.evaluate("document.getElementById('rr-quit').click()");
    await a.evaluate(`new Promise((resolve,reject)=>{
      const gone=()=>!window.RacingLive.peers(${JSON.stringify(track)}).some(p=>p.name==='CHECK B');
      if(gone()){resolve();return;}const off=window.RacingLive.subscribe(()=>{if(gone()){off();clearTimeout(timer);resolve();}});
      const timer=setTimeout(()=>{off();reject(new Error('quit peer did not disappear'));},6000);
    })`,true);
    await a.evaluate("document.getElementById('rr-quit').click();document.getElementById('rah-lang').click()");
    assert.equal(await a.evaluate("document.documentElement.lang"),'es','real language toggle survives DOM ownership boundary');
    await a.evaluate("document.getElementById('rah-lang').click();window.rahOpenRace(window.RacingLabCore.tracks[1].id);document.getElementById('rr-input').value='GRASS CHECK';document.getElementById('rr-go').click()");
    await a.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
    const grass=await a.evaluate(`(()=>{
      const c=document.getElementById('rr-canvas'),b=window.RacingLabCore.tracks[1].bounds;
      const sc=Math.min(c.width/b.w,c.height/b.h),ox=(c.width-b.w*sc)/2,oy=(c.height-b.h*sc)/2;
      return [...c.getContext('2d').getImageData(Math.round(ox+(b.w-12)*sc),Math.round(oy+12*sc),1,1).data];
    })()`);
    assert.ok(grass[1]>grass[0]+10&&grass[1]>grass[2]+10,'actual game terrain is green grass');
    if(process.argv.includes('--screenshot')) {
      const png=await a.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync('.atl/racing-grass.png',Buffer.from(png.data,'base64'));
    }
    const motion=await a.evaluate(`new Promise(resolve=>{
      const channel=new BroadcastChannel('rah-live-cars-v1'),started=performance.now();
      const trackId=window.RacingLabCore.tracks[1].id,sessionId='e'.repeat(32);let sequence=1;
      window.__smoothFrames=[];
      const post=()=>channel.postMessage({type:'state',sessionId,sequence,trackId,name:'SMOOTH PROBE',x:500+sequence*8,y:300,angle:0,driving:true});
      post();
      const timer=setInterval(()=>{sequence++;post();if(sequence>=12){clearInterval(timer);setTimeout(()=>{
        channel.postMessage({type:'leave',sessionId,sequence:99});channel.close();
        const frames=window.__smoothFrames.filter(f=>f.at>=started+750&&f.at<=started+2050);
        const steps=frames.slice(1).map((f,i)=>({dx:f.x-frames[i].x,dt:f.at-frames[i].at})).filter(s=>s.dt>2&&s.dt<100);
        resolve({samples:steps.length,moving:steps.filter(s=>s.dx>0.1).length,maxStep:Math.max(0,...steps.map(s=>s.dx))});
      },50);}},200);
    })`,true);
    assert.ok(motion.samples>=20,'enough actual animation frames for smoothness check');
    assert.ok(motion.moving/motion.samples>0.85,'sparse200ms snapshots still move continuously on actual frames');
    assert.ok(motion.maxStep<3,'no snapshot-sized jumps between normal animation frames');
    console.log('Browser smoothness at unchanged200ms inputs: '+JSON.stringify(motion));
    await a.evaluate("document.getElementById('rr-quit').click()");
    assert.ok(await a.evaluate("!!document.querySelector('#dc-root #hero') && !document.body.innerText.includes('Root: Failed')"),'React root remains healthy');
    const c=await page();await c.send('Page.bringToFront');
    const liveBoard=await c.evaluate(`new Promise((resolve,reject)=>{
      const originalCounts=window.RacingLive.counts;window.RacingLive.counts=()=>({'cadiz-city-v3':1});
      window.__boardReads=0;window.RacingLabCore.createApi=()=>({leaderboard:async()=>{window.__boardReads++;return [{name:'BOARD PROBE',ms:window.__boardReads===1?30000:20000}];},presence:async()=>({'cadiz-city-v3':0,'spa-francorchamps-v3':0,'noob-gp-v3':0})});
      window.rahOpenRace('cadiz-city-v3');
      const observer=new MutationObserver(()=>{const el=document.getElementById('rr-lb0');if(window.__boardReads>=2&&el.textContent.includes('0:20.000')){observer.disconnect();clearTimeout(timer);document.getElementById('rr-x').click();window.RacingLive.counts=originalCounts;resolve({reads:window.__boardReads,updated:true});}});
      observer.observe(document.getElementById('rr-lb0'),{childList:true,subtree:true});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('5-second leaderboard did not render the new time'));},7000);
    })`,true);
    console.log('Actual browser live-board refresh: '+JSON.stringify(liveBoard));
    await c.evaluate(`new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='./racing-lab.js?v=zero-probe';s.onload=()=>resolve();s.onerror=reject;document.body.appendChild(s);})`,true);
    assert.ok(await c.evaluate("[...document.querySelectorAll('[data-lab-presence]')].every(e=>e.hidden&&!e.textContent)"),'known zero badges empty and hidden');
    assert.deepEqual(exceptions,[],'no real browser runtime or caught render errors');
    console.log('PASS: real Chrome previews before Play, removal repair, two tabs, separated cars, relayed movement, canvas names, Quit, language, grass and continuous buffered motion ('+(contexts.length?'isolated server relay':'same-origin tabs')+').');
  } finally {
    for(const targetId of targets)await browser('Target.closeTarget',{targetId}).catch(()=>{});
    for(const browserContextId of contexts)await browser('Target.disposeBrowserContext',{browserContextId}).catch(()=>{});
    for(const socket of sockets)socket.close();
  }
}
main().catch(e=>{console.error(e.stack||e);for(const socket of sockets)socket.close();process.exitCode=1;});
