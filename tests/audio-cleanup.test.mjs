import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';
import {Store} from '../engine/store.mjs';import {AudioCleanupQueue,audioCapability,publicCleanup,cleanNativeAudio} from '../engine/audio-cleanup.mjs';
async function fixture(t,runner){const folder=await mkdtemp(path.join(os.tmpdir(),'iff-audio-unit-')),store=new Store(folder,randomBytes(32).toString('base64'));const queue=new AudioCleanupQueue(store,{runner});await queue.initialize();t.after(async()=>{await queue.requests;await queue.done;store.close();await rm(folder,{recursive:true,force:true});});return {store,queue};}
const job=id=>({id,result:{sha256:'a'.repeat(64)}});
test('missing binaries are unavailable without trying installation or a model download',async()=>{assert.equal((await audioCapability({})).ready,false);await assert.rejects(cleanNativeAudio({source:'unused',folder:'unused',sourceSHA256:'x',env:{}}),/UNAVAILABLE/);});
test('duplicate cleanup requests execute one CPU job and never overwrite the original job record',async t=>{
 let runs=0;const f=await fixture(t,async({onPhase})=>{runs++;await onPhase('cpu_denoise');await new Promise(r=>setTimeout(r,12));return {path:'/private/clean.mp4',sha256:'b'.repeat(64),videoBitstreamUnchanged:true};});
 f.store.put('job',{...job('scene-one'),status:'completed'});const [a,b]=await Promise.all([f.queue.request(job('scene-one')),f.queue.request(job('scene-one'))]);assert.equal(a.id,b.id);await f.queue.done;assert.equal(runs,1);assert.equal(f.store.get('job','scene-one').status,'completed');assert.equal(publicCleanup(f.store.get('audio-cleanup',a.id)).result.path,undefined);
 await f.queue.request(job('scene-one'));assert.equal(runs,1);
});
test('CPU tasks are serial and failures do not trigger automatic retries',async t=>{
 let active=0,peak=0,runs=0;const f=await fixture(t,async()=>{active++;peak=Math.max(active,peak);runs++;await new Promise(r=>setTimeout(r,8));active--;throw Error('private diagnostic');});
 const a=await f.queue.request(job('one'));await f.queue.request(job('two'));await f.queue.done;assert.equal(peak,1);assert.equal(runs,2);assert.equal(f.store.get('audio-cleanup',a.id).status,'failed');assert.doesNotMatch(JSON.stringify(f.store.get('audio-cleanup',a.id)),/private diagnostic/);await f.queue.request(job('one'));assert.equal(runs,2);
 await f.queue.request(job('one'),{retry:true});await f.queue.done;assert.equal(runs,3);
});
test('restart requires explicit recovery rather than restarting CPU processing',async t=>{
 const f=await fixture(t,async()=>{throw Error('must not run');});f.store.put('audio-cleanup',{id:'interrupted',status:'running'});await f.queue.initialize();assert.equal(f.store.get('audio-cleanup','interrupted').status,'recovery_required');
});
