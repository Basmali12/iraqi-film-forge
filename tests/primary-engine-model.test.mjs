import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const scope={window:{}};vm.runInNewContext(fs.readFileSync('site/primary-engine-model.js','utf8'),scope);const {derive,stages}=scope.window.PrimaryEngineModel;
const account={id:'primary',workspace:'basm1998ali',role:'primary',discovery:{ready:true}};
const snapshot=jobs=>({accounts:[account,{id:'backup',workspace:'other',role:'backup'}],jobs});
const job=(more={})=>({id:'job',action:'start',accountId:'primary',status:'running',cloudStopped:false,createdAt:1,events:[],...more});
test('fixed primary does not claim readiness from weights or elapsed time',()=>{
 assert.equal(derive(snapshot([])).state,'off');assert.equal(derive(snapshot([job()]),1e12).canGenerate,false);
 assert.equal(derive(snapshot([job({status:'ready',readyUntil:200})]),100).canGenerate,true);
 assert.equal(derive(snapshot([job({status:'ready',readyUntil:50})]),100).canGenerate,false);
 assert.equal(stages(job())[0].status,'pending');
});
test('only confirmed stopped resources return the main button to start',()=>{
 for(const status of ['uncertain','failed','stopped','completed','recovery_required'])assert.notEqual(derive(snapshot([job({status})])).action,'start');
 assert.equal(derive(snapshot([job({status:'stopped',cloudStopped:true})])).action,'start');
 assert.equal(derive(snapshot([job({status:'stopping'})])).state,'stopping');
});
test('stage animation and checkmarks follow received events only',()=>{
 const actual=stages(job({events:[{kind:'app_created',phase:'application_setup'},{kind:'phase_start',phase:'transformer_build'}]}));
 assert.equal(actual[0].status,'done');assert.equal(actual.find(s=>s.key==='transformer_build').status,'current');assert.equal(actual.at(-1).status,'pending');
});
test('completed scene on a live session leaves generation enabled',()=>{
 const parent=job({status:'ready',readyUntil:2000});
 const scene=job({id:'scene',createdAt:2,action:'generate',attachedEngineId:'job',status:'completed',result:{videoVerified:true}});
 const view=derive(snapshot([parent,scene]),1000);
 assert.equal(view.state,'ready');assert.equal(view.canGenerate,true);assert.equal(view.active.id,'job');
});
test('finished video is tracked independently of the idle paid GPU session',()=>{
 const parent=job({status:'ready',readyUntil:2000});
 const scene=job({id:'scene',createdAt:2,action:'generate',attachedEngineId:'job',status:'completed',result:{videoVerified:true}});
 const view=derive(snapshot([parent,scene]),1000),{trackedJob,progress}=scope.window.PrimaryEngineModel;
 assert.equal(trackedJob(view).id,'scene');assert.equal(progress(trackedJob(view)).finished,true);
 assert.equal(progress(parent).idle,true);assert.match(progress(parent).label,/لا توجد عملية توليد/);
});
test('numeric denoising progress follows counters and never advances from time',()=>{
 const {progress}=scope.window.PrimaryEngineModel;
 const live=job({action:'generate',events:[{kind:'progress',phase:'denoise_stage_1',completed:2,total:8,global_completed:2,global_total:11}]});
 assert.equal(progress(live).percent,18);assert.equal(progress(live).percent,18);
 live.events.push({kind:'progress',phase:'denoise_stage_2',completed:1,total:3,global_completed:9,global_total:11});
 assert.equal(progress(live).percent,81);
 live.events.push({kind:'phase_start',phase:'video_decode'});assert.equal(progress(live).percent,81);
 assert.equal(progress(job()).percent,null);
});
test('selection controls account, jobs and setup actions without borrowing primary readiness',()=>{
 const secondary={id:'secondary',workspace:'other',role:'backup',activated:false,discovery:{ready:false}};
 const state={accounts:[account,secondary],selection:{accountId:'secondary'},jobs:[job({status:'ready'})]};
 const view=derive(state);assert.equal(view.account.id,'secondary');assert.equal(view.canGenerate,false);assert.equal(view.action,'prepare');
 secondary.discovery.ready=true;assert.equal(derive(state).action,'activate');
 secondary.activated=true;assert.equal(derive(state).action,'start');
});
test('a stopped uncertain preparation displays the failure rather than generic off text',()=>{
 const view=derive(snapshot([job({status:'uncertain',cloudStopped:true,error:'OPERATION_STATE_UNCERTAIN_DO_NOT_RESUBMIT'})]));
 assert.equal(view.action,'start');assert.match(view.title,/خطأ/);assert.equal(view.canGenerate,false);
});
test('progress uses real stage counters and stays indeterminate without them',()=>{
 const {progress}=scope.window.PrimaryEngineModel;
 assert.equal(progress(job()).completed,null);
 const running=progress(job({action:'generate',events:[{kind:'phase_start',phase:'denoise_stage_1'},{kind:'progress',phase:'denoise_stage_1',completed:3,total:8}]}));
 assert.equal(running.completed,3);assert.equal(running.steps,8);assert.match(running.label,/الأولى/);
 assert.equal(progress(job({events:[{kind:'progress',completed:12,total:8}]})).completed,null);
 const ended=progress(job({action:'generate',events:[{kind:'phase_end',phase:'denoise_stage_1'}]}));assert.equal(ended.done,1);assert.equal(ended.completed,null);
});
test('user-facing error descriptions are Arabic and never forward unknown raw errors',()=>{
 const {explainError,progress}=scope.window.PrimaryEngineModel;
 assert.match(explainError('PROMPT_REQUIRED'),/الوصف القصير مقبول/);
 assert.match(explainError('ENGINE_SESSION_EXPIRED_NO_NEW_GPU'),/انتهت جلسة/);
 assert.equal(explainError('raw-token-or-traceback'),explainError('unknown'));
 assert.match(progress(job({events:[{kind:'phase_error',phase:'gpu_operation',error_type:'OutOfMemoryError'}]})).error,/ذاكرة/);
});
