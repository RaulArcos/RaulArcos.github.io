'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../server/server.cjs');
const Core = require('../racing-core.js');
const ORIGIN = 'http://localhost:8000';

test('live presence counts sessions, refreshes idempotently, expires and validates without changing scores', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'presence-'));
  let now = Date.UTC(2026,9,22);
  const server = createServer({dataDir:dir, allowedOrigins:[ORIGIN], now:()=>now, logger:()=>{},writeRateLimit:1});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const req = async (body, origin=ORIGIN) => {
    const r = await fetch(base+'/api/presence',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return [r.status,await r.json()];
  };
  const counts = async()=> (await (await fetch(base+'/api/presence')).json()).counts;
  const post = (id,trackId='cadiz-city-v3',active=true,sequence=1)=>req({sessionId:id.repeat(32),trackId,active,sequence});
  try {
    assert.equal((await counts())['cadiz-city-v3'],0);
    assert.equal((await post('a'))[0],200);
    assert.equal((await post('b'))[0],200);
    assert.equal((await counts())['cadiz-city-v3'],2);
    now+=15000; assert.equal((await post('a','cadiz-city-v3',true,2))[0],200);
    assert.equal((await counts())['cadiz-city-v3'],2);
    assert.equal((await post('a','cadiz-city-v3',false,3))[0],200);
    assert.equal((await post('a','cadiz-city-v3',true,2))[0],200); // stale in-flight heartbeat cannot resurrect a leave
    assert.equal((await counts())['cadiz-city-v3'],1);
    assert.equal((await post('c','noob-gp-v3'))[0],200);
    assert.equal((await counts())['noob-gp-v3'],1);
    const before = await counts();
    assert.equal((await post('d','invalid'))[0],400);
    assert.equal((await req({sessionId:'bad',trackId:'noob-gp-v3',active:true,sequence:1}))[0],400);
    assert.equal((await req({sessionId:'e'.repeat(32),trackId:'noob-gp-v3',active:true,sequence:1},'https://other.test'))[0],403);
    assert.deepEqual(await counts(),before);
    const board = await (await fetch(base+'/api/leaderboard?track=cadiz-city-v3')).json();
    assert.deepEqual(board.entries,[]);
    now+=45001; assert.equal((await counts())['cadiz-city-v3'],0); assert.equal((await counts())['noob-gp-v3'],0);
    // Existing old-layout scores remain accepted in their own namespaces.
    const r = await fetch(base+'/api/leaderboard?track=cadiz-sprint');assert.equal(r.status,200);
    for (const date of ['2026-01-05','2026-01-12','2026-10-19','2026-12-28','2027-01-04']) {
      const serverWeek = require('../server/server.cjs').weeklyChallenge(date);
      assert.equal(Core.weeklyChallenge(date).trackId,serverWeek.trackId);
    }
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('presence client returns unknown on unavailable or malformed counts, and encodes heartbeat lifecycle', async()=>{
  const calls=[]; let response={counts:{'cadiz-city-v3':2,'spa-francorchamps-v3':0,'noob-gp-v3':1}};
  const api=Core.createApi('https://api.test',{fetch:async(url,init)=>{calls.push([url,init]);return {ok:true,text:async()=>JSON.stringify(response)};}});
  assert.deepEqual(await api.presence(),response.counts);
  response={ok:true};
  assert.equal(await api.heartbeat('a'.repeat(32),'cadiz-city-v3',true,1),true);
  assert.deepEqual(JSON.parse(calls[1][1].body),{sessionId:'a'.repeat(32),trackId:'cadiz-city-v3',active:true,sequence:1});
  assert.equal(calls[1][1].keepalive,true);
  response={counts:{'cadiz-city-v3':-1}};assert.equal(await api.presence(),null);
});
