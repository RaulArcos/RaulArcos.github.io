'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../racing-core.js');
const peer = (sequence,x,angle=0,driving=true) => ({sequence,x,y:100,angle,driving});

test('buffered peer motion advances continuously between200ms snapshots',()=>{
  const view=Core.createPeerInterpolator();
  for(let t=0;t<=600;t+=200)view.push(peer(t/200+1,100+t/10),t);
  assert.equal(view.sample(600).x,125); //350ms playout delay: render the250ms point
  assert.equal(view.sample(650).x,130);
  assert.equal(view.sample(700).x,135);
  assert.equal(view.sample(750).x,140);
});

test('peer rendering is time-based, not dependent on frame rate',()=>{
  const make=()=>{const v=Core.createPeerInterpolator();for(let t=0;t<=1000;t+=200)v.push(peer(t/200+1,100+t/10),t);return v;};
  const slow=make(),fast=make();
  for(let t=0;t<800;t+=1000/30)slow.sample(t);
  for(let t=0;t<800;t+=1000/144)fast.sample(t);
  assert.deepEqual(slow.sample(800),fast.sample(800));
  assert.equal(slow.sample(800).x,145);
});

test('angles take the short arc and brief jitter uses bounded prediction, never indefinite coasting',()=>{
  const view=Core.createPeerInterpolator();
  view.push(peer(1,100,Math.PI-0.1),0);view.push(peer(2,120,-Math.PI+0.1),200);
  assert.ok(Math.abs(Math.abs(view.sample(450).angle)-Math.PI)<1e-8);
  assert.equal(view.sample(600).x,125); // render250ms,50ms beyond latest snapshot
  assert.equal(view.sample(1000).x,132); // at most120ms of prediction at100units/s
  assert.equal(view.sample(100000).x,132);
});

test('paused peers hold their final pose; duplicates, stale and invalid frames do not shift the timeline',()=>{
  const view=Core.createPeerInterpolator();
  view.push(peer(1,100),0);view.push(peer(2,120,0,false),200);
  view.push(peer(2,999),300);view.push(peer(1,700),400);view.push(peer(3,NaN),450);
  assert.equal(view.sample(1000).x,120);
  assert.equal(view.sample(2000).x,120);
});

test('long gaps and large teleports reset the visual buffer; predicting stays inside world bounds',()=>{
  const view=Core.createPeerInterpolator();
  assert.equal(view.sample(0),null);
  view.push(peer(1,100),0);view.push(peer(2,800),200);
  assert.equal(view.sample(250).x,800,'do not draw a fast sweep across the whole track');
  view.push(peer(3,810),2000);assert.equal(view.sample(2100).x,810);
  const edge=Core.createPeerInterpolator();edge.push(peer(1,880),0);edge.push(peer(2,900),200);
  assert.equal(edge.sample(1000).x,900);
});

test('visual sampling never publishes or changes the raw peer coordinates',()=>{
  const state=Object.freeze(peer(1,100));const view=Core.createPeerInterpolator();view.push(state,0);
  for(let frame=0;frame<10000;frame++)view.sample(frame*16);
  assert.deepEqual(state,peer(1,100));
  // A capped history still interpolates the most recent samples after a long race.
  for(let t=200,sequence=2;sequence<1000;t+=200,sequence++)view.push(peer(sequence,100+(sequence%2)*10),t);
  assert.ok(Number.isFinite(view.sample(199600).x));
});
