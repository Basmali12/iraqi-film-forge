// Offline protocol fixtures only: no real video, credentials, GPU or cloud call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(count=3){
 const project={id:'film-fixture',name:'fixture',ratio:'16:9',assets:[],plan:{slots:Array.from({length:count},(_,i)=>({index:i+1,start:i*10,end:(i+1)*10,prompt:'unique action '+i,status:'pending',jobId:null}))}};
 const requests=[],stored=[],snapshots=[];let quotes=0,merged=0,fail=false,warm=true,consent=true,confirmations=0;
 const api={session:async()=>{},videoURL:id=>'https://fixture.invalid/'+id,async request(route,body){
  requests.push({route,body});
  if(route==='state')return {selection:{accountId:'account-fixture'},jobs:warm?[{id:'warm-fixture',accountId:'account-fixture',action:'start',status:'ready',cloudStopped:false,settings:{gpu:'RTX-PRO-6000',orientation:'portrait'}}]:[]};
  if(route==='quote')return {id:'quote-'+(++quotes),paidEnabled:true,estimate:{rate:.001,resourceWindowUSD:null}};
  if(route==='execute'){
   assert.equal(snapshots.at(-1).filter(s=>s.status==='ambiguous').length,1,'durable reservation must precede submit');
   if(fail)throw Error('ambiguous acknowledgement fixture');
   return {id:'job-'+quotes};
  }
  if(route.startsWith('jobs/'))return {id:route.slice(5),events:[],status:'completed',accountId:'account-fixture',settings:{gpu:'RTX-PRO-6000'},result:{videoVerified:true,continuity:{conditioning:{fixture:true}}}};
  throw Error('Unexpected fixture request '+route);
 }};
 const scope={window:{EngineAPI:api},confirm:()=>{confirmations++;return consent;},fetch:async()=>({ok:true,blob:async()=>new Blob(['synthetic offline fixture'])})};
 vm.runInNewContext(fs.readFileSync('site/modal-director.js','utf8'),scope);
 const io={stopping:()=>false,maxSceneIndex:3,save:async()=>snapshots.push(project.plan.slots.map(s=>({...s}))),clip:async(key,b)=>stored.push({key,size:b.size}),log(){},merge:async()=>merged++};
 return {project,requests,stored,io,api,set consent(v){consent=v;},get confirmations(){return confirmations;},run:()=>scope.window.ModalDirector.run(project,io),get merged(){return merged;},set fail(v){fail=v;},set warm(v){warm=v;}};
}
test('three sequential scenes carry previousSceneId and one explicit engine ID; original clips saved before merge',async()=>{
 const f=fixture();await f.run();const q=f.requests.filter(r=>r.route==='quote').map(r=>r.body);
 assert.deepEqual(q.map(r=>r.previousSceneId),[undefined,'scene-1','scene-2']);
 assert.ok(q.every(r=>r.engineJobId==='warm-fixture'&&r.settings.orientation==='landscape'));
 assert.equal(f.stored.length,3);assert.equal(f.merged,1);assert.ok(f.project.plan.slots.every(s=>s.status==='done'));
 const before=f.requests.filter(r=>r.route==='execute').length;await f.run();assert.equal(f.requests.filter(r=>r.route==='execute').length,before);
});
test('first three scene gate stops an eighteen-scene movie until explicit quality review',async()=>{
 const f=fixture(18);await f.run();assert.equal(f.stored.length,3);assert.equal(f.merged,0);
 await f.run();assert.equal(f.stored.length,3);
 f.io.maxSceneIndex=60;f.io.maxScenes=60;await f.run();assert.equal(f.stored.length,18);assert.equal(f.merged,1);
});
test('lost acknowledgement never automatically creates another paid job',async()=>{
 const f=fixture();f.fail=true;await assert.rejects(f.run(),/ambiguous/);assert.equal(f.project.plan.slots[0].status,'ambiguous');
 await assert.rejects(f.run(),/غير مؤكدة/);assert.equal(f.requests.filter(r=>r.route==='execute').length,1);
});
test('missing prepared engine cannot silently allocate one',async()=>{
 const f=fixture();f.warm=false;await assert.rejects(f.run(),/شغّل المحرك/);
 assert.equal(f.requests.filter(r=>r.route==='quote'||r.route==='execute').length,0);
});

function failedFixture(){
 const f=fixture(),original=f.api.request.bind(f.api);f.project.plan.slots[0].jobId='old-failed';f.project.plan.slots[0].status='submitted';
 f.api.request=async(route,body)=>{
  if(route==='projects/film-fixture/scenes')return [{sceneId:'scene-1',jobId:'old-failed'}];
  if(route==='jobs/old-failed')return {id:'old-failed',status:'failed',cloudStopped:true,events:[]};
  return original(route,body);
 };return f;
}
test('failed polling persists the true state and exposes retry without auto execution',async()=>{
 const f=failedFixture();await assert.rejects(f.run(),/فشل وتأكد/);assert.equal(f.project.plan.slots[0].status,'failed');assert.equal(f.project.plan.slots[0].retryable,true);assert.equal(f.requests.some(r=>r.route==='execute'),false);
});
test('explicit retry quotes old job, submits once and stops after only that scene',async()=>{
 const f=failedFixture();f.io.retryScene=1;f.io.maxScenes=1;await f.run();
 const q=f.requests.find(r=>r.route==='quote');assert.equal(q.body.retryOfJobId,'old-failed');assert.equal(q.body.engineJobId,'warm-fixture');
 assert.equal(f.requests.filter(r=>r.route==='execute').length,1);assert.equal(f.project.plan.slots[0].status,'done');assert.equal(f.stored.length,1);assert.equal(f.project.plan.slots[1].status,'pending');
});
test('sync repairs stale submitted label but never clears ambiguous acknowledgement',async()=>{
 const f=failedFixture(),scope={window:{EngineAPI:f.api}};vm.runInNewContext(fs.readFileSync('site/modal-director.js','utf8'),scope);
 await scope.window.ModalDirector.sync(f.project,f.io);assert.equal(f.project.plan.slots[0].status,'failed');
 f.project.plan.slots[0].status='ambiguous';await scope.window.ModalDirector.sync(f.project,f.io);assert.equal(f.project.plan.slots[0].status,'ambiguous');
});
test('cancelling retry preserves original job and sends no execute',async()=>{
 const f=failedFixture();f.io.retryScene=1;f.consent=false;await f.run();assert.equal(f.project.plan.slots[0].jobId,'old-failed');assert.equal(f.requests.some(r=>r.route==='execute'),false);
});
test('uncertain retry acknowledgement cannot be sent twice',async()=>{
 const f=failedFixture();f.io.retryScene=1;f.fail=true;await assert.rejects(f.run(),/ambiguous/);await assert.rejects(f.run(),/غير مؤكد/);assert.equal(f.requests.filter(r=>r.route==='execute').length,1);
});

function automaticFilm(count=6){const f=fixture(count);f.io.approvalMode='film';f.io.maxScenes=60;f.io.maxSceneIndex=60;return f;}
test('whole-film approval runs eighteen ordered scenes with exactly one consent then merges',async()=>{
 const f=automaticFilm(18);await f.run();assert.equal(f.confirmations,1);assert.equal(f.stored.length,18);assert.equal(f.merged,1);assert.equal(f.requests.filter(r=>r.route==='execute').length,18);
 assert.ok(f.requests.filter(r=>r.route==='quote').slice(1).every(r=>r.body.previousSceneId));
});
test('existing completed scenes are skipped and remaining movie gets one approval',async()=>{
 const f=automaticFilm();f.project.plan.slots.slice(0,3).forEach(s=>s.status='done');await f.run();assert.equal(f.confirmations,1);assert.equal(f.stored.length,3);assert.equal(f.requests.find(r=>r.route==='quote').body.sceneId,'scene-4');assert.equal(f.merged,1);
});
test('cancelling whole-film consent dispatches no scenes',async()=>{
 const f=automaticFilm();f.consent=false;await f.run();assert.equal(f.confirmations,1);assert.equal(f.requests.some(r=>r.route==='execute'),false);
});
test('account session or resource changes cannot reuse prior movie consent',async()=>{
 const f=automaticFilm(),original=f.api.request.bind(f.api);let states=0;
 f.api.request=async(route,body)=>{const r=await original(route,body);if(route==='state'&&++states>2)r.jobs[0].id='different-engine';return r;};
 await assert.rejects(f.run(),/تغير الحساب أو الجلسة/);assert.equal(f.requests.filter(r=>r.route==='execute').length,1);assert.equal(f.confirmations,1);
});
test('whole-film pause after a completed scene stops further dispatch',async()=>{
 const f=automaticFilm();f.io.stopping=()=>f.stored.length>=1;await f.run();assert.equal(f.stored.length,1);assert.equal(f.requests.filter(r=>r.route==='execute').length,1);assert.equal(f.merged,0);
});
test('full-film page removes the review gate and passes automatic scheduling limits',()=>{
 const html=fs.readFileSync('site/film.html','utf8'),js=fs.readFileSync('site/director.js','utf8');assert.doesNotMatch(html,/filmModalReview/);assert.doesNotMatch(js,/continuityReviewed|filmModalReview/);assert.match(js,/approvalMode:'film'/);assert.match(js,/maxScenes:modalProject.plan.slots.length,maxSceneIndex:modalProject.plan.slots.length/);
});
