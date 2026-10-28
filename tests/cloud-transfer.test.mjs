import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudTransferPlan,observeCloudTransfer} from '../engine/cloud-transfer.mjs';
test('cloud plan needs zero HostHatch staging and gates an undeployed worker',()=>{
 const base={requiredBytes:10,integrityReadBytes:10,localStagingReady:false};
 const pending=cloudTransferPlan(base,{workerReady:false});assert.equal(pending.localStagingRequiredBytes,0);assert.equal(pending.usesHostDisk,false);assert.equal(pending.executionReady,false);
 const ready=cloudTransferPlan(base,{workerReady:true});assert.equal(ready.executionReady,true);assert.equal(ready.compute.cpu,2);assert.equal(ready.compute.ramGiB,4);assert.ok(ready.compute.resourceWindowUSD<.20);assert.equal(ready.networkCostUSD,null);
});
test('monitor resumes metadata only, deduplicates events and requires confirmed termination',async()=>{
 const events=[],calls=[];let step=0;
 const provider={async call(action){calls.push(action);return ++step===1?{cloud_stopped:false,events:[{sequence:1}]}:{cloud_stopped:true,events:[{sequence:1},{sequence:2}],result:{ready:true}};}};
 const result=await observeCloudTransfer({provider,request:{},onEvent:e=>events.push(e),deadline:10,now:()=>step,sleep:async()=>{}});
 assert.equal(result.ready,true);assert.equal(result.cloud_stopped,true);assert.deepEqual(events.map(e=>e.sequence),[1,2]);assert.deepEqual(calls,['cloud_transfer_status','cloud_transfer_status']);
});
test('timeout requests scoped cancel and never claims unknown resources stopped',async()=>{
 const calls=[];const provider={async call(action){calls.push(action);return {cloud_stopped:false};}};
 await assert.rejects(()=>observeCloudTransfer({provider,request:{},onEvent(){},deadline:0,now:()=>1}),/STOP_UNCONFIRMED/);
 assert.deepEqual(calls,['cloud_transfer_stop']);
});


test('destination CPU costs are included and verify-only carries no upload approval',()=>{
 const base={requiredBytes:20,integrityReadBytes:100,files:[{name:'fixture'}]};
 const verify=cloudTransferPlan(base,{workerReady:true},'verify-only');
 assert.equal(verify.requiredBytes,0);assert.equal(verify.files.length,0);assert.equal(verify.compute.destination.calls,1);
 assert.equal(verify.verificationStrategy,'destination-cpu-local');
 const full=cloudTransferPlan(base,{workerReady:true},'full');
 const rate=2*0.0000131+4*0.00000222;
 assert.ok(Math.abs(full.compute.resourceWindowUSD-rate*(3782+2*782))<1e-10);
 assert.ok(Math.abs(verify.compute.resourceWindowUSD-rate*782)<1e-10);
 assert.equal(verify.sourceCpuCalls,0);
 assert.equal(verify.compute.totalWindowSeconds,782);
 assert.equal(full.compute.totalWindowSeconds,3782+2*782);
});
