import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {PostgresStore,databaseConfig} from '../engine/postgres.mjs';
import {createEngineAPI} from '../engine/api.mjs';
import {passwordHash} from '../engine/store.mjs';

test('real PostgreSQL persistence, permissions, atomicity, API auth and paid gate',{skip:process.env.IFF_POSTGRES_TEST!=='1'},async()=>{
 const config=databaseConfig();if(!/^iff_verify_[a-z0-9_]+$/.test(config.database))throw Error('REFUSE_TEST_ON_NONDISPOSABLE_DATABASE');
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-pg-')),key=randomBytes(32).toString('base64');
 const store=new PostgresStore(folder,key,config),other=new PostgresStore(folder,key,config);
 let api,server;
 try{
  await store.ready();await other.ready();
  for(const table of ['iff_records','iff_sessions','iff_intents','iff_audit'])await store.query('DELETE FROM '+table);
  const secret=store.seal({tokenSecret:'synthetic-local-test-only'},'one');await store.put('account',{id:'one',workspace:'fixture-workspace',credentials:secret});
  assert.equal((await other.get('account','one')).credentials.includes('synthetic-local-test-only'),false);
  assert.equal(other.open((await other.get('account','one')).credentials,'one').tokenSecret,'synthetic-local-test-only');
  assert.throws(()=>other.open(secret,'two'));
  await assert.rejects(store.query('CREATE TABLE must_be_denied (id int)'),/permission denied/);
  await assert.rejects(store.transaction(async()=>{await store.put('project',{id:'rolled-back'});throw Error('rollback-fixture');}),/rollback-fixture/);
  assert.equal(await other.get('project','rolled-back'),null);
  const commit=(s,id)=>s.transaction(async()=>{if(await s.intentGet('same-cost-approval'))return;await s.intentPut('same-cost-approval',id);await s.put('job',{id,action:'generate',status:'queued',cloudStopped:false});});
  await Promise.all([commit(store,'first'),commit(other,'second')]);assert.equal((await store.all('job')).length,1);
  await assert.rejects(other.put('job',{id:'unapproved-extra',action:'generate',status:'queued',cloudStopped:false}),/unique constraint/);
  await store.delete('job',(await store.all('job'))[0].id);
  await store.put('admin',{id:'administrator',username:'admin',password:passwordHash('synthetic-password-12345'),role:'admin'});
  let cloudCalls=0;
  process.env.ENGINE_ALLOWED_ORIGINS='https://studio.test';
  api=await createEngineAPI({store,key,folder,allowPaid:false,origin:'https://studio.test',trustProxy:true,provider:{async call(){cloudCalls++;throw Error('NO_NETWORK_IN_DB_TEST');},session(){throw Error('NO_GPU_IN_DB_TEST');}}});
  server=http.createServer(api.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port+'/api/engine/';
  const headers={Origin:'https://studio.test','X-Forwarded-Proto':'https','Content-Type':'application/json'};
  assert.equal((await fetch(base+'state')).status,401);
  const login=await fetch(base+'login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'synthetic-password-12345'})});assert.equal(login.status,200);
  headers.Cookie=login.headers.get('set-cookie').split(';')[0];headers['X-CSRF-Token']=(await login.json()).csrf;
  const snapshot={id:'persisted-story',name:'قصة اختبار فقط',messages:[{role:'user',content:'بداية'},{role:'assistant',content:'نهاية'}],assets:[],plan:null};
  assert.equal((await fetch(base+'projects/save',{method:'POST',headers,body:JSON.stringify({snapshot})})).status,200);
  assert.deepEqual((await other.get('project','persisted-story')).snapshot.messages,snapshot.messages);
  assert.equal((await fetch(base+'execute',{method:'POST',headers,body:'{}'})).status,423);
  assert.equal(cloudCalls,0);
  console.log('REAL_PG_VERIFIED: auth, encrypted records, persistent conversations, restricted DDL, rollback, two-client dedup, one GPU invariant, paid disabled; cloud calls=0');
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(api)await api.close();else await store.close();await other.close();await rm(folder,{recursive:true,force:true});}
});
