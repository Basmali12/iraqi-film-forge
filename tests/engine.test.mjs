import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createEngineAPI} from '../engine/api.mjs';
import {Store,passwordHash,hash} from '../engine/store.mjs';
import {settings,quality,GPUS,manifest} from '../engine/config.mjs';

// Deliberately isolated fixture, never imported by the production backend.
class TestProvider {
 constructor(){this.calls=[];this.waiting=null;}
 async call(action,input,onEvent=()=>{}){
  this.calls.push({action,input});
  if(action==='verify')return {workspace:input.credentials.mode==='local_profile'?'basm1998ali':'backup-workspace'};
  if(action==='discover')return {ready:input.volume==='modal-ltx25-test-models',files:input.volume==='modal-ltx25-test-models'?Object.entries(manifest.files).map(([name,f])=>({name,size:f.size,manifestMatch:true})):[],capacity:'unknown'};
  if(['stop','inspect'].includes(action))return {cloud_stopped:true,running_containers:0,tasks:0};
  if(action==='generate'){onEvent({kind:'app_created',app_id:'ap-fixture'});return new Promise(resolve=>{this.waiting=()=>resolve({videoVerified:true,cloud_stopped:true,sha256:'fixture',recordedCost:null});});}
  if(action==='transfer')return {ready:true,cloud_stopped:true};
  if(action==='official_plan')return {files:Object.entries(manifest.files).map(([name,f])=>({name,size:f.size})),modelDownloaded:false};
  throw Error('Unexpected fixture action');
 }
}
async function harness(t,allowPaid=false){
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-engine-test-')),key=randomBytes(32).toString('base64'),provider=new TestProvider();
 const engine=createEngineAPI({folder,key,provider,allowPaid,origin:'https://studio.test',trustProxy:true});
 engine.store.put('admin',{id:'administrator',username:'admin',password:passwordHash('local-test-password-123'),role:'admin'});
 const server=http.createServer(engine.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let cookie='',csrf='';
 const request=async(route,value,method=value?'POST':'GET',extra={})=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/engine/'+route,{method,headers:{Origin:'https://studio.test','X-Forwarded-Proto':'https',Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...extra},...(value?{body:JSON.stringify(value)}:{})});
  const c=response.headers.get('set-cookie');if(c)cookie=c.split(';')[0];const data=await response.json();if(data.csrf)csrf=data.csrf;return {status:response.status,data,cookie:c};
 };
 const login=()=>request('login',{username:'admin',password:'local-test-password-123'});
 t.after(async()=>{provider.waiting?.();await new Promise(r=>setTimeout(r,15));server.closeAllConnections();await new Promise(r=>server.close(r));engine.close();await rm(folder,{recursive:true,force:true});});
 return {folder,key,engine,provider,request,login};
}
const primary=async h=>(await h.request('primary',{})).data;
const quote=async(h,a,extra={})=>h.request('quote',{action:'generate',accountId:a.id,settings:{},prompt:'A chronological cinematic scene with original Arabic dialogue.',projectId:'project-one',sceneId:'scene-one',...extra});

test('only two permitted GPUs and pinned native quality',()=>{assert.deepEqual(Object.keys(GPUS),['RTX-PRO-6000','L40S']);assert.equal(settings().gpu,'RTX-PRO-6000');assert.equal(quality.frames,241);assert.equal(quality.nativeAudio,true);assert.throws(()=>settings({gpu:'H100'}));assert.throws(()=>settings({ram:48}));assert.throws(()=>settings({timeout:0}));assert.throws(()=>settings({budget:NaN}));});
test('AES-GCM authenticates account identity and never stores plaintext',async t=>{
 const h=await harness(t);const sealed=h.engine.store.seal({tokenSecret:'example-secret'},'account-one');assert.equal(h.engine.store.open(sealed,'account-one').tokenSecret,'example-secret');assert.throws(()=>h.engine.store.open(sealed,'account-two'));assert.equal(sealed.includes('example-secret'),false);
});
test('unconfigured backend refuses all account operations',async()=>{const engine=createEngineAPI({key:undefined,store:null});let status,value;await engine.handler({url:'/api/engine/accounts',headers:{},socket:{}},{writeHead:s=>status=s,end:x=>value=x});assert.equal(status,503);assert.match(value,/BACKEND_NOT_CONFIGURED/);});
test('unauthenticated access is denied before contacting Modal',async t=>{const h=await harness(t);assert.equal((await h.request('state')).status,401);assert.equal(h.provider.calls.length,0);});
test('wrong password and HTTP credential intake are rejected',async t=>{const h=await harness(t);assert.equal((await h.request('login',{username:'admin',password:'wrong'})).status,401);assert.equal((await h.request('login',{username:'admin',password:'local-test-password-123'},'POST',{'X-Forwarded-Proto':'http'})).status,426);});
test('session cookie is Secure HttpOnly and CSRF protected',async t=>{const h=await harness(t);const login=await h.login();assert.match(login.cookie,/Secure/);assert.match(login.cookie,/HttpOnly/);assert.match(login.cookie,/SameSite=Strict/);assert.equal((await h.request('primary',{},'POST',{'X-CSRF-Token':''})).status,403);assert.equal(h.provider.calls.length,0);});
test('forged origin and non-admin role are denied',async t=>{const h=await harness(t);await h.login();assert.equal((await h.request('state',undefined,'GET',{Origin:'https://evil.test'})).status,403);h.engine.store.db.prepare('UPDATE sessions SET data=?').run(JSON.stringify({role:'viewer',expires:Date.now()+100000,csrf:'x'}));assert.equal((await h.request('state')).status,403);});
test('account links are verified, encrypted, deduplicated and redacted',async t=>{
 const h=await harness(t);await h.login();const input={tokenId:'ak-testidentifier123',tokenSecret:'as-testsecret1234567'};
 const linked=await h.request('accounts',input);assert.equal(linked.status,201);assert.equal(JSON.stringify(linked.data).includes(input.tokenSecret),false);
 assert.equal((await h.request('accounts',input)).status,409);const state=await h.request('state');assert.equal(JSON.stringify(state.data).includes('credentials'),false);assert.equal(h.engine.store.get('account',linked.data.id).credentials.includes(input.tokenSecret),false);
});
test('selecting account checks readiness but never creates a GPU job',async t=>{const h=await harness(t);await h.login();const a=await primary(h);const selected=await h.request('selection',{accountId:a.id,settings:{gpu:'L40S'}});assert.equal(selected.data.settings.gpu,'L40S');assert.equal(selected.data.weightsReady,true);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);});
test('primary cannot be a transfer destination',async t=>{const h=await harness(t);await h.login();const a=await primary(h);assert.match((await quote(h,a,{action:'prepare'})).data.error,/PRIMARY_STORAGE_IS_READ_ONLY/);});
test('prepare plan is read-only and includes missing bytes and unknown costs',async t=>{const h=await harness(t);await h.login();await primary(h);const backup=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;const q=await quote(h,backup,{action:'prepare'});assert.equal(q.status,200);assert.equal(q.data.plan.files.length,5);assert.ok(q.data.plan.requiredBytes>70e9);assert.equal(q.data.plan.networkCostUSD,null);assert.equal(h.provider.calls.some(c=>c.action==='transfer'),false);});
test('paid execution is disabled regardless of browser approval',async t=>{const h=await harness(t);await h.login();const q=await quote(h,await primary(h));const r=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});assert.equal(r.status,423);assert.equal(h.engine.store.all('job').length,0);});
test('budget, missing weights and fresh consent are enforced',async t=>{const h=await harness(t,true);await h.login();const a=await primary(h);assert.match((await quote(h,a,{settings:{budget:.01}})).data.error,/BUDGET/);const q=await quote(h,a);assert.match((await h.request('execute',{quoteId:q.data.id,confirmation:'yes'})).data.error,/APPROVAL/);const saved=h.engine.store.get('quote',q.data.id);saved.expiresAt=0;h.engine.store.put('quote',saved);assert.match((await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'})).data.error,/APPROVAL/);});
test('double click reuses one job; another quote cannot start a second GPU',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h),q=await quote(h,a);const input={quoteId:q.data.id,confirmation:'أوافق على التكلفة'};
 const first=await h.request('execute',input),second=await h.request('execute',input);assert.equal(first.data.id,second.data.id);assert.equal(h.provider.calls.filter(c=>c.action==='generate').length,1);
 const q2=await quote(h,a,{sceneId:'scene-two'});assert.match((await h.request('execute',{quoteId:q2.data.id,confirmation:'أوافق على التكلفة'})).data.error,/ONE_ACTIVE/);
 h.provider.waiting();await new Promise(r=>setTimeout(r,15));const job=h.engine.store.get('job',first.data.id);assert.equal(job.status,'completed');assert.equal(h.engine.store.get('scene',hash('project-one:scene-one')).status,'completed');
 const q3=await quote(h,a);assert.equal((await h.request('execute',{quoteId:q3.data.id,confirmation:'أوافق على التكلفة'})).status,409);assert.equal(h.provider.calls.filter(c=>c.action==='generate').length,1);
});
test('ambiguous cloud outcomes are never retried automatically',async t=>{const h=await harness(t,true);await h.login();const a=await primary(h);const original=h.provider.call.bind(h.provider);h.provider.call=async(...args)=>{if(args[0]==='generate'){h.provider.calls.push({action:'generate'});throw Error('connection lost with credential-like text');}return original(...args);};const q=await quote(h,a);const result=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});await new Promise(r=>setTimeout(r,20));const job=h.engine.store.get('job',result.data.id);assert.equal(job.status,'uncertain');assert.equal(job.cloudStopped,true);assert.equal(h.provider.calls.filter(c=>c.action==='generate').length,1);assert.equal(JSON.stringify(job).includes('credential-like'),false);});
test('unlink removes ciphertext and never deletes remote resources',async t=>{const h=await harness(t);await h.login();const a=await primary(h);const r=await h.request('accounts/'+a.id,undefined,'DELETE');assert.equal(r.data.remoteResourcesDeleted,false);assert.equal(h.engine.store.get('account',a.id),null);assert.equal(h.provider.calls.some(c=>c.action==='delete'),false);});
test('restart persists metadata and marks live jobs for manual reconciliation',async t=>{const folder=await mkdtemp(path.join(os.tmpdir(),'iff-restart-')),key=randomBytes(32).toString('base64');const s=new Store(folder,key);s.put('job',{id:'prior-id',action:'generate',status:'running',cloudStopped:false,events:[],accountId:'a'});s.close();const api=createEngineAPI({folder,key,provider:new TestProvider()});assert.equal(api.store.get('job','prior-id').status,'recovery_required');assert.equal(api.store.get('job','prior-id').id,'prior-id');api.close();await rm(folder,{recursive:true,force:true});});
test('frontend never persists secrets and exposes only the approved GPU pair',async()=>{const page=await readFile('site/engines.html','utf8'),js=await readFile('site/engines.js','utf8');assert.match(page,/dir="rtl"/);assert.equal((page.match(/value="(?:RTX-PRO-6000|L40S)"/g)||[]).length,2);assert.doesNotMatch(page,/H100|A100/);assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML/);assert.match(page,/type="password"/);});
test('application monthly guard is independent of Modal billing',async t=>{const h=await harness(t,true);await h.login();const a=await primary(h);assert.equal((await h.request('budget',{limitUSD:.10})).status,200);assert.match((await quote(h,a)).data.error,/MONTHLY_LIMIT/);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);assert.equal((await h.request('budget',{limitUSD:null})).status,200);assert.equal((await quote(h,a)).status,200);});
test('HF secret is independently encrypted and deletable without export',async t=>{const h=await harness(t);await h.login();const a=await primary(h);const result=await h.request('accounts/'+a.id+'/hf',{token:'hf_localfixture123456789012345'});assert.equal(result.data.exportedToModal,false);assert.ok(h.engine.store.get('account',a.id).hf);assert.equal((await h.request('accounts/'+a.id+'/hf',undefined,'DELETE')).data.deleted,true);assert.equal(h.engine.store.get('account',a.id).hf,undefined);assert.equal(h.provider.calls.some(c=>c.action==='transfer'),false);});
test('official-source preparation requires separate HF token and license acknowledgement',async t=>{const h=await harness(t);await h.login();const backup=(await h.request('accounts',{tokenId:'ak-backupfixture123',tokenSecret:'as-backupfixture123456'})).data;assert.match((await quote(h,backup,{action:'prepare',source:'official'})).data.error,/HF_TOKEN/);await h.request('accounts/'+backup.id+'/hf',{token:'hf_localfixture123456789012345'});assert.match((await quote(h,backup,{action:'prepare',source:'official'})).data.error,/LICENSE/);const plan=await quote(h,backup,{action:'prepare',source:'official',licenseAccepted:true});assert.equal(plan.status,200);assert.equal(plan.data.plan.source,'official');assert.equal(plan.data.estimate.rate,null);assert.equal(h.provider.calls.some(c=>c.action==='transfer'),false);});
test('reference files persist independently and cannot be silently replaced',async t=>{const h=await harness(t);await h.login();const a=await primary(h),image=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,1]);const refs=[{assetId:'asset-one',name:'local fixture',data:'data:image/png;base64,'+image.toString('base64')}];const q=await quote(h,a,{references:refs,projectSnapshot:{id:'project-one',name:'Fixture',plan:{preparedAt:1}}});assert.equal(q.status,200);const saved=await h.request('projects/project-one/references');assert.equal(saved.data.length,1);assert.equal(saved.data[0].path,undefined);refs[0].data='data:image/png;base64,'+Buffer.concat([image,Buffer.from([2])]).toString('base64');assert.match((await quote(h,a,{references:refs})).data.error,/IMMUTABLE/);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);});
test('completed job metadata remains accessible after account unlink',async t=>{const h=await harness(t);await h.login();const a=await primary(h);h.engine.store.put('job',{id:'33333333-3333-3333-3333-333333333333',accountId:a.id,workspace:a.workspace,action:'generate',status:'completed',cloudStopped:true,events:[],createdAt:Date.now(),estimate:{rate:.001,resourceWindowUSD:1},result:{videoVerified:true}});await h.request('accounts/'+a.id,undefined,'DELETE');const job=await h.request('jobs/33333333-3333-3333-3333-333333333333');assert.equal(job.status,200);assert.equal(job.data.result.videoVerified,true);});
test('verified failure can be retried only with a fresh quote and preserves attempt history',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h),original=h.provider.call.bind(h.provider);let failed=false;
 h.provider.call=async(action,input,onEvent,...args)=>{if(action==='generate'&&!failed){failed=true;onEvent({kind:'phase_error',phase:'gpu_operation',error_type:'OutOfMemoryError'});throw Error('fixture GPU failure');}return original(action,input,onEvent,...args);};
 const firstQuote=await quote(h,a),first=await h.request('execute',{quoteId:firstQuote.data.id,confirmation:'أوافق على التكلفة'});await new Promise(r=>setTimeout(r,20));
 assert.equal(h.engine.store.get('job',first.data.id).status,'failed');
 const retry=await quote(h,a,{retryOfJobId:first.data.id,settings:{gpu:'L40S'}});assert.equal(retry.status,200);
 const next=await h.request('execute',{quoteId:retry.data.id,confirmation:'أوافق على التكلفة'});assert.notEqual(next.data.id,first.data.id);h.provider.waiting();await new Promise(r=>setTimeout(r,20));
 const scene=h.engine.store.get('scene',hash('project-one:scene-one'));assert.equal(scene.status,'completed');assert.deepEqual(scene.history,[first.data.id]);assert.equal(h.engine.store.get('job',first.data.id).status,'failed');
 assert.match((await quote(h,a,{retryOfJobId:first.data.id})).data.error,/NEWER_ATTEMPT/);
});
