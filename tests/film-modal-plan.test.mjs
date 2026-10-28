import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const scope={window:{}};vm.runInNewContext(fs.readFileSync('site/film-modal-plan.js','utf8'),scope);
const plan=scope.window.FilmModalPlan;

for(const seconds of [180,300])test(seconds+' second film gets ordered unique ten-second scenes without network or invented events',()=>{
 const story=Array.from({length:seconds/10},(_,i)=>'الحدث '+(i+1)+' يتقدم نحو نتيجة مختلفة ثم يظهر رد الفعل.').join('\n');
 const result=plan.create(story,seconds,{cast:'علي، قميص أزرق وصوت عراقي ثابت',now:123});
 assert.equal(result.scenes.length,seconds/10);assert.equal(result.plan.duration_seconds,seconds);
 assert.equal(result.scenes.at(-1).end,seconds);assert.equal(result.plan.preparedAt,123);
 assert.equal(result.scenes.flatMap(s=>s.sourceEvents).length,seconds/10);
 for(let i=0;i<result.scenes.length;i++){
  const s=result.scenes[i];assert.equal(s.index,i+1);assert.equal(s.end-s.start,10);
  assert.ok(s.prompt.includes('الحدث '+(i+1)+' يتقدم'));assert.equal(s.jobId,null);
 }
});
test('insufficient story is rejected rather than looping it to fill five minutes',()=>{
 assert.throws(()=>plan.create('هذه قصة قصيرة لا تحتوي ثلاثين حدثاً. '.repeat(3),300),/30/);
 assert.throws(()=>plan.create('x'.repeat(100),35),/مضاعفات/);
});
test('quoted questions stay in their own event without splitting or repeating dialogue',()=>{
 const beats=plan.beats('دخل علي الغرفة. قال «من هنا؟ لا تفتح الباب». هرب إلى الخارج.');
 assert.equal(beats.length,3);assert.ok(beats[1].includes('من هنا؟ لا تفتح الباب'));
});
test('explicit speaker labels bind each scene to the intended character without swapping dialogue',()=>{
 const story=['المتحدث: علي، الشاب بالجاكيت البني؛ يسأل «عمي، ضايع منك شي؟»',
 'المتحدث: أبو حسن، الرجل الكبير بالقميص الأزرق؛ يجيب «إي ابني، محفظتي البنية»',
 'المتحدث: علي، الشاب بالجاكيت البني؛ يسلم المحفظة ويقول «تفضل عمي»'].join('\n');
 const result=plan.create(story,30);assert.match(result.scenes[0].speaker,/^علي/);assert.match(result.scenes[1].speaker,/^أبو حسن/);
 assert.match(result.scenes[1].prompt,/Only أبو حسن/);assert.match(result.scenes[1].prompt,/All other people listen silently/);
 assert.equal(result.scenes[1].dialogue[0],'إي ابني، محفظتي البنية');assert.equal(result.scenes[1].qualityWarnings.length,0);
});
test('missing speaker is flagged rather than falsely inferred from two character names',()=>{
 const text='يقترب علي من أبو حسن وينظر الرجل إليه ثم يقول «المحفظة ضاعت»';const result=plan.create([text,text,text].join('\n'),30);
 assert.equal(result.scenes[0].speaker,null);assert.ok(result.scenes[0].qualityWarnings.length);assert.match(result.scenes[0].prompt,/Do not guess speaker ownership/);
});
