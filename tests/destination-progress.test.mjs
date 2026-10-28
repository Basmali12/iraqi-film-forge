import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const scope={window:{}};vm.runInNewContext(fs.readFileSync('site/primary-engine-model.js','utf8'),scope);
const model=scope.window.PrimaryEngineModel;
test('integrity byte counters cannot be mistaken for denoising or upload progress',()=>{
 const job={action:'prepare',status:'running',events:[{kind:'progress',phase:'integrity',file:'fixture',completed:8,total:16,global_completed:8,global_total:16,rate:4,time:2}]};
 assert.equal(model.progress(job).denoiseTotal,null);assert.equal(model.byteProgress(job).completed,8);
 job.events.push({kind:'phase_start',phase:'upload',file:'fixture'});assert.equal(model.byteProgress(job),null);
});
test('missing rate is unknown; actual timed byte samples may establish a rate',()=>{
 const job={action:'prepare',events:[{kind:'progress',phase:'transfer',file:'fixture',transferred:4,required:20,time:1}]};
 assert.equal(model.byteProgress(job).rate,null);
 job.events.push({kind:'progress',phase:'transfer',file:'fixture',transferred:8,required:20,time:3});
 assert.equal(model.byteProgress(job).rate,2);
});
test('confirmed user cancellation is stopped rather than a fabricated generation failure',()=>{
 const progress=model.progress({action:'prepare',status:'stopped',cloudStopped:true,stopRequestedAt:1,error:'TRANSFER_CANCELLED',events:[{kind:'phase_error',phase:'cloud_transfer',error_type:'TRANSFER_CANCELLED'}]});
 assert.equal(progress.cancelled,true);assert.equal(progress.error,null);assert.match(progress.label,/إيقاف/);
});
test('verification-only completion never claims complete model readiness',()=>{
 const p=model.progress({action:'prepare',status:'completed',result:{verificationOnly:true,ready:false},events:[]});
 assert.equal(p.finishedType,'verification');assert.match(p.label,/لم يبدأ نقل/);
});

test('every remaining engine control exists after moving creation to film workbench',()=>{
 const page=fs.readFileSync('site/engines.html','utf8'),js=fs.readFileSync('site/engines.js','utf8');
 const ids=new Set([...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
 for(const match of js.matchAll(/\bel\('([^']+)'\)/g))assert.ok(ids.has(match[1]),'Missing DOM control: '+match[1]);
 assert.ok(ids.has('powerToggle'));assert.equal(ids.has('scenePrompt'),false);assert.equal(ids.has('gpu'),false);
});

test('manual engine page removes the three numeric limit controls without breaking handlers',()=>{
 const page=fs.readFileSync('site/engines.html','utf8'),js=fs.readFileSync('site/engines.js','utf8');
 for(const name of ['timeout','startup','budget']){
  assert.doesNotMatch(page,new RegExp('id="'+name+'"'));
  assert.doesNotMatch(js,new RegExp("el\\('"+name+"'\\)"));
 }
 assert.match(js,/timeout:0,startup:0/);assert.match(js,/budget:0/);
 assert.match(page,/الإيقاف/);
});
