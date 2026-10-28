import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createEngineAPI} from '../engine/api.mjs';
import {createPreviewGate} from '../engine/preview-access.mjs';
import {passwordHash,hash} from '../engine/store.mjs';

test('whole-site password gate enforces real admin session, TLS, expiry and logout',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-preview-'));
 const engine=await createEngineAPI({folder,key:randomBytes(32).toString('base64'),allowPaid:false,origin:'https://preview.test',trustProxy:true,provider:{async call(){throw Error('NO_CLOUD_IN_TEST');},session(){throw Error('NO_GPU_IN_TEST');}}});
 engine.store.put('admin',{id:'administrator',username:'admin',password:passwordHash('fixture-password-only'),role:'admin'});
 const gate=createPreviewGate({enabled:true,isAuthenticated:engine.hasAdminSession});
 const server=http.createServer(async(req,res)=>{if(await gate(req,res))return;if(await engine.handler(req,res))return;res.end('fixture site');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const headers={Origin:'https://preview.test','X-Forwarded-Proto':'https','Content-Type':'application/json'};
 try{
  const guest=await fetch(base+'/director.html',{redirect:'manual',headers});assert.equal(guest.status,302);assert.equal(guest.headers.get('location'),'/login.html?next=%2Fdirector.html');
  assert.equal((await fetch(base+'/api/engine/state',{headers})).status,401);
  assert.equal((await fetch(base+'/login.html',{headers})).status,200);
  const wrong=await fetch(base+'/api/engine/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'wrong-fixture'})});assert.equal(wrong.status,401);
  const login=await fetch(base+'/api/engine/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'fixture-password-only'})});assert.equal(login.status,200);
  const cookies=login.headers.getSetCookie();assert.match(cookies[0],/Path=\/; /);assert.match(cookies[1],/Path=\/api\/engine; Max-Age=0/);
  const session=await login.json(),auth={...headers,Cookie:cookies[0].split(';')[0]};
  assert.equal((await fetch(base+'/director.html',{headers:auth,redirect:'manual'})).status,200);
  assert.equal((await fetch(base+'/director.html',{headers:{...auth,'X-Forwarded-Proto':'http'},redirect:'manual'})).status,302);
  const logout=await fetch(base+'/api/engine/logout',{method:'POST',headers:{...auth,'X-CSRF-Token':session.csrf}});assert.equal(logout.status,200);assert.match(logout.headers.getSetCookie()[0],/Path=\/; Max-Age=0/);
  assert.equal((await fetch(base+'/director.html',{headers:auth,redirect:'manual'})).status,302);
  const token=randomBytes(32).toString('hex');engine.store.sessionPut(hash(token),{role:'admin',expires:Date.now()-1});
  assert.equal((await fetch(base+'/',{headers:{...headers,Cookie:'iff_engine='+token},redirect:'manual'})).status,302);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await engine.close();await rm(folder,{recursive:true,force:true});}
});

test('login page has no embedded owner password or credential persistence',async()=>{
 const script=await readFile('site/login.js','utf8'),html=await readFile('site/login.html','utf8');
 assert.match(html,/type="password"/);assert.doesNotMatch(script,/localStorage|sessionStorage|console\.log/);
 assert.match(script,/location\.protocol!==.*https:/);assert.match(script,/permitted\.has\(next\)/);
});
