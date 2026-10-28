import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionChannel} from '../engine/session-channel.mjs';
const payload=id=>({jobId:id,artifactDir:'fixture/'+id,prompt:'شخص يمشي في الصحرا',settings:{seed:42}});
test('each approved scene resolves independently while one channel remains alive',async()=>{
 const writes=[],events=[];const channel=new SessionChannel(s=>writes.push(JSON.parse(s)),e=>events.push(e));
 const first=channel.generate(payload('one'),e=>events.push(e));
 assert.throws(()=>channel.generate(payload('parallel'),()=>{}),/ONE_GENERATION/);
 channel.message({type:'generation_result',data:{job_id:'one',result:{videoVerified:true,cloud_stopped:false}}});
 assert.equal((await first).videoVerified,true);assert.equal(channel.closed,false);
 assert.throws(()=>channel.generate(payload('one'),()=>{}),/SCENE_ALREADY/);
 const second=channel.generate(payload('two'),()=>{});
 channel.message({type:'generation_result',data:{job_id:'two',result:{videoVerified:true}}});
 await second;assert.deepEqual(writes.map(w=>w.jobId),['one','two']);
 channel.close();assert.throws(()=>channel.generate(payload('three'),()=>{}),/EXPIRED/);
});
test('uncertain termination rejects only the pending scene without resubmitting',async()=>{
 const writes=[];const channel=new SessionChannel(s=>writes.push(s),()=>{});
 const pending=channel.generate(payload('one'),()=>{});channel.close();
 await assert.rejects(pending,/STATE_UNKNOWN/);assert.equal(writes.length,1);
});

test('continuation sends only the backend-owned reference path through the private controller pipe',async()=>{
 const writes=[],channel=new SessionChannel(s=>writes.push(JSON.parse(s)),()=>{});
 const request={...payload('next'),previousFrame:'/private/artifacts/previous/last-frame.png'};
 const pending=channel.generate(request,()=>{});
 assert.equal(writes[0].previousFrame,request.previousFrame);assert.equal(writes[0].jobId,'next');
 channel.message({type:'generation_result',data:{job_id:'next',result:{videoVerified:true}}});await pending;
});
