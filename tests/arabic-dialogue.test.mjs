import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import Arabic from '../engine/arabic-dialogue.cjs';
const script=()=>({lines:[{speaker:'علي، الشاب بالجاكيت البني',text:'عمي، ضايعة منك محفظة؟'},{speaker:'أبو حسن، الرجل بالقميص الأزرق',text:'إي ابني، هاي محفظتي، ممنون منك.'}]});
test('unspecified speech language defaults to Arabic and Iraqi without rewriting exact sentences',()=>{
 const input=script(),before=JSON.stringify(input),c=Arabic.validate(input),prompt=Arabic.compile(c);
 assert.equal(c.language,'ar');assert.equal(c.dialect,'iraqi');assert.equal(JSON.stringify(input),before);
 for(const line of input.lines){assert.ok(prompt.includes(line.speaker+' alone says exactly «'+line.text+'»'));}
 assert.match(prompt,/Do not translate, romanize, paraphrase, ad-lib/);assert.match(prompt,/After the last scripted line/);
 assert.equal(Arabic.validate({...input,dialect:'msa'}).dialect,'msa');
});
test('vague speech, English, Arabizi, scattered letters, hidden controls and missing speakers are refused',()=>{
 for(const value of [undefined,{}, {lines:[]},{language:'en',...script()},
  {lines:[{speaker:'علي',text:'هلا hello'}]},{lines:[{speaker:'علي',text:'مرحبا привет'}]},
  {lines:[{speaker:'علي',text:'shlonak 3ami'}]},{lines:[{speaker:'علي',text:'ح ب ي ب ي'}]},
  {lines:[{speaker:'علي',text:'هلا\u202e بيك'}]},{lines:[{text:'شلونك عمي؟'}]},
  {lines:[{speaker:'علي',text:'هلا '.repeat(27)}]}])assert.throws(()=>Arabic.validate(value),/ARABIC_DIALOGUE_REQUIRED/);
 assert.doesNotThrow(()=>Arabic.validate({lines:[{speaker:'علي',text:'شلونچ؟ گلبي، هلا بيچ.'}]}));
});
test('silence requires explicit request and never instructs human speech',()=>{
 const c={mode:'silent',silenceRequested:true,lines:[]};
 assert.throws(()=>Arabic.validate({...c,silenceRequested:false}),/ARABIC_DIALOGUE_REQUIRED/);
 assert.throws(()=>Arabic.validate(c,{silenceAllowed:false}),/ARABIC_DIALOGUE_REQUIRED/);
 assert.throws(()=>Arabic.validate({...c,lines:script().lines}),/ARABIC_DIALOGUE_REQUIRED/);
 assert.match(Arabic.compile(c),/No intelligible human speech/);
});
test('a second script in the visual prompt cannot override the locked script',()=>{
 assert.throws(()=>Arabic.checkPrompt('He says «مرحبا يا رفاق»',script()),/ARABIC_DIALOGUE_REQUIRED/);
 assert.doesNotThrow(()=>Arabic.checkPrompt('A realistic café. The door opens before the man turns.',script()));
});
test('browser and server use exactly the same contract without a provider or model',()=>{
 const code=fs.readFileSync('engine/arabic-dialogue.cjs','utf8');assert.equal(fs.readFileSync('site/arabic-dialogue.js','utf8'),code);
 const ctx={window:{}};vm.runInNewContext(code,ctx);
 assert.equal(JSON.stringify(ctx.window.ArabicDialogue.validate(script())),JSON.stringify(Arabic.validate(script())));
});
test('actual scene planner rejects a missing first-scene script and binds a valid Arabic script',async()=>{
 const source=fs.readFileSync('site/director.js','utf8'),a=source.indexOf('async function detailSlots('),b=source.indexOf('async function draftPlan(',a);
 const prompts=[],ctx={window:{ArabicDialogue:Arabic},state(){},strictJson:async(system,messages,validate)=>{
  prompts.push(system);const scene={index:1,beat_id:'B1',prompt:'A quiet realistic Iraqi café. Two adults arrive at the same table and politely smile.',...(ctx.invalid?{}:{audioContract:script()})};
  assert.equal(validate({scenes:[scene]}),true);return {scenes:[scene]};
 }};vm.runInNewContext(source.slice(a,b),ctx);
 const p={messages:[{role:'user',content:'قصة لطيفة في مقهى'}]},slots=[{index:1,beat_id:'B1',beat_index:0,prompt:''}];
 ctx.invalid=true;await assert.rejects(ctx.detailSlots(p,[{description:'لقاء في المقهى'}],slots,'realistic'),/ARABIC_DIALOGUE_REQUIRED/);
 assert.equal(slots[0].prompt,'');ctx.invalid=false;await ctx.detailSlots(p,[{description:'لقاء في المقهى'}],slots,'realistic');
 assert.equal(slots[0].audioContract.language,'ar');assert.match(prompts[0],/Silent mode is forbidden/);
});
