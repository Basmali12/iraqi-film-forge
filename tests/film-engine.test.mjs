// Offline protocol verification. No credentials, GPU allocation or Modal calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(){
 const calls=[],changes=[],state={accounts:[{id:'a',workspace:'fixture',discovery:{ready:true}}],selection:{accountId:'a',settings:{gpu:'RTX-PRO-6000'}},jobs:[]};
 const api={session:async()=>{},async request(route,body){calls.push({route,body});if(route==='state')return state;if(route==='quote')return {id:'q',paidEnabled:true,settings:state.selection.settings,estimate:{rate:.001}};if(route==='execute'){state.jobs=[{id:'engine-one',accountId:'a',action:'start',status:'running',createdAt:1,settings:state.selection.settings,events:[]}];return {id:'engine-one'};}if(route.endsWith('/stop'))return {};throw Error('Unexpected route '+route);}};
 const scope={window:{}};vm.runInNewContext(fs.readFileSync('site/primary-engine-model.js','utf8'),scope);vm.runInNewContext(fs.readFileSync('site/film-engine.js','utf8'),scope);
 const control=scope.window.FilmEngineSetup.controller(api,s=>changes.push(s));
 return {control,api,calls,changes,state};
}
test('opening, selecting and polling do not start GPU or quote paid work',async()=>{
 const f=fixture();await f.control.poll();await f.control.poll();assert.ok(f.calls.every(c=>c.route==='state'));assert.equal(f.changes.at(-1).ready,false);
});
test('start requires separate quote acceptance and one execute despite double confirm',async()=>{
 const f=fixture();await f.control.propose();assert.equal(f.calls.filter(c=>c.route==='execute').length,0);
 await Promise.all([f.control.approve(),f.control.approve()]);assert.equal(f.calls.filter(c=>c.route==='execute').length,1);assert.equal(f.changes.at(-1).ready,false);
 f.state.jobs[0].status='ready';await f.control.poll();assert.equal(f.changes.at(-1).ready,true);
 await assert.rejects(f.control.propose(),/جلسة نشطة/);assert.equal(f.calls.filter(c=>c.route==='execute').length,1);
});
test('readiness is revoked on expiry, GPU mismatch or failed authentication',async()=>{
 const f=fixture();await f.control.propose();await f.control.approve();f.state.jobs[0].status='ready';await f.control.poll();assert.equal(f.changes.at(-1).ready,true);
 f.state.jobs[0].readyUntil=1;await f.control.poll();assert.equal(f.changes.at(-1).ready,false);
 delete f.state.jobs[0].readyUntil;f.state.jobs[0].settings={gpu:'L40S'};await f.control.poll();assert.equal(f.changes.at(-1).ready,false);
 f.api.session=async()=>{throw Error('AUTHENTICATION_REQUIRED');};await f.control.poll();assert.equal(f.changes.at(-1).ready,false);assert.match(f.changes.at(-1).error,/انتهت جلسة/);
});
test('ambiguous execute is not retried and cancellation has no paid mutation',async()=>{
 const f=fixture();await f.control.propose();f.api.request=async(route)=>{f.calls.push({route});if(route==='state')return f.state;if(route==='execute')throw Error('lost response');throw Error('unexpected');};
 await assert.rejects(f.control.approve(),/لن نعيده/);await f.control.approve();await f.control.poll();assert.equal(f.calls.filter(c=>c.route==='execute').length,1);
 const g=fixture();await g.control.propose();g.control.cancel();await g.control.approve();assert.equal(g.calls.filter(c=>c.route==='execute').length,0);
});
test('stop targets shared engine and does not declare stopped from request acknowledgement',async()=>{
 const f=fixture();await f.control.propose();await f.control.approve();await f.control.stop();assert.equal(f.calls.filter(c=>c.route==='jobs/engine-one/stop').length,1);assert.equal(f.changes.at(-1).view.state,'preparing');assert.equal(f.calls.some(c=>/delete|volume/.test(c.route)),false);
});
test('unified film UI has one fixed engine and readiness controls without invented ETA',()=>{
 const html=fs.readFileSync('site/film.html','utf8'),js=fs.readFileSync('site/modal-director.js','utf8'),control=fs.readFileSync('site/film-engine.js','utf8');
 assert.match(html,/<input id="videoEngine" type="hidden" value="modal">/);assert.match(html,/id="filmEnginePower"/);
 assert.match(js,/if\(!warm\)throw Error/);assert.match(js,/warm.settings.gpu/);
 assert.match(control,/المتبقي: غير معروف/);assert.match(control,/bar.removeAttribute\('value'\)/);assert.doesNotMatch(control,/localStorage|token.secret|token.id/i);
});
