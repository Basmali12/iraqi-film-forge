import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('approval button unlocks after busy clears on failure or cancellation, and stays disabled for finished film',()=>{
 const source=fs.readFileSync('site/director.js','utf8'),start=source.indexOf('function renderProgress(){'),end=source.indexOf('async function runProduction',start);
 const nodes=new Map(),project={plan:{slots:[{status:'pending'}]}};
 const scope={selected:()=>project,working:true,pIsArchive:p=>Boolean(p.videoProvider&&p.videoProvider!=='modal'),window:{ProductionNetwork:{render(){}}},getData(){},$:id=>{if(!nodes.has(id))nodes.set(id,{style:{}});return nodes.get(id);}};
 vm.runInNewContext(source.slice(start,end),scope);scope.renderProgress();assert.equal(nodes.get('approvePlan').disabled,true);
 scope.working=false;scope.renderProgress();assert.equal(nodes.get('approvePlan').disabled,false);assert.equal(nodes.get('startProduction').disabled,false);
 project.videoProvider='retired';scope.renderProgress();assert.equal(nodes.get('approvePlan').disabled,true);project.videoProvider='modal';
 project.plan.slots[0].status='done';scope.renderProgress();assert.equal(nodes.get('approvePlan').disabled,true);assert.equal(nodes.get('startProduction').disabled,true);
});
test('completed text planning unlocks generation without reissuing a text request',async()=>{
 const source=fs.readFileSync('site/director.js','utf8'),nodes=new Map(),project={id:'fixture',videoProvider:'modal',messages:[{role:'user',content:'قصة مضحكة ثلاثين ثانية'}],assets:[],plan:null};
 const start=source.indexOf('async function draftPlan('),end=source.indexOf('$("draftReport").onclick=',start),progressStart=source.indexOf('function renderProgress(){'),progressEnd=source.indexOf('async function runProduction',progressStart);
 let outlines=0;const scope={working:false,selected:()=>project,pIsArchive:()=>false,window:{ProductionNetwork:{render(){}}},document:{getElementById:()=>({value:'9:16'})},getData(){},persist(){},state(){},err:e=>e.message,prepareBeats:async()=>{outlines++;return {title:'fixture',duration_seconds:30,beats:[{}]};},slotPlan:()=>[1,2,3].map(index=>({index,status:'pending'})),detailSlots:async()=>{},$:id=>{if(!nodes.has(id))nodes.set(id,{style:{},scrollIntoView(){}});return nodes.get(id);}};
 scope.render=()=>scope.renderProgress();vm.runInNewContext(source.slice(progressStart,progressEnd)+source.slice(start,end),scope);await scope.draftPlan(true);assert.equal(scope.working,false);assert.equal(nodes.get('approvePlan').disabled,false);assert.equal(outlines,1);assert.equal(project.plan.slots.length,3);
});
