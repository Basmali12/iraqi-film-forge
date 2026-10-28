import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createEngineAPI} from '../engine/api.mjs';
import {Store,passwordHash,hash} from '../engine/store.mjs';
import {settings,estimate,runtimeLimits,quality,GPUS,manifest} from '../engine/config.mjs';

// Deliberately isolated fixture, never imported by the production backend.
class TestProvider {
 constructor(){this.calls=[];this.waiting=null;}
 session(input,onEvent){
  this.calls.push({action:'session',input});let resolve;
  const done=new Promise(r=>resolve=r);
  const timer=setTimeout(()=>{onEvent({kind:'app_created',phase:'application_setup',app_id:'ap-session-fixture'});onEvent({kind:'ready',phase:'ready',ready_until:Date.now()+60000});},5);
  const stop=()=>{clearTimeout(timer);resolve({cloud_stopped:true,running_containers:0,tasks:0});};
  this.waiting=stop;
  return {done,stop,generate:(payload,sceneEvent)=>{this.calls.push({action:'session-generate',input:payload});sceneEvent({kind:'phase_start',phase:'text_forward'});onEvent({kind:'ready',phase:'ready',ready_until:Date.now()+1200000});return Promise.resolve({videoVerified:true,cloud_stopped:false,sha256:'fixture',recordedCost:null});}};
 }
 async call(action,input,onEvent=()=>{}){
  this.calls.push({action,input});
  if(action==='quality_discover')return {ready:true,profile:'ltx25-dfr-diffvae-v1',files:[]};
  if(action==='verify')return {workspace:input.credentials.mode==='local_profile'?'basm1998ali':'backup-workspace'};
  if(action==='discover')return {ready:input.volume==='modal-ltx25-test-models',files:input.volume==='modal-ltx25-test-models'?Object.entries(manifest.files).map(([name,f])=>({name,size:f.size,manifestMatch:true})):[],capacity:'unknown'};
  if(['stop','inspect'].includes(action))return {cloud_stopped:true,running_containers:0,tasks:0};
  if(action==='generate'){onEvent({kind:'app_created',app_id:'ap-fixture'});return new Promise(resolve=>{this.waiting=()=>resolve({videoVerified:true,cloud_stopped:true,sha256:'fixture',recordedCost:null});});}
  if(action==='transfer')return {ready:true,cloud_stopped:true};
  if(action==='cloud_transfer_preflight')return {workerReady:true,fingerprint:'fixture-only',workerApp:'iff-ltx25-cloud-copy-v1'};
  if(action==='cloud_transfer_dispatch')return {call_id:'fc-fixture',worker_app_id:'ap-worker-fixture'};
  if(action==='cloud_transfer_status')return {cloud_stopped:true,callFinished:true,running_containers:0,tasks:0,events:[],result:{ready:true,inspection:{ready:true,files:[]}}};
  if(action==='cloud_transfer_stop')return {cloud_stopped:true,callFinished:true,running_containers:0,tasks:0,events:[],result:{ready:false,error:'TRANSFER_CANCELLED'}};
  if(action==='official_plan')return {files:Object.entries(manifest.files).map(([name,f])=>({name,size:f.size})),modelDownloaded:false};
  throw Error('Unexpected fixture action');
 }
}
async function harness(t,allowPaid=false,options={}){
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-engine-test-')),key=randomBytes(32).toString('base64'),provider=new TestProvider();
 const engine=await createEngineAPI({folder,key,provider,allowPaid,origin:'https://studio.test',trustProxy:true,cloudTransferApp:'iff-ltx25-cloud-copy-v1',textQuality:{available:async()=>({ready:true}),process:async(_job,result)=>({...result,textQuality:{status:'passed',fixture:true}})},...options});
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

test('DFR quote refuses a missing CPU text checker before any GPU dispatch',async t=>{
 const h=await harness(t,true,{textQuality:{available:async()=>{throw Error('TEXT_QC_NOT_CONFIGURED');}}});
 await h.login();const a=await primary(h);const q=await quote(h,a,{action:'start'});
 assert.equal(q.data.error,'TEXT_QC_NOT_CONFIGURED');
 assert.equal(h.provider.calls.some(c=>['session','generate','session-generate'].includes(c.action)),false);
});

test('base weights alone cannot authorize DFR or silently fall back to Conv',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const original=h.provider.call.bind(h.provider);
 h.provider.call=(action,...args)=>action==='quality_discover'?Promise.resolve({ready:false,files:[]}):original(action,...args);
 const q=await quote(h,a,{action:'start'});assert.equal(q.data.error,'LTX_DFR_WEIGHTS_REQUIRED');
 assert.equal(h.provider.calls.some(c=>['session','generate'].includes(c.action)),false);
});

test('failed text acceptance keeps cloud generation successful and prohibits generation retry',async t=>{
 const h=await harness(t,true,{textQuality:{available:async()=>({ready:true}),process:async(_job,result)=>({...result,generationSucceeded:true,textQuality:{status:'needs_review',boxes_after:1}})}});
 await h.login();const a=await primary(h);
 const start=await quote(h,a,{action:'start'}),begin=await h.request('execute',{quoteId:start.data.id,approvedCost:true});
 const warm=await waitJob(h,begin.data.id,j=>j?.status==='ready');
 const q=await quote(h,a,{engineJobId:warm.id}),run=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 const job=await waitJob(h,run.data.id,j=>j?.status==='needs_review');
 assert.equal(job.result.videoVerified,true);assert.equal(job.result.generationSucceeded,true);
 assert.equal(job.error,'GENERATION_SUCCEEDED_TEXT_REVIEW_REQUIRED');
 assert.equal(h.provider.calls.filter(c=>c.action==='session-generate').length,1);
 const retry=await quote(h,a,{engineJobId:warm.id,retryOfJobId:job.id});
 if(retry.status===200)assert.notEqual((await h.request('execute',{quoteId:retry.data.id,approvedCost:true})).status,202);
 assert.equal(h.provider.calls.filter(c=>c.action==='session-generate').length,1);
});
const primary=async h=>(await h.request('primary',{})).data;
const quote=async(h,a,extra={})=>h.request('quote',{action:'generate',accountId:a.id,settings:{},prompt:'A chronological cinematic scene with original Arabic dialogue.',audioContract:{lines:[{speaker:'علي، الشاب بالجاكيت البني',text:'هلا بيك، شلونك اليوم؟'}]},projectId:'project-one',sceneId:'scene-one',...extra});

test('retired provider routes cannot read keys, submit text or video, and financial fields remain honest',async t=>{
 const calls=[];const h=await harness(t,false,{textFetch:async(url)=>{calls.push(url);return Response.json({});}});await h.login();
 for(const route of ['router/config','router/config/video','router/chat/calls','router/video/requests']){const result=await h.request(route,route==='router/config'?undefined:{});assert.equal(result.status,404);}
 const a=await primary(h);assert.equal(a.billing.creditBalanceUSD,null);assert.equal(a.billing.creditRenewalAt,null);assert.equal(a.billing.subscriptionExpiresAt,null);assert.equal(calls.length,0);
});

test('retiring provider secrets keeps historical receipts and prevents silent migration of old scenes',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-retired-')),key=randomBytes(32).toString('base64'),store=new Store(folder,key),provider=new TestProvider();
 store.put('config',{id:'openrouter-video',credentials:store.seal({key:'fixture-retired-key'},'retired')});
 store.put('router-video-request',{id:'old-receipt',status:'completed',cost:.27,credentials:store.seal({key:'fixture-retired-key'},'retired')});
 store.put('project',{id:'old-film',snapshot:{id:'old-film',videoProvider:'retired',plan:{slots:[{status:'done',jobId:'old-receipt'}]}}});
 const api=await createEngineAPI({folder,key,store,provider,origin:'https://studio.test',allowPaid:false});
 try{assert.equal(await store.get('config','openrouter-video'),null);const receipt=await store.get('router-video-request','old-receipt');assert.equal(receipt.credentials,undefined);assert.equal(receipt.cost,.27);assert.equal((await store.get('project','old-film')).snapshot.plan.slots[0].jobId,'old-receipt');assert.equal(provider.calls.length,0);}finally{await api.close();await rm(folder,{recursive:true,force:true});}
});

test('OpenAI settings require admin, HTTPS/CSRF and return only saved status; no Modal calls',async t=>{
 const network=[];const h=await harness(t,false,{textFetch:async(url)=>{network.push(url);return Response.json({id:'gpt-6-luna'});}});
 assert.equal((await h.request('llm/config')).status,401);await h.login();
 assert.equal((await h.request('llm/config')).data.configured,false);assert.equal(network.length,0);
 assert.equal((await h.request('llm/config',{key:'sk-fixture-not-real-123456789012345'},'POST',{'X-CSRF-Token':'bad'})).status,403);assert.equal(network.length,0);
 const saved=await h.request('llm/config',{key:'sk-fixture-not-real-123456789012345'});assert.equal(saved.status,200);assert.equal(saved.data.configured,true);assert.equal(JSON.stringify(saved.data).includes('sk-fixture'),false);assert.equal(saved.data.credentials,undefined);assert.equal(network.length,1);assert.equal(h.provider.calls.length,0);
 assert.equal((await h.request('llm/calls',{requestId:'test-call',projectId:'test-project',mode:'discuss',messages:[{role:'user',content:'hello'}]})).data.error,'TEXT_COST_APPROVAL_REQUIRED');
 assert.equal((await h.request('llm/config',undefined,'DELETE')).data.configured,false);
});

test('neural graph restores server-owned jobs without GPU dispatch or private prompt disclosure',async t=>{
 const h=await harness(t);assert.equal((await h.request('projects/graph-film/network')).status,401);await h.login();
 h.engine.store.put('project',{id:'graph-film',snapshot:{id:'graph-film',name:'فيلم محفوظ',plan:{seconds:20,slots:[{index:1,start:0,end:10,status:'pending'},{index:2,start:10,end:20,status:'pending'}]}}});
 h.engine.store.put('job',{id:'graph-first',action:'generate',projectId:'graph-film',sceneId:'scene-1',status:'completed',cloudStopped:true,prompt:'private fixture prompt',result:{videoVerified:true},events:[]});
 h.engine.store.put('job',{id:'graph-second',action:'generate',projectId:'graph-film',sceneId:'scene-2',attachedEngineId:'fixture-warm',status:'running',cloudStopped:false,events:[{phase:'denoise',completed:3,total:8}]});
 for(const [sceneId,jobId] of [['scene-1','graph-first'],['scene-2','graph-second']])h.engine.store.put('scene',{id:sceneId,projectId:'graph-film',sceneId,jobId});
 const result=await h.request('projects/graph-film/network');assert.equal(result.status,200);assert.equal(result.data.plan.slots[0].status,'done');assert.equal(result.data.plan.slots[0].videoURL,'/api/engine/jobs/graph-first/video');assert.equal(result.data.plan.slots[1].completed,3);assert.equal(result.data.cloudMutation,false);assert.equal(JSON.stringify(result.data).includes('private fixture'),false);assert.equal(h.provider.calls.length,0);
 h.engine.store.get('job','graph-second');const job=h.engine.store.get('job','graph-second');job.status='failed';job.cloudStopped=true;h.engine.store.put('job',job);
 const refreshed=(await h.request('projects/graph-film/network')).data;assert.equal(refreshed.plan.slots[0].status,'done');assert.equal(refreshed.plan.slots[1].status,'failed');assert.equal(h.provider.calls.length,0);
});

test('conversation rename and recoverable deletion preserve video files and do not invoke Modal',async t=>{
 const h=await harness(t);await h.login();const p={id:'chat-history',name:'Original',messages:[{role:'user',content:'قصة محفوظة'}],assets:[],plan:null};assert.equal((await h.request('projects/save',{snapshot:p})).status,200);
 const media=path.join(h.folder,'artifacts','successful-clip');await mkdir(media,{recursive:true});await writeFile(path.join(media,'video.mp4'),'existing fixture video, never replace');
 assert.equal((await h.request('projects/chat-history/rename',{name:'الأمانة'})).data.name,'الأمانة');
 assert.equal((await h.request('projects/chat-history/archive',{})).data.videosPreserved,true);assert.equal((await h.request('projects')).data.some(r=>r.id===p.id),false);
 assert.equal((await h.request('projects/save',{snapshot:p})).data.error,'PROJECT_ARCHIVED_RESTORE_FIRST');assert.equal((await h.request('projects/archived')).data[0].id,p.id);
 assert.equal(await readFile(path.join(media,'video.mp4'),'utf8'),'existing fixture video, never replace');
 await h.request('projects/chat-history/restore',{});assert.equal((await h.request('projects')).data.some(r=>r.id===p.id),true);assert.equal(h.provider.calls.length,0);
});

test('creative library is administrator protected, persistent and rejects stale edits',async t=>{
 const h=await harness(t);assert.notEqual((await h.request('creative/library')).status,200);await h.login();
 const library={revision:0,characters:[{id:'ali',name:'علي',description:'جاكيت بني',voice:'شاب طبيعي',dialect:'عراقي'},{id:'abu',name:'أبو حسن',description:'قميص أزرق',voice:'كبير هادئ',dialect:'عراقي'}],props:[{id:'wallet',name:'محفظة',description:'محفظة جيب جلدية بحجم الكف'}]};
 const saved=await h.request('creative/library',library);assert.equal(saved.status,200);assert.equal(saved.data.library.revision,1);
 assert.equal((await h.request('creative/library',library)).data.error,'CREATIVE_LIBRARY_CHANGED_RELOAD');
 const loaded=(await h.request('creative/library')).data;assert.equal(loaded.library.characters.length,2);assert.equal(loaded.capabilities.ingredients.ready,false);
 const ingredients=(await h.request('creative/ingredients-plan')).data;assert.equal(ingredients.inferenceReady,false);assert.equal(ingredients.weightsDownloaded,false);assert.equal(ingredients.bytes,1308778338);assert.ok(ingredients.estimatedStorageUSDPerMonth>0);
 const a=await primary(h),creativeScene={characterIds:['ali','abu'],propIds:['wallet'],turns:[{speakerId:'abu',listenerIds:['ali'],text:'إي ابني محفظتي'}]};
 const q=await quote(h,a,{creativeScene,audioContract:{lines:[{speaker:'أبو حسن، قميص أزرق',text:'إي ابني محفظتي'}]}});assert.equal(q.status,200);assert.equal(q.data.creativeSnapshot.turns[0].speakerId,'abu');assert.match(q.data.prompt,/أبو حسن \(قميص أزرق\)/);
 assert.equal((await quote(h,a,{creativeScene:{...creativeScene,referenceMode:'ingredients'}})).data.error,'INGREDIENTS_INFERENCE_NOT_CONFIGURED');
 assert.equal((await quote(h,a,{creativeScene:{...creativeScene,turns:[{speakerId:'unknown',text:'x'}]}})).data.error,'SPEAKER_NOT_IN_SCENE');
 assert.equal(h.provider.calls.some(c=>['generate','session'].includes(c.action)),false);
});
test('reference library stores immutable private images without claiming native conditioning',async t=>{
 const h=await harness(t);await h.login();const bytes=Buffer.from([137,80,78,71,13,10,26,10,...Array(24).fill(0)]),data='data:image/png;base64,'+bytes.toString('base64');
 const saved=await h.request('creative/reference',{assetId:'wallet-ref',name:'محفظة',data});assert.equal(saved.status,200);assert.equal(saved.data.conditioningActive,false);assert.equal(saved.data.path,undefined);
 const row=h.engine.store.get('reference',saved.data.id);assert.equal(row.projectId,'creative-library');assert.deepEqual(await readFile(row.path),bytes);
 assert.equal((await h.request('creative/reference',{assetId:'wallet-ref',data:'data:image/png;base64,'+Buffer.concat([bytes,Buffer.from([1])]).toString('base64')})).data.error,'REFERENCE_ASSET_IMMUTABLE_USE_NEW_ID');
});
test('audio cleanup capability is private, runs in background but cannot run missing dependencies',async t=>{
 const h=await harness(t);assert.notEqual((await h.request('audio/config')).status,200);await h.login();const r=await h.request('audio/config');assert.equal(r.status,200);assert.equal(r.data.config.enabled,true);assert.equal(r.data.capability.gpu,false);
 if(!r.data.capability.ready)assert.equal((await h.request('audio/config',{enabled:true,attenuationDb:6})).data.error,'AUDIO_CLEANUP_UNAVAILABLE');
 assert.equal(h.provider.calls.length,0);
});
test('short Arabic scene is accepted while empty input never dispatches GPU',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const accepted=await quote(h,a,{prompt:'شخص يمشي في الصحرا'});assert.equal(accepted.status,200);
 assert.ok(accepted.data.prompt.startsWith('شخص يمشي في الصحرا'));assert.match(accepted.data.prompt,/native-av-clean-v3/);assert.equal(accepted.data.generationRulesVersion,'native-av-clean-v3');
 for(const prompt of ['', '  ',null])assert.equal((await quote(h,a,{prompt})).data.error,'PROMPT_REQUIRED');
 assert.equal(h.provider.calls.some(c=>['generate','session'].includes(c.action)),false);
});
test('prompt and orientation draft persist independently of Modal resources and accounts',async t=>{
 const h=await harness(t);await h.login();
 assert.equal((await h.request('draft',{prompt:'وصف محفوظ',orientation:'landscape'})).data.saved,true);
 assert.equal((await h.request('draft')).data.prompt,'وصف محفوظ');
 assert.equal((await h.request('draft')).data.orientation,'landscape');
 assert.equal(h.provider.calls.length,0);
 assert.equal((await h.request('draft',{prompt:'x',orientation:'square'})).data.error,'INVALID_DRAFT');
});
test('preparing an advertisement is authenticated local computation without any provider operation',async t=>{
 const h=await harness(t);assert.equal((await h.request('prompt/prepare',{request:'إعلان'})).status,401);
 await h.login();const prepared=await h.request('prompt/prepare',{request:'اعلان عن شركة برمجة اسمها فن التقنية الحديثة باللهجة العراقية'});
 assert.equal(prepared.status,200);assert.equal(prepared.data.paid,false);assert.equal(h.provider.calls.length,0);
 assert.match(prepared.data.compiledPrompt,/software studio/);
});
test('one-click cost approval requires explicit true and dispatches the quote only once',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}});
 for(const approvedCost of [undefined,false,'true',1]){
  const rejected=await h.request('execute',{quoteId:q.data.id,approvedCost});
  assert.match(rejected.data.error,/APPROVAL/);
 }
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,0);
 const accepted=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 const duplicate=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 assert.equal(accepted.status,202);assert.equal(duplicate.data.id,accepted.data.id);
 await waitJob(h,accepted.data.id,j=>j?.status==='ready');
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);
});
async function waitJob(h,id,predicate){for(let n=0;n<100;n++){const j=h.engine.store.get('job',id);if(predicate(j))return j;await new Promise(r=>setTimeout(r,5));}throw Error('FIXTURE_STATE_TIMEOUT');}

test('fixed-primary server rejects backup execution and primary unlink',async t=>{
 const h=await harness(t,true,{primaryOnly:true});await h.login();const a=await primary(h);
 const backup=(await h.request('accounts',{tokenId:'ak-backupfixture123',tokenSecret:'as-backupfixture123456'})).data;
 assert.equal((await quote(h,backup)).data.error,'PRIMARY_ACCOUNT_IS_FIXED');
 assert.equal((await h.request('accounts/'+a.id,undefined,'DELETE')).data.error,'PRIMARY_ACCOUNT_IS_FIXED');
 assert.equal(h.provider.calls.some(c=>['session','generate','transfer'].includes(c.action)),false);
});

test('stop requested before app ID is repeated only as cancellation when the ID arrives',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);let announce,resolve;
 h.provider.session=(input,emit)=>{h.provider.calls.push({action:'session'});announce=()=>emit({kind:'app_created',phase:'application_setup',app_id:'ap-late-fixture'});return {done:new Promise(r=>resolve=r),stop(){},generate(){throw Error('UNEXPECTED_GENERATE');}};};h.provider.waiting=()=>resolve?.({cloud_stopped:true});
 const original=h.provider.call.bind(h.provider);
 h.provider.call=async(action,input,...rest)=>{
  if(action==='stop'){h.provider.calls.push({action,input});if(!input.appId)return {cloud_stopped:false};resolve({cloud_stopped:true});return {cloud_stopped:true};}
  return original(action,input,...rest);
 };
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}}),start=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});
 await waitJob(h,start.data.id,()=>!!announce);
 const stopped=await h.request('jobs/'+start.data.id+'/stop',{confirmCancel:true});assert.equal(stopped.data.cloudStopped,false);
 announce();await waitJob(h,start.data.id,j=>j?.cloudStopped);
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);
 assert.equal(h.provider.calls.filter(c=>c.action==='stop'&&c.input.appId==='ap-late-fixture').length,1);
});

test('start prepares without a prompt, then a new prompt uses the same GPU session exactly once',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}});assert.equal(q.status,200);assert.equal(q.data.prompt,null);
 const start=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});
 const ready=await waitJob(h,start.data.id,j=>j?.status==='ready');assert.ok(ready.readyUntil>Date.now());
 const prompt='A completely new scene written only after the engine is ready, native dialogue.';
 const plan=await quote(h,a,{prompt,engineJobId:ready.id});assert.equal(plan.status,200);
 const first=await h.request('execute',{quoteId:plan.data.id,confirmation:'أوافق على التكلفة'});
 const second=await h.request('execute',{quoteId:plan.data.id,confirmation:'أوافق على التكلفة'});assert.equal(second.data.id,first.data.id);
 await waitJob(h,first.data.id,j=>j?.status==='completed');
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);assert.equal(h.provider.calls.filter(c=>c.action==='session-generate').length,1);
 assert.equal(h.provider.calls.find(c=>c.action==='session-generate').input.prompt,plan.data.prompt);assert.ok(plan.data.prompt.startsWith(prompt));assert.match(plan.data.prompt,/native-av-clean-v3/);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);
});

test('next scene passes the actual saved last-frame path through one prepared session without a new GPU',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}}),start=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 const warm=await waitJob(h,start.data.id,j=>j?.status==='ready');
 const first=await quote(h,a,{engineJobId:warm.id}),one=await h.request('execute',{quoteId:first.data.id,approvedCost:true});
 await waitJob(h,one.data.id,j=>j?.status==='completed');
 const folder=path.join(h.folder,'artifacts',one.data.id);await mkdir(folder,{recursive:true});
 const frame=path.join(folder,'last-frame.png');await writeFile(frame,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
 const next=await quote(h,a,{engineJobId:warm.id,sceneId:'scene-two',previousSceneId:'scene-one',prompt:'A different next event, after the first action.'});assert.equal(next.status,200);
 const two=await h.request('execute',{quoteId:next.data.id,approvedCost:true});assert.equal(two.status,202);
 await waitJob(h,two.data.id,j=>j?.status==='completed');
 const generated=h.provider.calls.filter(c=>c.action==='session-generate');assert.equal(generated.length,2);
 assert.equal(generated[1].input.previousFrame,frame);assert.ok(generated[1].input.prompt.startsWith('A different next event, after the first action.'));assert.match(generated[1].input.prompt,/native-av-clean-v3/);
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);
 const replay=await h.request('execute',{quoteId:next.data.id,approvedCost:true});assert.equal(replay.data.id,two.data.id);
 assert.equal(h.provider.calls.filter(c=>c.action==='session-generate').length,2);
});

test('two separately approved scenes reuse one prepared session until manual stop',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}});
 assert.equal(q.data.settings.idleSeconds,1200);assert.equal(q.data.settings.budget,3);
 const initial=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 await waitJob(h,initial.data.id,j=>j?.status==='ready');
 const outputs=[];
 for(const sceneId of ['first-scene','second-scene']){
  const planned=await quote(h,a,{engineJobId:initial.data.id,sceneId,prompt:'شخص يمشي في الصحرا',settings:{orientation:sceneId==='second-scene'?'landscape':'portrait'}});
  assert.equal(planned.status,200);
  assert.equal(planned.data.quality.width,sceneId==='second-scene'?1280:720);
  const launched=await h.request('execute',{quoteId:planned.data.id,approvedCost:true});
  assert.equal(launched.status,202,JSON.stringify(launched.data));
  const completed=await waitJob(h,launched.data.id,j=>j?.status==='completed');
  assert.equal(completed.result.videoVerified,true);assert.equal(completed.cloudStopped,false);outputs.push(completed.id);
  await waitJob(h,initial.data.id,j=>j?.status==='ready');
 }
 assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);
 assert.equal(h.provider.calls.filter(c=>c.action==='session-generate').length,2);
 await h.request('jobs/'+initial.data.id+'/stop',{confirmCancel:true});
 await waitJob(h,initial.data.id,j=>j?.cloudStopped);
 for(const id of outputs)await waitJob(h,id,j=>j?.cloudStopped&&j.status==='completed');
});

test('expired prepared session never falls back to a new GPU task',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}});const start=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});
 const ready=await waitJob(h,start.data.id,j=>j?.status==='ready');
 const plan=await quote(h,a,{engineJobId:ready.id});assert.equal(plan.status,200);
 ready.readyUntil=Date.now()-1;h.engine.store.put('job',ready);
 const result=await h.request('execute',{quoteId:plan.data.id,confirmation:'أوافق على التكلفة'});
 assert.equal(result.data.error,'ENGINE_SESSION_EXPIRED_NO_NEW_GPU');assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);
});

test('one power-stop request resolves resource state without creating another session',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}}),start=await h.request('execute',{quoteId:q.data.id,confirmation:'أوافق على التكلفة'});
 await waitJob(h,start.data.id,j=>j?.status==='ready');
 const stop=await h.request('jobs/'+start.data.id+'/stop',{confirmCancel:true});assert.equal(stop.status,200);assert.equal(stop.data.cloudStopped,true);
 await waitJob(h,start.data.id,j=>j?.cloudStopped);assert.equal(h.provider.calls.filter(c=>c.action==='session').length,1);
});

test('authenticated draft and conversation save persists without any Modal request',async t=>{
 const h=await harness(t);const snapshot={id:'story-one',name:'فيلم',messages:[{role:'user',content:'بداية القصة'}],assets:[],plan:null};
 assert.equal((await h.request('projects/save',{snapshot})).status,401);
 await h.login();assert.equal((await h.request('projects/save',{snapshot})).status,200);
 assert.deepEqual((await h.request('projects')).data[0].snapshot.messages,snapshot.messages);
 assert.equal(h.provider.calls.length,0);
 assert.equal((await h.request('projects/save',{snapshot:{...snapshot,tokenSecret:'must-not-store'}})).status,400);
 assert.equal((await h.request('projects/save',{snapshot:{...snapshot,messages:[{role:'system',content:'bad'}]}})).status,400);
});

test('insufficient private staging disk blocks preparation before any transfer call',async t=>{
 const h=await harness(t,true);await h.login();
 const backup=(await h.request('accounts',{tokenId:'ak-backupfixture123',tokenSecret:'as-backupfixture123456'})).data;
 await h.request('accounts/'+backup.id+'/hf',{token:'hf_localfixture123456789012345'});
 const original=h.provider.call.bind(h.provider);
 h.provider.call=async(action,...args)=>action==='official_plan'?{files:[{name:'synthetic-huge-file',size:1e15}]}:original(action,...args);
 const plan=await quote(h,backup,{action:'prepare',source:'official',licenseAccepted:true});
 assert.equal(plan.status,200);assert.equal(plan.data.plan.localStagingReady,false);
 const execute=await h.request('execute',{quoteId:plan.data.id,confirmation:'أوافق على التكلفة'});
 assert.equal(execute.data.error,'PRIVATE_STAGING_DISK_INSUFFICIENT');
 assert.equal(h.provider.calls.some(c=>c.action==='transfer'),false);assert.equal(h.engine.store.all('job').length,0);
});

test('only two permitted GPUs and pinned native quality',()=>{assert.deepEqual(Object.keys(GPUS),['RTX-PRO-6000','L40S']);assert.equal(settings().gpu,'RTX-PRO-6000');assert.equal(quality.frames,241);assert.equal(quality.nativeAudio,true);assert.throws(()=>settings({gpu:'H100'}));assert.throws(()=>settings({ram:48}));assert.throws(()=>settings({timeout:-1}));assert.throws(()=>settings({budget:NaN}));});

test('zero controls mean manual operation, never zero-second Modal execution or invented total cost',()=>{
 const s=settings({timeout:0,startup:0,budget:0});
 assert.deepEqual(runtimeLimits(s),{timeout:86400,startup:86400});
 const cost=estimate(s);assert.equal(cost.windowSeconds,null);assert.equal(cost.resourceWindowUSD,null);assert.ok(cost.rate>0);assert.equal(s.budget,0);
 for(const bad of [{timeout:-1},{startup:-1},{budget:-1},{budget:Infinity}])assert.throws(()=>settings(bad));
 assert.equal(estimate(settings()).windowSeconds,1980);
});

test('manual settings persist with explicit consent and keep a monthly guard independent',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const manual={timeout:0,startup:0,budget:0};
 const q=await quote(h,a,{action:'start',settings:manual});assert.equal(q.status,200);
 assert.equal(q.data.estimate.resourceWindowUSD,null);assert.equal(q.data.settings.budget,0);
 assert.equal(h.provider.calls.some(c=>c.action==='session'),false);
 assert.match((await h.request('execute',{quoteId:q.data.id,approvedCost:false})).data.error,/APPROVAL/);
 await h.request('budget',{limitUSD:10});
 assert.equal((await quote(h,a,{action:'start',settings:manual})).data.error,'APPLICATION_MONTHLY_LIMIT_REQUIRES_BOUNDED_PLAN');
 assert.equal((await h.request('execute',{quoteId:q.data.id,approvedCost:true})).data.error,'APPLICATION_MONTHLY_LIMIT_REQUIRES_BOUNDED_PLAN');
 assert.equal(h.provider.calls.some(c=>c.action==='session'),false);
 await h.request('budget',{limitUSD:null});
 const started=await h.request('execute',{quoteId:q.data.id,approvedCost:true});assert.equal(started.status,202);
 await new Promise(r=>setTimeout(r,30));
 const session=h.provider.calls.find(c=>c.action==='session');assert.equal(session.input.settings.timeout,0);assert.equal(session.input.settings.startup,0);assert.equal(session.input.settings.budget,0);
});
test('AES-GCM authenticates account identity and never stores plaintext',async t=>{
 const h=await harness(t);const sealed=h.engine.store.seal({tokenSecret:'example-secret'},'account-one');assert.equal(h.engine.store.open(sealed,'account-one').tokenSecret,'example-secret');assert.throws(()=>h.engine.store.open(sealed,'account-two'));assert.equal(sealed.includes('example-secret'),false);
});
test('unconfigured backend refuses all account operations',async()=>{const engine=await createEngineAPI({key:undefined,store:null});let status,value;await engine.handler({url:'/api/engine/accounts',headers:{},socket:{}},{writeHead:s=>status=s,end:x=>value=x});assert.equal(status,503);assert.match(value,/BACKEND_NOT_CONFIGURED/);});
test('unauthenticated access is denied before contacting Modal',async t=>{const h=await harness(t);assert.equal((await h.request('state')).status,401);assert.equal(h.provider.calls.length,0);});
test('wrong password and HTTP credential intake are rejected',async t=>{const h=await harness(t);assert.equal((await h.request('login',{username:'admin',password:'wrong'})).status,401);assert.equal((await h.request('login',{username:'admin',password:'local-test-password-123'},'POST',{'X-Forwarded-Proto':'http'})).status,426);});
test('session cookie is Secure HttpOnly and CSRF protected',async t=>{const h=await harness(t);const login=await h.login();assert.match(login.cookie,/Secure/);assert.match(login.cookie,/HttpOnly/);assert.match(login.cookie,/SameSite=Strict/);assert.equal((await h.request('primary',{},'POST',{'X-CSRF-Token':''})).status,403);assert.equal(h.provider.calls.length,0);});
test('forged origin and non-admin role are denied',async t=>{const h=await harness(t);await h.login();assert.equal((await h.request('state',undefined,'GET',{Origin:'https://evil.test'})).status,403);h.engine.store.db.prepare('UPDATE sessions SET data=?').run(JSON.stringify({role:'viewer',expires:Date.now()+100000,csrf:'x'}));assert.equal((await h.request('state')).status,403);});
test('account links are verified, encrypted, deduplicated and redacted',async t=>{
 const h=await harness(t);await h.login();const input={tokenId:'ak-testidentifier123',tokenSecret:'as-testsecret1234567'};
 const linked=await h.request('accounts',input);assert.equal(linked.status,201);assert.equal(JSON.stringify(linked.data).includes(input.tokenSecret),false);
 assert.equal((await h.request('accounts',input)).status,409);const state=await h.request('state');assert.equal(JSON.stringify(state.data).includes('credentials'),false);assert.equal(h.engine.store.get('account',linked.data.id).credentials.includes(input.tokenSecret),false);
});
test('selecting account checks readiness but never creates a GPU job',async t=>{const h=await harness(t);await h.login();const a=await primary(h);const selected=await h.request('selection',{accountId:a.id,settings:{gpu:'L40S'}});assert.equal(selected.data.settings.gpu,'RTX-PRO-6000');assert.equal(selected.data.settings.ram,96);assert.equal(selected.data.settings.cpu,4);assert.equal(selected.data.weightsReady,true);assert.equal(h.provider.calls.some(c=>c.action==='generate'),false);});
test('backup requires verified weights and explicit final save, then can be selected without GPU',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const backup=(await h.request('accounts',{tokenId:'ak-backupfixture123',tokenSecret:'as-backupfixture123456'})).data;
 assert.equal(backup.activated,false);
 assert.equal((await quote(h,backup,{action:'start'})).data.error,'ACCOUNT_SETUP_CONFIRMATION_REQUIRED');
 assert.equal((await h.request('accounts/'+backup.id+'/activate',{})).data.error,'WEIGHTS_NOT_READY');
 const call=h.provider.call.bind(h.provider);
 h.provider.call=(action,input,...rest)=>action==='discover'&&input.volume===backup.volume?Promise.resolve({ready:true,files:Object.entries(manifest.files).map(([name,f])=>({name,size:f.size,manifestMatch:true}))}):call(action,input,...rest);
 assert.equal((await h.request('accounts/'+backup.id+'/activate',{})).data.activated,true);
 const chosen=await h.request('selection',{accountId:backup.id,settings:{orientation:'landscape'}});
 assert.equal(chosen.data.accountId,backup.id);assert.equal(chosen.data.settings.orientation,'landscape');
 const plan=await quote(h,backup,{settings:{orientation:'landscape'}});
 assert.equal(plan.data.quality.width,1280);assert.equal(plan.data.quality.height,720);
 assert.equal(h.provider.calls.some(c=>['generate','session','transfer'].includes(c.action)),false);
});
test('account switch is rejected while a different engine holds resources',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 const backup=(await h.request('accounts',{tokenId:'ak-backupfixture123',tokenSecret:'as-backupfixture123456'})).data;
 const q=await h.request('quote',{action:'start',accountId:a.id,settings:{}});
 const started=await h.request('execute',{quoteId:q.data.id,approvedCost:true});await waitJob(h,started.data.id,j=>j?.status==='ready');
 assert.equal((await h.request('selection',{accountId:backup.id,settings:{}})).data.error,'STOP_ACTIVE_ENGINE_BEFORE_SWITCH');
});
test('primary cannot be a transfer destination',async t=>{const h=await harness(t);await h.login();const a=await primary(h);assert.match((await quote(h,a,{action:'prepare'})).data.error,/PRIMARY_STORAGE_IS_READ_ONLY/);});
test('prepare plan is read-only and includes missing bytes and unknown costs',async t=>{const h=await harness(t);await h.login();await primary(h);const backup=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;const q=await quote(h,backup,{action:'prepare'});assert.equal(q.status,200);assert.equal(q.data.plan.files.length,5);assert.ok(q.data.plan.requiredBytes>70e9);assert.equal(q.data.plan.networkCostUSD,null);assert.equal(h.provider.calls.some(c=>c.action==='transfer'),false);});
test('cloud preparation dispatches once, bypasses HostHatch staging and persists final readiness',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const planned=await quote(h,a,{action:'prepare'});assert.equal(planned.data.plan.transport,'modal-cpu-cloud');assert.equal(planned.data.plan.localStagingRequiredBytes,0);assert.equal(planned.data.plan.usesHostDisk,false);
 assert.equal(h.provider.calls.some(c=>c.action==='cloud_transfer_dispatch'),false);
 const input={quoteId:planned.data.id,approvedCost:true};const started=await h.request('execute',input);
 assert.equal(started.status,202);const again=await h.request('execute',input);assert.equal(again.data.id,started.data.id);
 const done=await waitJob(h,started.data.id,j=>j?.status==='completed');assert.equal(done.cloudStopped,true);assert.equal(done.cloudCallId,'fc-fixture');assert.equal(h.engine.store.get('account',a.id).discovery.ready,true);
 assert.equal(h.provider.calls.filter(c=>c.action==='cloud_transfer_dispatch').length,1);
 assert.equal(h.provider.calls.some(c=>['session','generate','transfer'].includes(c.action)),false);
});
test('undeployed cloud worker is explicitly blocked before any job or resource creation',async t=>{
 const h=await harness(t,true,{cloudTransferApp:''});await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const q=await quote(h,a,{action:'prepare'});assert.equal(q.data.plan.blockingReason,'CLOUD_WORKER_NOT_DEPLOYED');assert.equal(q.data.plan.usesHostDisk,false);
 assert.equal((await h.request('execute',{quoteId:q.data.id,approvedCost:true})).data.error,'CLOUD_WORKER_NOT_DEPLOYED');
 assert.equal(h.engine.store.all('job').length,0);assert.equal(h.provider.calls.some(c=>c.action==='cloud_transfer_dispatch'),false);
});
test('small cloud probe gets a distinct low-byte plan and cannot activate model readiness',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const q=await quote(h,a,{action:'prepare',probeOnly:true});assert.equal(q.data.plan.mode,'probe');assert.equal(q.data.plan.requiredBytes,65536);assert.equal(q.data.plan.files.length,0);assert.ok(q.data.estimate.resourceWindowUSD<.011);
 const old=h.provider.call.bind(h.provider);h.provider.call=async(action,...args)=>action==='cloud_transfer_status'?{cloud_stopped:true,events:[],result:{probeVerified:true,ready:false,transferredBytes:65536}}:old(action,...args);
 const sent=await h.request('execute',{quoteId:q.data.id,approvedCost:true});const done=await waitJob(h,sent.data.id,j=>j?.status==='completed');
 assert.equal(done.result.probeVerified,true);const account=h.engine.store.get('account',a.id);assert.equal(account.lastTransferProbe.verified,true);assert.equal(account.activated,false);assert.notEqual(account.discovery?.ready,true);
});
test('credential renewal preserves workspace and Volume and never creates a new account or job',async t=>{
 const h=await harness(t);await h.login();
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const refreshed=await h.request('accounts/'+a.id+'/credentials',{tokenId:'ak-newfixture1234',tokenSecret:'as-newfixturesecret123'});
 assert.equal(refreshed.status,200);assert.equal(refreshed.data.volume,a.volume);assert.equal(refreshed.data.workspace,a.workspace);assert.equal(h.engine.store.all('account').length,1);assert.equal(h.engine.store.all('job').length,0);
 assert.equal(JSON.stringify(refreshed.data).includes('as-newfixture'),false);assert.equal(JSON.stringify(h.engine.store.get('account',a.id)).includes('as-newfixture'),false);
 const original=h.provider.call.bind(h.provider);h.provider.call=(action,...args)=>action==='verify'?Promise.resolve({workspace:'wrong-workspace'}):original(action,...args);
 assert.equal((await h.request('accounts/'+a.id+'/credentials',{tokenId:'ak-newfixture1234',tokenSecret:'as-newfixturesecret123'})).data.error,'ACCOUNT_TOKEN_WORKSPACE_MISMATCH');
});
test('after restart cloud observation resumes an existing call without spawning or transferring again',async t=>{
 const h=await harness(t,true);await h.login();const source=await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 h.engine.store.put('job',{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',action:'prepare',accountId:a.id,sourceId:source.id,createdAt:Date.now(),startedAt:Date.now(),status:'recovery_required',cloudStopped:false,cloudCallId:'fc-existing',events:[],plan:{transport:'modal-cpu-cloud',workerApp:'iff-ltx25-cloud-copy-v1'},estimate:{rate:.00003508,resourceWindowUSD:.14}});
 await h.request('state');const done=await waitJob(h,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',j=>j?.status==='completed');
 assert.equal(done.cloudStopped,true);assert.equal(h.provider.calls.some(c=>c.action==='cloud_transfer_dispatch'),false);assert.equal(h.provider.calls.some(c=>['session','generate','transfer'].includes(c.action)),false);
});
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
test('restart persists metadata and marks live jobs for manual reconciliation',async t=>{const folder=await mkdtemp(path.join(os.tmpdir(),'iff-restart-')),key=randomBytes(32).toString('base64');const s=new Store(folder,key);s.put('job',{id:'prior-id',action:'generate',status:'running',cloudStopped:false,events:[],accountId:'a'});s.close();const api=await createEngineAPI({folder,key,provider:new TestProvider()});assert.equal(api.store.get('job','prior-id').status,'recovery_required');assert.equal(api.store.get('job','prior-id').id,'prior-id');api.close();await rm(folder,{recursive:true,force:true});});
test('multi-account frontend has masked credential fields and preserves allowed GPUs and secure login',async()=>{const page=await readFile('site/engines.html','utf8'),js=await readFile('site/engines.js','utf8'),login=await readFile('site/login.html','utf8');assert.match(page,/dir="rtl"/);assert.equal((page.match(/value="(?:RTX-PRO-6000|L40S)"/g)||[]).length,0);assert.doesNotMatch(page,/H100|A100|HF_TOKEN/);assert.match(page,/Modal Token ID/);assert.match(page,/Modal Token Secret/);assert.match(page,/id="modalTokenSecret" type="password"/);assert.doesNotMatch(page,/<section id="creation" hidden/);assert.doesNotMatch(page,/id="scenePrompt"|id="gpu"|id="ram"|id="cpu"/);assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML/);assert.match(login,/type="password"/);assert.match(page,/id="powerToggle"/);});
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

test('verification-only refuses an empty account without deploying or dispatching',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const q=await quote(h,a,{action:'prepare',verifyOnly:true});assert.equal(q.data.error,'NO_SAVED_WEIGHTS_TO_VERIFY');
 assert.equal(h.provider.calls.some(c=>c.action==='cloud_transfer_dispatch'),false);
});
test('verification-only plans existing weights and preserves inactive account after completion',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const old=h.provider.call.bind(h.provider),[name,spec]=Object.entries(manifest.files)[0];
 h.provider.call=async(action,input,...rest)=>{
  if(action==='discover'&&input.volume===a.volume)return {ready:false,files:[{name,size:spec.size,manifestMatch:true}]};
  if(action==='cloud_transfer_status')return {cloud_stopped:true,result:{verificationOnly:true,ready:false,verifiedFiles:[name],transferredBytes:0}};
  return old(action,input,...rest);
 };
 const q=await quote(h,a,{action:'prepare',verifyOnly:true});assert.equal(q.status,200);assert.equal(q.data.plan.mode,'verify-only');assert.equal(q.data.plan.files.length,0);
 const first=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 const second=await h.request('execute',{quoteId:q.data.id,approvedCost:true});assert.equal(first.data.id,second.data.id);
 const j=await waitJob(h,first.data.id,j=>j?.status==='completed');assert.equal(j.result.verificationOnly,true);
 assert.equal(h.provider.calls.filter(c=>c.action==='cloud_transfer_dispatch').length,1);
 assert.equal(h.engine.store.get('account',a.id).activated,false);assert.equal(h.engine.store.get('account',a.id).discovery.ready,false);
});

test('failed existing-file verification cannot activate an account or bypass corruption gating',async t=>{
 const h=await harness(t,true);await h.login();await primary(h);
 const a=(await h.request('accounts',{tokenId:'ak-backupid123456',tokenSecret:'as-backupsecret12345'})).data;
 const old=h.provider.call.bind(h.provider),[name,spec]=Object.entries(manifest.files)[0];
 h.provider.call=async(action,input,...rest)=>{
  if(action==='discover'&&input.volume===a.volume)return {ready:false,files:[{name,size:spec.size,manifestMatch:true}]};
  if(action==='cloud_transfer_status')return {cloud_stopped:true,result:{verificationOnly:true,requiresNewPlan:true,ready:false,corruptFiles:[name]}};
  return old(action,input,...rest);
 };
 const q=await quote(h,a,{action:'prepare',verifyOnly:true});
 const sent=await h.request('execute',{quoteId:q.data.id,approvedCost:true});
 const done=await waitJob(h,sent.data.id,j=>j?.status==='needs_review');
 assert.equal(done.error,'INTEGRITY_CHANGED_SCOPE_APPROVE_NEW_PLAN');
 assert.deepEqual(h.engine.store.get('account',a.id).corruptFiles,[name]);
 assert.equal(h.engine.store.get('account',a.id).activated,false);
});


test('real project API accepts the serialized report with local approval fields without weakening its allowlist',async t=>{
 const h=await harness(t);await h.login();const scope={window:{}};
 vm.runInNewContext(await readFile('site/film-engine.js','utf8'),scope);
 const project={id:'report-approval-fixture',name:'تقرير',messages:[],assets:[],plan:{verified:true,slots:[]},approved:false,
  parentProjectId:'prior-film',chatStartOffer:{kind:'film-chat-approval',consumedAt:null,engineSubmitted:false}};
 assert.equal((await h.request('projects/save',{snapshot:project})).data.error,'PROJECT_FIELDS_NOT_ALLOWED');
 const snapshot=scope.window.FilmChatStart.serverSnapshot(project);
 assert.equal((await h.request('projects/save',{snapshot})).status,200);
 const record=h.engine.store.get('project',project.id);
 assert.equal(record.snapshot.plan.executionOffer.kind,'film-chat-approval');
 assert.equal(record.snapshot.plan.parentProjectId,'prior-film');
 assert.equal(Object.hasOwn(record.snapshot,'chatStartOffer'),false);
 assert.equal(h.provider.calls.length,0);
});


test('Arabic dialogue is mandatory even without a requested language; invalid or stale scripts cannot dispatch',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h);
 for(const audioContract of [null,{}, {lines:[{speaker:'علي',text:'hello my friend'}]}, {lines:[{speaker:'علي',text:'ا ب ج د'}]}]){
  const invalid=await quote(h,a,{audioContract});assert.equal(invalid.data.error,'ARABIC_DIALOGUE_REQUIRED');
 }
 const good=await quote(h,a);assert.equal(good.status,200);assert.equal(good.data.audioContract.language,'ar');assert.equal(good.data.audioContract.dialect,'iraqi');
 assert.ok(good.data.prompt.includes('«هلا بيك، شلونك اليوم؟»'));assert.equal(good.data.dialogueScriptHash.length,64);
 const saved=await h.engine.store.get('quote',good.data.id);saved.dialoguePolicyVersion='obsolete';await h.engine.store.put('quote',saved);
 assert.equal((await h.request('execute',{quoteId:good.data.id,approvedCost:true})).data.error,'ARABIC_DIALOGUE_REQUIRED');
 assert.equal(h.provider.calls.some(c=>['generate','session','session-generate'].includes(c.action)),false);
});
test('generation receipt and actual provider prompt retain exact Arabic sentences and policy hash',async t=>{
 const h=await harness(t,true);await h.login();const a=await primary(h),q=await quote(h,a);
 const start=await h.request('execute',{quoteId:q.data.id,approvedCost:true});await new Promise(r=>setTimeout(r,20));
 const call=h.provider.calls.find(c=>c.action==='generate');assert.ok(call.input.prompt.includes('«هلا بيك، شلونك اليوم؟»'));
 const receipt=await h.engine.store.get('job',start.data.id);assert.equal(receipt.audioContract.lines[0].text,'هلا بيك، شلونك اليوم؟');assert.equal(receipt.dialogueScriptHash,q.data.dialogueScriptHash);
 h.provider.waiting();
});
