import test from 'node:test';import assert from 'node:assert/strict';
import {emptyLibrary,validateLibrary,compileScene} from '../engine/creative-library.mjs';
const library=()=>validateLibrary({revision:0,characters:[{id:'ali',name:'علي',description:'الشاب بالجاكيت البني',voice:'صوت شاب طبيعي',dialect:'عراقي'},{id:'abu',name:'أبو حسن',description:'الرجل الكبير بالقميص الأزرق',voice:'صوت كبير هادئ',dialect:'عراقي'}],props:[{id:'wallet',name:'المحفظة',description:'جلد بني بحجم كف اليد، تبقى محفظة جيب'}]});
const scene=()=>({characterIds:['ali','abu'],propIds:['wallet'],turns:[{speakerId:'ali',listenerIds:['abu'],text:'عمي ضايع منك شي؟'},{speakerId:'abu',listenerIds:['ali'],text:'إي ابني محفظتي',replyTo:0}]});
test('scene contract binds question and response to distinct named actors and selected prop',()=>{
 const compiled=compileScene(library(),scene());assert.equal(compiled.snapshot.turns[1].speakerId,'abu');assert.match(compiled.directions,/أبو حسن \(الرجل الكبير/);assert.match(compiled.directions,/محفظة جيب/);assert.match(compiled.snapshot.visualConditioning,/not active/);assert.match(compiled.snapshot.voiceConditioning,/no voice cloning/);
});
test('unknown roles, self-listeners and self-answered conversations are rejected',()=>{
 for(const change of [s=>s.turns[1].speakerId='missing',s=>s.turns[0].listenerIds=['ali'],s=>s.turns[1].speakerId='ali',s=>s.characterIds=['ali']]){const s=scene();change(s);assert.throws(()=>compileScene(library(),s));}
});
test('unprovisioned Ingredients cannot be enabled by a client flag',()=>{assert.throws(()=>compileScene(library(),{...scene(),referenceMode:'ingredients'}),/INGREDIENTS_INFERENCE_NOT_CONFIGURED/);});
test('library whitelists fields and does not accidentally introduce unselected actors',()=>{
 assert.throws(()=>validateLibrary({...library(),characters:[{id:'x',name:'',description:''}]}));assert.equal(compileScene(emptyLibrary(),undefined),null);
 const result=compileScene(library(),{characterIds:['ali'],propIds:[],turns:[{speakerId:'ali',text:'هاي لمن؟'}]});assert.equal(result.snapshot.characters.length,1);assert.doesNotMatch(result.directions,/أبو حسن/);
});
