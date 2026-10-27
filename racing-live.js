// Non-colliding live cars: same-origin tabs use BroadcastChannel; visitors use the optional API.
(function (root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root && root.RacingLabCore) {
    if (root.RacingLive) root.RacingLive.destroy();
    root.RacingLive = exports.createLiveClient({window:root,core:root.RacingLabCore,
      api:root.RacingLabCore.createApi(root.RACING_API_URL)});
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const TTL = 15000, LIMIT = 256;
  function createLiveClient(options) {
    const core = options.core, now = options.now || Date.now, win = options.window;
    const api = options.api || null, entries = new Map(), rooms = new Map(), listeners = new Set();
    let channel = null, destroyed = false;
    const randomId = options.randomId || (() => {
      const bytes = new Uint8Array(16);
      const crypto = win ? win.crypto : globalThis.crypto;
      if (crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else for (let i=0;i<16;i++) bytes[i]=Math.floor(Math.random()*256);
      return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    });
    const validTrack = id => id === 'legacy' || !!core.trackById(id);
    const emit = () => { if (!destroyed) for (const fn of listeners) { try { fn(); } catch {} } };
    const broadcast = data => { try { if (channel) channel.postMessage(data); } catch {} };
    function prune() {
      let changed = false;
      for (const [id,e] of entries) if (e.expires <= now()) {entries.delete(id);changed=true;}
      return changed;
    }
    function valid(data) {
      return data && /^[a-f0-9]{32}$/.test(data.sessionId) && validTrack(data.trackId) &&
        Number.isSafeInteger(data.sequence) && data.sequence > 0 && typeof data.driving === 'boolean' &&
        typeof data.name === 'string' && core.cleanName(data.name) === data.name && data.name.length > 0 &&
        [data.x,data.y,data.angle].every(v=>typeof v==='number'&&Number.isFinite(v)) &&
        data.x>=0 && data.x<=900 && data.y>=0 && data.y<=560 && Math.abs(data.angle)<=Math.PI+0.001;
    }
    function accept(data, source) {
      if (!valid(data)) return false;
      prune();
      const old = entries.get(data.sessionId);
      if (old && old.sequence >= data.sequence) return false;
      if (!old && entries.size >= LIMIT) return false;
      entries.set(data.sessionId,{sessionId:data.sessionId,sequence:data.sequence,trackId:data.trackId,
        name:data.name,x:data.x,y:data.y,angle:data.angle,driving:data.driving,source,expires:now()+TTL});
      return true;
    }
    function leave(id,sequence) {
      const old = entries.get(id);
      if (!old || !Number.isSafeInteger(sequence) || sequence <= old.sequence) return;
      entries.set(id,{...old,sequence,leaving:true,expires:now()+TTL});emit();
    }
    try {
      channel = options.channelFactory ? options.channelFactory() :
        win && typeof win.BroadcastChannel==='function' ? new win.BroadcastChannel('rah-live-cars-v1') : null;
      if (channel) channel.onmessage = event => {
        const d = event.data;
        if (!d || typeof d !== 'object') return;
        if (d.type==='hello') { for (const room of rooms.values()) if (room.state) broadcast({type:'state',...room.state}); }
        else if (d.type==='state') { if (accept(d,'channel')) emit(); }
        else if (d.type==='leave') leave(d.sessionId,d.sequence);
      };
    } catch { channel=null; }
    broadcast({type:'hello'});
    const timer = win && win.setInterval ? win.setInterval(()=>{if(prune())emit();},1000) : null;
    function join(trackId, rawName) {
      const name = core.cleanName(rawName);
      if (!validTrack(trackId) || !name || destroyed) return null;
      const id=randomId();let sequence=0,closed=false,busy=false;
      const room={id,state:null,
        update(car,driving) {
          if (closed || destroyed) return;
          const angle=car.angle-2*Math.PI*Math.round(car.angle/(2*Math.PI));
          const state={sessionId:id,sequence:++sequence,trackId,name,x:car.x,y:car.y,angle,driving:!!driving};
          if (!accept(state,'self')) return;
          room.state=state;broadcast({type:'state',...state});emit();
        },
        async sync() {
          if (!api || !room.state || closed || destroyed || busy) return;
          busy=true;
          try {
            await api.publishRacer(room.state);
            if (closed || destroyed) return;
            const list=await api.racers(trackId);
            if (!list || closed || destroyed) return;
            const ids=new Set(list.map(p=>p.sessionId));
            for(const [key,e] of entries) if(e.source==='remote' && e.trackId===trackId && !ids.has(key)) entries.delete(key);
            for(const state of list) if(state.sessionId!==id) accept(state,'remote');
            emit();
          } catch { /* The local tab channel keeps working during network failures. */ }
          finally {busy=false;}
        },
        close() {
          if(closed) return Promise.resolve();
          closed=true;rooms.delete(id);const last=room.state;
          leave(id,++sequence);broadcast({type:'leave',sessionId:id,sequence});
          return api && last ? api.publishRacer({...last,sequence,leaving:true}) : Promise.resolve();
        },
      };
      rooms.set(id,room);return room;
    }
    return {join,
      peers(trackId,excludeId) {
        prune();return [...entries.values()].filter(e=>!e.leaving&&e.trackId===trackId&&e.sessionId!==excludeId)
          .map(({source,expires,leaving,...state})=>state);
      },
      counts() {
        prune();const live=[...entries.values()].filter(e=>!e.leaving);
        if (!live.length) return null; // No observations is unknown, not a fabricated empty global server.
        const counts=Object.fromEntries(core.tracks.map(t=>[t.id,0]));
        for (const e of live) if(e.driving && e.trackId in counts) counts[e.trackId]++;
        return counts;
      },
      subscribe(fn) {listeners.add(fn);return ()=>listeners.delete(fn);},
      destroy() {
        if(destroyed)return;
        for(const room of [...rooms.values()])room.close();
        destroyed=true;if(timer!==null)win.clearInterval(timer);
        if(channel)channel.close();listeners.clear();entries.clear();
      },
    };
  }
  return {createLiveClient};
});
