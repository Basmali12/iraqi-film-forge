import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixedEngineSettings,qualityFor} from '../engine/config.mjs';
test('all film-controller literal controls exist in the unified page and removed surfaces stay absent',()=>{
 const html=fs.readFileSync('site/film.html','utf8'),ids=new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
 for(const file of ['site/director.js','site/film-engine.js'])for(const m of fs.readFileSync(file,'utf8').matchAll(/\$\(['"]([^'"]+)['"]\)/g))assert.ok(ids.has(m[1]),file+': missing '+m[1]);
 assert.match(html,/id="toggleStories"/);assert.match(html,/id="newStory"/);assert.match(html,/id="storyDrawer" hidden/);assert.match(html,/id="creativeStudio" hidden/);assert.match(html,/id="audioStudio" hidden/);assert.doesNotMatch(html,/id="filmQuality"/);
 for(const name of ['index','director'])assert.match(fs.readFileSync('site/'+name+'.html','utf8'),/url=\.\/film.html/);
 const engines=fs.readFileSync('site/engines.html','utf8');assert.doesNotMatch(engines,/id="scenePrompt"|id="gpu"|id="ram"|id="cpu"|الإعدادات المتقدمة والتقرير/);
});
test('new and old account input resources resolve to the approved fixed engine and true 720 output',()=>{
 for(const value of [{},{gpu:'L40S',ram:64,cpu:8},{gpu:'RTX-PRO-6000',ram:128,cpu:8}]){const s=fixedEngineSettings(value);assert.equal(s.gpu,'RTX-PRO-6000');assert.equal(s.cpu,4);assert.equal(s.ram,96);assert.equal(s.ramLimit,96);}
 for(const [orientation,w,h,nw,nh] of [['portrait',720,1280,768,1280],['landscape',1280,720,1280,768]]){const q=qualityFor({orientation});assert.deepEqual([q.width,q.height,q.nativeWidth,q.nativeHeight],[w,h,nw,nh]);assert.equal(q.nativeWidth%64,0);assert.equal(q.nativeHeight%64,0);assert.equal(q.nativeAudio,true);assert.equal(q.convVAE,false);assert.equal(q.pipeline,'DFRPipeline');}
});
test('conversation actions have long-press, keyboard and recoverable server paths without media removal',()=>{
 const ui=fs.readFileSync('site/film-workbench.js','utf8');assert.match(ui,/650/);assert.match(ui,/oncontextmenu/);assert.match(ui,/F10/);assert.match(ui,/remoteOperation\(p.id,'archive'/);assert.match(ui,/remoteOperation\(p.id,'rename'/);assert.match(ui,/STORAGE\+'-trash'/);assert.doesNotMatch(ui,/removeData|\.delete\('assets'/);
 const keyUI=fs.readFileSync('site/openai-studio.js','utf8');assert.doesNotMatch(keyUI,/budgetLabel|budget.value/);
});
