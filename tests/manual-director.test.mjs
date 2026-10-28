import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

for(const manual of [true,false])test('film director presents '+(manual?'unknown manual':'bounded legacy')+' cost without dispatch before consent',async()=>{
 const requests=[],prompts=[];
 const api={session:async()=>{},async request(route){
  requests.push(route);
  if(route==='state')return {selection:{accountId:'fixture',settings:{gpu:'RTX-PRO-6000'}},jobs:[{id:'warm',accountId:'fixture',action:'start',status:'ready',cloudStopped:false,settings:{gpu:'RTX-PRO-6000'}}]};
  if(route==='quote')return {paidEnabled:true,estimate:{resourceWindowUSD:manual?null:.12,rate:.001}};
  throw Error('No dispatch or cloud request allowed in this test');
 }};
 const scope={window:{EngineAPI:api},confirm:message=>{prompts.push(message);return false;}};
 vm.runInNewContext(fs.readFileSync('site/modal-director.js','utf8'),scope);
 const project={id:'fixture',name:'fixture',assets:[],plan:{slots:[{index:1,start:0,end:10,status:'pending',prompt:'fixture scene'}]}};
 await scope.window.ModalDirector.run(project,{stopping:()=>false,save(){},merge(){throw Error('No merge expected');}});
 assert.equal(prompts.length,1);assert.doesNotMatch(prompts[0],/NaN|undefined/);
 assert.match(prompts[0],manual?/غير معروفة/:/0\.1200/);
 assert.deepEqual(requests,['state','state','quote']);
});
