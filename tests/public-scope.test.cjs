'use strict';
// Public checkout checks: no Git history or private local artifacts are required.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const publicDocs=['README.md','SECURITY.md','server/README.md','docs/racing-game.md','docs/mobile-readiness.md'];
const privatePaths=new Set(['docs/racing-security.md','server/deploy-vps.sh']);

test('repo ignore policy keeps private workflow/operations and credentials local',()=>{
  const lines=new Set(fs.readFileSync(path.join(root,'.gitignore'),'utf8').split(/\r?\n/).map(s=>s.trim()));
  for(const entry of ['/.atl/','/.claude/','/odd/','/docs/racing-security.md','/server/deploy-vps.sh','node_modules/','.env','.env.*'])assert.ok(lines.has(entry),entry);
});

test('public documentation links resolve without private operational documents',()=>{
  for(const file of publicDocs){
    const text=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)){
      const target=match[1].split('#')[0].split('?')[0];
      if(!target||/^[a-z]+:/i.test(target))continue;
      const resolved=path.resolve(root,path.dirname(file),decodeURIComponent(target));
      const relative=path.relative(root,resolved).replace(/\\/g,'/');
      assert.ok(!relative.startsWith('..')&&!privatePaths.has(relative),file+' -> '+target);
      assert.ok(fs.existsSync(resolved),file+' -> '+target);
    }
  }
});

test('public docs use generic operations guidance rather than private host topology',()=>{
  for(const file of publicDocs){
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert.doesNotMatch(text,/\/opt\/|Caddyfile\.[a-z-]+|## Current VPS deployment/i,file);
    for(const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g))assert.ok(['127.0.0.1','0.0.0.0'].includes(match[0]),file+' contains a non-generic host address');
  }
  assert.ok(fs.existsSync(path.join(root,'server/server.cjs')),'generic backend retained');
});
