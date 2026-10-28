import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBrief} from '../engine/prompt-planner.mjs';
test('Iraqi software ad contains brand, a relevant setting, demonstration, dialogue and outcome',()=>{
 const b=prepareBrief({request:'شخص يعمل اعلان بلهجه العراقيه عن شركة برمجة اسمها فن التقنية الحديثة'});
 assert.equal(b.kind,'advert');assert.equal(b.brand,'فن التقنية الحديثة');
 assert.match(b.compiledPrompt,/software studio/);assert.match(b.compiledPrompt,/demonstrates one simple app interaction/);
 assert.match(b.dialogue,/فن التقنية الحديثة/);assert.match(b.compiledPrompt,/Iraqi Baghdadi/);
 assert.equal(b.timeline.length,3);assert.equal(b.paid,false);assert.match(b.method,/no external AI/);
 assert.match(b.compiledPrompt,/No subtitles/);assert.doesNotMatch(b.dialogue,/خصم|الأفضل|سنوات|%/);
});
test('explicit visual setting and spoken copy are preserved, not overwritten by a template',()=>{
 const b=prepareBrief({kind:'advert',request:'إعلان عن شركة برمجة',brand:'شركة المستخدم',location:'مكتب زجاجي يطل على بغداد',dialogue:'فكرتك تصير حقيقة ويّانا.'});
 assert.equal(b.location,'مكتب زجاجي يطل على بغداد');assert.equal(b.dialogue,'فكرتك تصير حقيقة ويّانا.');
 assert.match(b.compiledPrompt,/مكتب زجاجي/);
});
test('story and scene requests do not inherit a software ad or invented speech',()=>{
 for(const request of ['قصة طفل يبحث عن قطته في الحديقة','شخص يمشي في الصحرا']){
  const b=prepareBrief({request});assert.notEqual(b.kind,'advert');assert.equal(b.dialogue,'');
  assert.match(b.compiledPrompt,new RegExp(request));assert.doesNotMatch(b.compiledPrompt,/software studio/);
 }
 assert.throws(()=>prepareBrief({request:''}));assert.throws(()=>prepareBrief({request:'a'.repeat(4001)}));
});
