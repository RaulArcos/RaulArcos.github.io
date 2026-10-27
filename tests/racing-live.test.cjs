'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../racing-core.js');
const {createLiveClient} = require('../racing-live.js');
const {createServer} = require('../server/server.cjs');
const TRACK = Core.tracks[0].id;
function bus() {
  const channels = new Set();
  return () => { const c = {onmessage:null,postMessage(data){for(const peer of channels) if(peer!==c) peer.onmessage?.({data:structuredClone(data)});},close(){channels.delete(c);}};channels.add(c);return c; };
}
const tick = () => new Promise(setImmediate);

test('two tabs discover actual cars without a backend, park on blur, isolate tracks, leave and expire', async()=>{
  const channelFactory=bus(); let now=1000, n=0;
  const make=()=>createLiveClient({core:Core,channelFactory,now:()=>now,randomId:()=> (++n).toString(16).padStart(32,'0')});
  const a=make(), room=a.join(TRACK,'Alice'); room.update({x:200,y:100,angle:0},true);
  const b=make();await tick();
  assert.equal(b.peers(TRACK).length,1,'new tab discovers an existing driver');
  assert.equal(b.peers(TRACK)[0].name,'Alice');
  const other=b.join(TRACK,'Bob');other.update({x:250,y:110,angle:1},true);
  assert.equal(a.peers(TRACK,room.id)[0].x,250);
  other.update({x:265,y:115,angle:1.1},false);
  assert.equal(a.peers(TRACK,room.id)[0].driving,false,'a paused tab stays visible');
  assert.equal(a.counts()[TRACK],1,'only driving sessions count');
  assert.deepEqual(a.peers(Core.tracks[1].id),[]);
  room.close();assert.equal(b.peers(TRACK).length,1,'only Bob remains');
  other.close();assert.deepEqual(a.peers(TRACK),[]);
  const stale=b.join(TRACK,'Stale');stale.update({x:200,y:200,angle:0},true);
  now+=16000;assert.deepEqual(a.peers(TRACK),[]);
  a.destroy();b.destroy();
});

test('untrusted local position messages are rejected and late updates cannot undo a leave', ()=>{
  const channelFactory=bus();let now=1;
  const a=createLiveClient({core:Core,channelFactory,now:()=>now,randomId:()=> 'a'.repeat(32)});
  const hostile=channelFactory();const state={type:'state',sessionId:'b'.repeat(32),sequence:1,trackId:TRACK,name:'Bob',x:200,y:200,angle:0,driving:true};
  hostile.postMessage({...state,x:901});assert.equal(a.peers(TRACK).length,0);
  hostile.postMessage(state);assert.equal(a.peers(TRACK).length,1);
  hostile.postMessage({type:'leave',sessionId:state.sessionId,sequence:3});
  hostile.postMessage({...state,sequence:2});assert.equal(a.peers(TRACK).length,0);
  hostile.postMessage({...state,sessionId:'x',sequence:4});assert.equal(a.peers(TRACK).length,0);
  a.destroy();hostile.close();
});

test('two independent HTTP clients relay real positions, track isolation, paused cars and explicit leave',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-cars-'));let now=Date.UTC(2026,9,22);
  const origin='http://localhost:8000';const server=createServer({dataDir:dir,allowedOrigins:[origin],now:()=>now,logger:()=>{}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const fetchWithOrigin=(url,init)=>fetch(url,{...init,headers:{...init?.headers,Origin:origin}});
  const api=Core.createApi(base,{fetch:fetchWithOrigin});
  const a=createLiveClient({core:Core,api,now:()=>now,randomId:()=> 'c'.repeat(32)});
  const b=createLiveClient({core:Core,api,now:()=>now,randomId:()=> 'd'.repeat(32)});
  try {
    const ar=a.join(TRACK,'Alice');const br=b.join(TRACK,'Bob');
    ar.update({x:200,y:200,angle:0.1},true);br.update({x:250,y:210,angle:0.2},true);
    await ar.sync();await br.sync();await ar.sync();
    assert.equal(a.peers(TRACK,ar.id)[0].name,'Bob');assert.equal(a.peers(TRACK,ar.id)[0].x,250);
    br.update({x:280,y:220,angle:0.4},false);await br.sync();await ar.sync();
    assert.equal(a.peers(TRACK,ar.id)[0].x,280);assert.equal(a.peers(TRACK,ar.id)[0].driving,false);
    const counts=await api.presence();assert.equal(counts[TRACK],1);
    assert.deepEqual(await api.racers(Core.tracks[1].id),[]);
    const bad=await fetch(base+'/api/racers',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({sessionId:'e'.repeat(32),sequence:1,trackId:TRACK,name:'Bad',x:999,y:10,angle:0,driving:true})});
    assert.equal(bad.status,400);assert.equal((await api.racers(TRACK)).length,2);
    const denied=await fetch(base+'/api/racers',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    await br.close();await ar.sync();assert.equal(a.peers(TRACK,ar.id).length,0);
    now+=16000;assert.deepEqual(await api.racers(TRACK),[]);
    assert.deepEqual((await (await fetch(base+'/api/leaderboard?track='+TRACK)).json()).entries,[]);
  }finally{a.destroy();b.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
