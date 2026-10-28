/* Optional CPU denoising of native audio. No new voice, GPU or paid retry. */
(function(root){
 'use strict';let lastConfig=null,lastConfigAt=0;const pending=new Map();
 async function config(force=false){if(!lastConfig||force||Date.now()-lastConfigAt>3000){await root.EngineAPI.session();lastConfig=await root.EngineAPI.request('audio/config');lastConfigAt=Date.now();}return lastConfig;}
 const messages={extract_native_audio:'استخراج الصوت الأصلي',cpu_denoise:'تنظيف الضجيج على CPU الخادم',mux_without_video_reencode:'حفظ نسخة جديدة دون إعادة ترميز الصورة',verify_output:'فحص التزامن وسلامة الفيديو'};
 async function processOnce(jobId,log=()=>{},manual=false){
  const original=root.EngineAPI.videoURL(jobId),base='jobs/'+jobId;
  try{
   const c=await config();if(!manual&&!c.config.enabled)return {url:original,variant:'original'};
   if(!c.capability.ready){log('تنظيف الصوت غير مجهز؛ الفيديو الأصلي محفوظ.');return {url:original,variant:'original',warning:true};}
   const record=await root.EngineAPI.request(base+'/audio-cleanup',{approvedCpuProcessing:true,attenuationDb:c.config.attenuationDb});
   for(let n=0;n<300;n++){
    const r=await root.EngineAPI.request(base+'/audio-cleanup?id='+record.id);
    if(r?.status==='completed'){log('اكتملت نسخة الصوت المنظف؛ الفيديو الأصلي محفوظ.');return {url:root.EngineAPI.base+'/api/engine/'+base+'/clean-video?id='+r.id,variant:'clean',id:r.id};}
    if(['failed','recovery_required'].includes(r?.status)){log('تعذر تنظيف الصوت؛ التوليد ناجح والفيديو الأصلي محفوظ. لا إعادة تلقائية.');return {url:original,variant:'original',warning:true};}
    log(messages[r?.events?.at(-1)?.phase]||'المعالجة الصوتية في قائمة انتظار CPU');await new Promise(resolve=>setTimeout(resolve,1000));
   }
   log('المعالجة الصوتية لم تكتمل بعد؛ الأصل محفوظ ويمكن متابعة نفس عملية التنظيف لاحقاً.');return {url:original,variant:'original',warning:true};
  }catch{log('تعذر الاتصال بتنظيف الصوت؛ نتيجة الفيديو الأصلية باقية.');return {url:original,variant:'original',warning:true};}
 }
 function process(jobId,log,manual=false){if(!pending.has(jobId))pending.set(jobId,processOnce(jobId,log,manual).finally(()=>pending.delete(jobId)));return pending.get(jobId);}
 const box=document.getElementById('audioStudio');let status;
 root.AudioStudio={process,config,status:message=>{if(status)status.textContent=message;}};
 if(!box)return;
 const node=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
 box.append(node('summary','تنظيف الضجيج من صوت LTX الأصلي — اختياري'));
 status=node('p','جارٍ فحص تجهيز CPU');box.append(status);
 const label=node('label','تنظيف المقاطع الجديدة تلقائياً مع الاحتفاظ بالأصل'),enabled=node('input');enabled.type='checkbox';label.prepend(enabled);box.append(label);
 const strength=node('select');for(const [value,text] of [[3,'خفيف — 3dB'],[6,'متوازن — 6dB'],[12,'أقوى — 12dB']]){const o=node('option',text);o.value=String(value);strength.append(o);}box.append(strength);
 const save=node('button','حفظ إعداد الصوت');save.type='button';box.append(save);
 box.append(node('p','التنظيف لا يصحح اللهجة أو توزيع الأدوار وقد يؤثر في أصوات المكان. يعمل على CPU الخادم، والأصل لا يُستبدل. إذا GPU بقي جاهزاً أثناء المعالجة قد يستمر احتساب انتظاره.'));
 const list=node('select'),refresh=node('button','عرض الفيديوهات المكتملة'),run=node('button','تنظيف نسخة من الفيديو المحدد'),links=node('div');refresh.type=run.type='button';box.append(list,refresh,run,links);
 const showResult=(jobId,result)=>{links.replaceChildren();for(const [text,url] of [['الفيديو الأصلي',root.EngineAPI.videoURL(jobId)],...(result.variant==='clean'?[['نسخة الصوت المنظف',result.url]]:[])]){const a=node('a',text);a.href=url;a.target='_blank';a.rel='noopener';links.append(a);}};
 async function load(){try{const c=await config(true);enabled.checked=c.config.enabled;strength.value=String(c.config.attenuationDb);enabled.disabled=!c.capability.ready;run.disabled=!c.capability.ready;status.textContent=c.capability.ready?'DeepFilterNet جاهز على CPU؛ لا يُشغّل Modal.':'تنظيف الصوت غير مجهز على الخادم؛ الأصل لا يتغير.';}catch{status.textContent='سجّل دخول المسؤول لفحص الصوت.';enabled.disabled=run.disabled=true;}}
 save.onclick=async()=>{try{await root.EngineAPI.session();await root.EngineAPI.request('audio/config',{enabled:enabled.checked,attenuationDb:Number(strength.value)});await load();}catch(e){status.textContent=e.message;}};
 refresh.onclick=async()=>{try{await root.EngineAPI.session();const state=await root.EngineAPI.request('state');list.replaceChildren();for(const j of state.jobs.filter(j=>j.status==='completed'&&j.result?.videoVerified)){const o=node('option',(j.sceneId||'مشهد')+' · '+j.id.slice(0,8));o.value=j.id;list.append(o);}}catch(e){status.textContent=e.message;}};
 run.onclick=async()=>{if(!list.value)return;run.disabled=true;try{const result=await process(list.value,message=>status.textContent=message,true);showResult(list.value,result);}finally{run.disabled=false;}};
 load();
})(window);
