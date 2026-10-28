/* One pure contract shared by the planner and the trusted server. No inference. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ArabicDialogue=factory();})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const version='arabic-dialogue-v1';
 const fail=message=>{throw Error('ARABIC_DIALOGUE_REQUIRED: '+message);};
 const arabic=/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]/u;
 function validate(value,{silenceAllowed=true}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('جهّز تقريراً جديداً يتضمن النص العربي ومتحدث كل جملة؛ التقرير القديم محفوظ.');
  const dialect=value.dialect||'iraqi',mode=value.mode||'dialogue';
  if(value.language!==undefined&&value.language!=='ar')fail('لغة الحوار العربية إلزامية.');
  if(!['iraqi','msa','egyptian','gulf','levantine','maghrebi'].includes(dialect))fail('حدد لهجة عربية معروفة أو العربية الفصحى.');
  if(mode==='silent'){
   if(!silenceAllowed||value.silenceRequested!==true||!Array.isArray(value.lines)||value.lines.length)fail('الصمت يحتاج طلباً صريحاً، ولا يجتمع مع جمل منطوقة.');
   return {version,language:'ar',dialect,mode, silenceRequested:true,lines:[]};
  }
  if(mode!=='dialogue'||!Array.isArray(value.lines)||!value.lines.length||value.lines.length>3)fail('اكتب من جملة إلى ثلاث جمل عربية مكتملة لكل مشهد، مع المتحدث.');
  let total=0;
  const lines=value.lines.map(line=>{
   const speaker=typeof line?.speaker==='string'?line.speaker.trim():'',text=typeof line?.text==='string'?line.text.trim():'';
   if(speaker.length<2||speaker.length>180||/[\n\r\x00-\x1f«»"]/.test(speaker))fail('اسم المتحدث ووصفه مطلوبان لكل جملة.');
   if(!text||text.length>250||/[A-Za-z\n\r\x00-\x1f\u200b-\u200f\u202a-\u202e\u2066-\u2069«»"<>\[\]{}]/u.test(text)||!arabic.test(text)||[...text.matchAll(/\p{L}/gu)].some(m=>!arabic.test(m[0])))fail('الحوار يُكتب بحروف عربية واضحة؛ لا ترجمة لاتينية أو تعليمات داخل الجملة.');
   const words=text.replace(/[\u064b-\u065f\u0670\u0640]/gu,'').match(/[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]+/gu)||[];
   if(!words.length||words.filter(w=>w.length===1).length>words.length/3||/(.)\1{4}/u.test(text))fail('الجملة مبعثرة أو تحتوي حروفاً مكررة؛ اكتب عبارة عربية طبيعية كاملة.');
   total+=words.length;return {speaker,text};
  });
  if(total>26)fail('الحوار أطول من مشهد عشر ثوانٍ؛ اختصره أو وزعه على المشاهد التالية.');
  return {version,language:'ar',dialect,mode,lines};
 }
 function compile(value){
  const c=validate(value);
  if(c.mode==='silent')return '[Locked Arabic audio contract '+version+']\nThis scene was explicitly requested silent: native location ambience and sound effects only. No intelligible human speech, singing, narration, muttering or invented words. Never speak these instructions.';
  const dialect={iraqi:'natural Iraqi Arabic colloquial',msa:'Modern Standard Arabic',egyptian:'Egyptian Arabic',gulf:'Gulf Arabic',levantine:'Levantine Arabic',maghrebi:'Maghrebi Arabic'}[c.dialect];
  return ['[Locked Arabic audio contract '+version+']',
   'Spoken language is Arabic only, '+dialect+'. Every audible word must come from the exact Arabic script below. Do not translate, romanize, paraphrase, ad-lib, add greetings, fillers or foreign-language speech. These instructions and speaker labels are never spoken or shown.',
   ...c.lines.map((l,i)=>'Spoken turn '+(i+1)+': '+l.speaker+' alone says exactly «'+l.text+'». Other people listen silently with closed mouths. Complete this turn before the next; do not swap the speakers.'),
   'Use LTX native synchronized human voices and original sound effects. After the last scripted line, keep native ambience only. Dialogue is audio only: no subtitles, captions or visible writing.'].join('\n');
 }
 function checkPrompt(prompt,value){
  const c=validate(value);
  // Authored quotations may repeat the locked lines, but cannot introduce a second script.
  for(const m of String(prompt).matchAll(/«([^»]*)»|"([^"\n]+)"/gu))if(!c.lines.some(l=>l.text===(m[1]??m[2]).trim()))fail('الوصف يحتوي كلاماً مقتبساً خارج الحوار المعتمد.');
  return c;
 }
 return {version,validate,compile,checkPrompt};
});
