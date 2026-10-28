import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../engine/store.mjs';
import {OpenAIDirector,TEXT_MODEL} from '../engine/openai-director.mjs';
const fixtureKey='sk-fixture-only-not-a-real-key-123456789';
async function harness(t,reply=()=>({reply:'أقترح خمس دقايق، توافق؟',proposed_duration_seconds:300,style:'realistic',ready_to_write:true,missing:[],portrait_prompt:null})){
 const folder=await mkdtemp(path.join(os.tmpdir(),'iff-openai-test-')),store=new Store(folder,randomBytes(32).toString('base64')),calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('/models/'))return new Response('{}');return Response.json({status:'completed',usage:{input_tokens:1000,output_tokens:2000},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(reply())}]}]});};
 const service=new OpenAIDirector(store,{fetcher});await service.initialize();t.after(async()=>{await Promise.allSettled([...service.pending]);store.close();await rm(folder,{recursive:true,force:true});});return {service,store,calls,folder};
}
const request=(id='one',extra={})=>({requestId:id,projectId:'film-300s',mode:'discuss',messages:[{role:'user',content:'نريد قصة عراقية واقعية خمس دقايق'}],approvedTextCost:true,...extra});
test('server stores encrypted key, status survives reload and empty save preserves key without echo',async t=>{
 const h=await harness(t);assert.equal((await h.service.config()).configured,false);assert.equal(h.calls.length,0);
 await h.service.save({key:fixtureKey});assert.equal(h.calls.length,1);const c=await h.service.config();assert.equal(c.configured,true);assert.equal(c.model,TEXT_MODEL);assert.equal(JSON.stringify(c).includes(fixtureKey),false);
 const raw=JSON.stringify(h.store.get('config','openai-director'));assert.equal(raw.includes(fixtureKey),false);
 await h.service.save({key:'',monthlyLimitUSD:3});assert.equal(h.calls.length,1);assert.equal(h.store.open(h.store.get('config','openai-director').credentials,'openai-director').key,fixtureKey);
 const reloaded=new OpenAIDirector(h.store,{fetcher:async()=>{throw Error('must not call');}});assert.equal((await reloaded.config()).configured,true);
 await reloaded.remove();assert.equal((await reloaded.config()).configured,false);
});
test('text-only calls require approval, deduplicate ids, retain usage and require previous duration proposal',async t=>{
 const h=await harness(t);await h.service.save({key:fixtureKey});await assert.rejects(()=>h.service.submit(request('no',{approvedTextCost:false})),/TEXT_COST_APPROVAL/);
 await h.service.submit(request());await Promise.all([...h.service.pending]);const first=await h.service.get('one');assert.equal(first.status,'completed');assert.equal(first.discussion.proposed_duration_seconds,300);assert.equal(first.discussion.ready_to_write,false);assert.equal(first.usage.computedUSD,.0011);assert.equal(first.invoiceUSD,null);
 await h.service.submit(request());assert.equal(h.calls.filter(c=>c.url.endsWith('/responses')).length,1);
 await assert.rejects(()=>h.service.submit(request('one',{messages:[{role:'user',content:'changed'}]})),/TEXT_REQUEST_ID_CONFLICT/);
 await h.service.submit(request('two',{messages:[{role:'user',content:'تمام ابدأ كتابة الخطة فقط'}]}));await Promise.all([...h.service.pending]);assert.equal((await h.service.get('two')).discussion.ready_to_write,true);
 for(const call of h.calls.filter(c=>c.url.endsWith('/responses'))){const body=JSON.parse(call.options.body);assert.equal(body.model,TEXT_MODEL);assert.equal(body.store,false);assert.equal(body.reasoning.effort,'none');assert.equal(body.tools,undefined);assert.equal(body.text.format.type,'json_schema');assert.equal(body.instructions.includes('license'),true);}
});
test('unlimited monthly text retains approval, failure and restart protection without automatic retry',async t=>{
 const h=await harness(t);await h.service.save({key:fixtureKey,monthlyLimitUSD:.01});
 h.store.put('text-call',{id:'prior',createdAt:Date.now(),estimatedMaxUSD:.01,status:'uncertain'});
 assert.equal((await h.service.config()).monthlyLimitUSD,null);assert.equal(h.calls.length,1);
 await h.service.save({key:'',monthlyLimitUSD:2});h.service.fetcher=async()=>{throw Error('network failure with confidential detail');};await h.service.submit(request());await Promise.all([...h.service.pending]);const result=await h.service.get('one');assert.equal(result.status,'uncertain');assert.equal(JSON.stringify(result).includes('confidential'),false);
 await h.service.submit(request());assert.equal((await h.service.get('one')).status,'uncertain');
 h.store.put('text-call',{id:'restart',status:'running'});await h.service.initialize();assert.equal(h.store.get('text-call','restart').status,'uncertain');
});
test('UI keeps key server-side and graph covers come only from completed video data',async()=>{
 const ui=await readFile(new URL('../site/app-settings.js',import.meta.url),'utf8'),graph=await readFile(new URL('../site/production-network.tsx',import.meta.url),'utf8');
 assert.equal(/localStorage\.setItem/.test(ui),false);assert.match(ui,/placeholder=c.configured/);assert.match(ui,/input.value=''/);assert.equal(ui.includes('api.openai.com'),false);
 assert.match(graph,/status!=='done'/);assert.match(graph,/drawImage\(video/);assert.equal(graph.includes('Math.random'),false);
});
test('details explicitly requests JSON in input and provider failure retains only safe diagnostics',async t=>{
 const h=await harness(t);await h.service.save({key:fixtureKey});
 h.service.fetcher=async(_url,options)=>{const p=JSON.parse(options.body);assert.match(p.input.map(m=>m.content).join(' '),/JSON/);return Response.json({error:{code:'invalid_request_error',param:'input',message:'confidential provider response '+fixtureKey}},{status:400});};
 await h.service.submit(request('details',{mode:'details',messages:[{role:'user',content:'{"assigned_only":[]}'}]}));await Promise.all([...h.service.pending]);const r=await h.service.get('details');assert.equal(r.status,'failed');assert.deepEqual(r.failureDetails,{httpStatus:400,code:'invalid_request_error',param:'input'});assert.ok(!JSON.stringify(r).includes(fixtureKey));
});
