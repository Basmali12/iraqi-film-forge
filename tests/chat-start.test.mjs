// Offline controller tests only. No credentials, Modal SDK, GPU or text API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture({cold=false,lost=false}={}){
 const settings={gpu:'RTX-PRO-6000',ram:96,cpu:4,seed:42,orientation:'portrait'};
 const state={selection:{accountId:'account',settings},accounts:[{id:'account',workspace:'fixture-account'}],jobs:cold?[]:[{id:'existing',accountId:'account',action:'start',status:'ready',settings,cloudStopped:false}]};
 const project={id:'fixture',name:'fixture',videoProvider:'modal',assets:[],messages:[],plan:{videoProvider:'modal',verified:true,seconds:30,quality:'720p',ratio:'9:16',slots:[1,2,3].map(index=>({index,start:(index-1)*10,end:index*10,prompt:'Distinct chronological action '+index,audioContract:{lines:[{speaker:'علي، الشاب بالجاكيت البني',text:'هلا بيك، شلونك اليوم؟'}]},status:'pending',jobId:null}))}};
 const calls=[];let clock=1000,sequence=0,confirmations=0,merges=0,dispatches=0;
 const api={session:async()=>{},videoURL:id=>'https://fixture.invalid/'+id,async request(route,body){
  calls.push({route,body});
  if(route==='state')return structuredClone(state);
  if(route==='quote')return {id:body.action+'-'+(++sequence),accountId:body.accountId,settings:body.settings,quality:{contract:'fixture-quality'},paidEnabled:true,estimate:{rate:.001},expiresAt:clock+300000};
  if(route==='execute'){
   if(lost)throw Error('lost acknowledgement');
   if(body.quoteId.startsWith('start-')){state.jobs=[{id:'created',accountId:'account',action:'start',status:'ready',settings,cloudStopped:false}];return {id:'created'};}
   dispatches++;return {id:'scene-'+dispatches};
  }
  if(route.startsWith('jobs/'))return {events:[],status:'completed',settings,accountId:'account',result:{videoVerified:true}};
  throw Error('Unexpected fixture route '+route);
 }};
 const scope={window:{EngineAPI:api},confirm:()=>{confirmations++;return true;},fetch:async()=>({ok:true,blob:async()=>new Blob(['offline fixture'])})};
 vm.runInNewContext(fs.readFileSync('site/arabic-dialogue.js','utf8'),scope);
 vm.runInNewContext(fs.readFileSync('site/film-engine.js','utf8'),scope);
 vm.runInNewContext(fs.readFileSync('site/modal-director.js','utf8'),scope);
 const controller=scope.window.FilmChatStart.create(api,{now:()=>clock,sleep:async ms=>{clock+=ms;},creative:()=>undefined});
 scope.window.FilmChatStart=controller;
 const io={approvalMode:'film',maxScenes:3,maxSceneIndex:3,stopping:()=>false,save:async()=>{},clip:async()=>{},log(){},merge:async()=>merges++};
 return {project,state,api,calls,controller,io,scope,get confirmations(){return confirmations;},get merges(){return merges;},advance:ms=>clock+=ms};
}

test('loading and showing the production report only reads state and quotes',async()=>{
 const f=fixture({cold:true});assert.equal(f.calls.length,0);
 const offer=await f.controller.prepare(f.project);
 assert.equal(f.calls.filter(c=>c.route==='execute').length,0);
 assert.equal(f.calls.filter(c=>c.route==='quote').length,2);
 assert.match(f.controller.describe(offer),/موافق وابدأ/);
 assert.match(f.controller.describe(offer),/ليس سقف فاتورة/);
 assert.match(f.controller.describe(offer),/0.0600/);
});

test('start commands are exact and negations or writing-only requests are not paid approval',()=>{
 const f=fixture();
 for(const text of ['ابدأ','تمام ابدأ','نفّذ الخطة','ابدا التوليد'])assert.equal(f.controller.isCommand(text),true,text);
 for(const text of ['لا تبدأ','مو هسه','اكتب الخطة فقط','شنو يصير اذا اكلك ابدأ','تمام','ابدأ كتابة القصة فقط'])assert.equal(f.controller.isCommand(text),false,text);
});

test('one report approval starts exactly one cold engine then all scenes without another confirmation',async()=>{
 const f=fixture({cold:true}),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);
 assert.throws(()=>f.controller.accept(f.project,o),/سُجل/);
 await Promise.allSettled([f.controller.ensure(f.project,o,f.io),f.controller.ensure(f.project,o,f.io)]);
 assert.equal(f.calls.filter(c=>c.route==='execute'&&c.body.quoteId.startsWith('start-')).length,1);
 f.io.chatApproval=o;await f.scope.window.ModalDirector.run(f.project,f.io);
 assert.equal(f.calls.filter(c=>c.route==='execute'&&c.body.quoteId.startsWith('generate-')).length,3);
 assert.equal(f.confirmations,0);assert.equal(f.merges,1);
 assert.ok(f.project.plan.slots.every(s=>s.status==='done'));
 await f.scope.window.ModalDirector.run(f.project,f.io);
 assert.equal(f.calls.filter(c=>c.route==='execute').length,4,'completed clips must not be generated twice');
});

test('an existing engine is reused with no start execution',async()=>{
 const f=fixture(),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);
 await f.controller.ensure(f.project,o,f.io);assert.equal(o.engineJobId,'existing');
 assert.equal(f.calls.some(c=>c.route==='execute'),false);
});

test('lost engine acknowledgement reserves submission before request and never retries',async()=>{
 const f=fixture({cold:true,lost:true}),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);
 let reserved=false;f.io.save=async()=>{reserved=o.engineSubmitted;};
 await assert.rejects(f.controller.ensure(f.project,o,f.io),/lost/);assert.equal(reserved,true);
 await assert.rejects(f.controller.ensure(f.project,o,f.io),/محركاً ثانياً/);
 assert.equal(f.calls.filter(c=>c.route==='execute').length,1);
});

test('expired report and changed prompt cannot authorize any paid execution',async()=>{
 for(const mutation of ['expire','prompt']){
  const f=fixture(),o=await f.controller.prepare(f.project);
  if(mutation==='expire')f.advance(300001);else f.project.plan.slots[0].prompt+=' changed';
  assert.throws(()=>f.controller.accept(f.project,o),/تغيرت الخطة|انتهت/);
  assert.equal(f.calls.some(c=>c.route==='execute'),false);
 }
});

test('changed account or engine session stops without fallback',async()=>{
 for(const mutation of ['account','engine']){
  const f=fixture(),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);
  if(mutation==='account')f.state.selection.accountId='another';else f.state.jobs[0].id='replacement';
  await assert.rejects(f.controller.ensure(f.project,o,f.io),/تغير/);
  assert.equal(f.calls.some(c=>c.route==='execute'),false);
 }
});

test('changed rate before scene dispatch stops the film without a second approval or generation',async()=>{
 const f=fixture(),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);await f.controller.ensure(f.project,o,f.io);
 const original=f.api.request.bind(f.api);f.api.request=async(route,body)=>{const r=await original(route,body);if(route==='quote')r.estimate.rate=.002;return r;};
 f.io.chatApproval=o;await assert.rejects(f.scope.window.ModalDirector.run(f.project,f.io),/التعرفة/);
 assert.equal(f.confirmations,0);assert.equal(f.calls.some(c=>c.route==='execute'),false);
});


test('chat start shows a report without any paid dispatch or extra discussion call',async()=>{
 const f=fixture({cold:true}),source=fs.readFileSync('site/director.js','utf8'),nodes=new Map();
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='messageText'?'ابدأ':'',scrollIntoView(){}});return nodes.get(id);};
 const scope={window:f.scope.window,working:false,selected:()=>f.project,pIsArchive:()=>false,$,persist(){},render(){},renderProgress(){},state(){},err:e=>e.message,
  prepareChatOffer:async p=>{p.chatStartOffer=await f.controller.prepare(p);},invokeChat(){throw Error('Start must not make another discussion request');}};
 const start=source.indexOf('$("messageForm").onsubmit='),end=source.indexOf('function readJson(',start);
 vm.runInNewContext(source.slice(start,end),scope);await $('messageForm').onsubmit({preventDefault(){}});
 assert.ok(f.project.chatStartOffer);assert.equal(f.calls.some(c=>c.route==='execute'),false);assert.equal(scope.working,false);
});

test('one actual report-button click handles cold start, scenes and merge with double-click protection',async()=>{
 const f=fixture({cold:true}),source=fs.readFileSync('site/director.js','utf8'),nodes=new Map();
 f.project.plan.frozenConversationSize=0;f.project.chatStartOffer=await f.controller.prepare(f.project);
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',style:{}});return nodes.get(id);};
 const scope={window:f.scope.window,working:false,stopping:false,selected:()=>f.project,pIsArchive:()=>false,$,persist(){},render(){},renderProgress(){},state(){},err:e=>e.message,
  Date:{now:()=>1000},saveServerDraft:async()=>{},getData:async()=>null,putData:async()=>{},mergeClips:async()=>{scope.merged=true;},pushLog(){}};
 const start=source.indexOf('$("approvePlan").onclick=async()=>{'),end=source.indexOf('function pushLog(',start);
 const run=source.indexOf('async function runProduction('),runEnd=source.indexOf('async function mergeClips()',run);
 vm.runInNewContext(source.slice(start,end)+source.slice(run,runEnd),scope);
 await Promise.all([$('approvePlan').onclick(),$('approvePlan').onclick()]);
 assert.equal(f.calls.filter(c=>c.route==='execute'&&c.body.quoteId.startsWith('start-')).length,1);
 assert.equal(f.calls.filter(c=>c.route==='execute'&&c.body.quoteId.startsWith('generate-')).length,3);
 assert.equal(f.confirmations,0);assert.equal(scope.merged,true);assert.equal(scope.working,false);
});


test('a new story discussion forks from a rendered film without overwriting any scene or prior messages',()=>{
 const f=fixture(),p=f.project;p.plan.frozenConversationSize=2;
 p.messages=[{role:'user',content:'Old animal comedy'},{role:'assistant',content:'Old completed plan'},
  {role:'user',content:'اريد قصة حب واقعية بشخصيات بشرية مدتها60ثانية'},
  {role:'assistant',content:'The new realistic romance prompt'}];
 p.plan.slots[0].jobId='successful-old-video';p.plan.slots[0].status='done';
 const before=JSON.stringify(p);assert.equal(f.controller.needsFork(p),true);
 const next=f.controller.forkDiscussion(p,'independent-story');
 assert.equal(JSON.stringify(p),before);assert.equal(next.plan,null);assert.equal(next.approved,false);
 assert.equal(next.parentProjectId,p.id);assert.equal(next.id,'independent-story');
 assert.ok(next.messages.some(m=>m.content.includes('قصة حب')));
 assert.ok(next.messages.every(m=>!m.content.includes('Old animal')));
 assert.equal(f.calls.length,0);
});


test('unsubmitted approval can be renewed only after server scenes prove no previous attempt',async()=>{
 const f=fixture(),o=await f.controller.prepare(f.project);f.controller.accept(f.project,o);
 const fresh=await f.controller.refreshApproval(f.project,o,[]);
 assert.equal(fresh.changed,false);assert.equal(fresh.offer.consumedAt,null);
 f.controller.accept(f.project,fresh.offer);
 await assert.rejects(f.controller.refreshApproval(f.project,o,[{jobId:'existing-attempt'}]),/محاولة سابقة/);
 o.engineSubmitted=true;await assert.rejects(f.controller.refreshApproval(f.project,o,[]),/محاولة سابقة/);
 assert.equal(f.calls.some(c=>c.route==='execute'),false);
});

test('failed save opens the generation interface with an error and never consumes approval or dispatches',async()=>{
 const f=fixture(),source=fs.readFileSync('site/director.js','utf8'),nodes=new Map();
 f.project.plan.frozenConversationSize=0;const offer=await f.controller.prepare(f.project);f.project.chatStartOffer=offer;
 let visible=false,phase='';f.scope.window.ProductionNetwork={open(){visible=true;},phase(s){phase=s;}};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
 const scope={window:f.scope.window,Date:{now:()=>1000},working:false,selected:()=>f.project,pIsArchive:()=>false,$,persist(){},render(){},renderProgress(){},state(){},err:e=>e.message,getData(){},
  saveServerDraft:async()=>{assert.equal(visible,true);throw Error('storage failure');},runProduction(){throw Error('must not start');}};
 const start=source.indexOf('$("approvePlan").onclick=async()=>{'),end=source.indexOf('function pushLog(',start);
 vm.runInNewContext(source.slice(start,end),scope);await $('approvePlan').onclick();
 assert.equal(visible,true);assert.match(phase,/storage failure/);assert.equal(offer.consumedAt,null);
 assert.equal(f.calls.some(c=>c.route==='execute'),false);
});


test('restoring a saved report can render before the deferred engine module loads',()=>{
 const f=fixture(),source=fs.readFileSync('site/director.js','utf8'),nodes=new Map();
 f.project.chatStartOffer={rate:.001};Object.assign(f.project.plan,{beats:[],estimate:0});
 const scope={document:{createElement:()=>({append(){}})},window:{},working:false,selected:()=>f.project,pIsArchive:()=>false,toClock:()=>"00:30",state(){},
  $:id=>{if(!nodes.has(id))nodes.set(id,{replaceChildren(){},append(){}});return nodes.get(id);}};
 const a=source.indexOf('function renderPlan(){'),b=source.indexOf('$("rejectPlan").onclick=',a);
 vm.runInNewContext(source.slice(a,b),scope);assert.doesNotThrow(()=>scope.renderPlan());
});


test('Arabic dialogue for every pending scene is checked before cold GPU start or any quote',async()=>{
 const f=fixture({cold:true});delete f.project.plan.slots[2].audioContract;
 await assert.rejects(f.controller.prepare(f.project),/ARABIC_DIALOGUE_REQUIRED/);assert.equal(f.calls.length,0);
});
test('approved Arabic dialogue text and speaker cannot change after the one film approval',async()=>{
 for(const key of ['text','speaker']){const f=fixture(),o=await f.controller.prepare(f.project);f.project.plan.slots[1].audioContract.lines[0][key]+=' تغير';
  assert.throws(()=>f.controller.accept(f.project,o),/تغيرت الخطة/);assert.equal(f.calls.some(c=>c.route==='execute'),false);}
});
