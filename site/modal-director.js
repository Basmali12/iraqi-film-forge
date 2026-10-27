/* Optional LTX path. Existing HeyGen projects and original clip blobs are preserved. */
window.ModalDirector={async run(p,io){
 const api=window.EngineAPI;await api.session();
 const state=await api.request('state');let selection=state.selection;
 if(!selection)throw Error('اختَر الحساب والكرت واحفظهما في إدارة المحركات أولاً.');
 if(p.plan.slots.some(s=>s.end-s.start!==10))throw Error('خطة LTX الحالية تتطلب مشاهد 10 ثوانٍ؛ جهّز تقريراً مستقلاً ولا تغيّر خطة HeyGen ناجحة.');
 for(let i=0;i<p.plan.slots.length;i++){
  if(io.stopping())break;
  const slot=p.plan.slots[i];if(slot.status==='done')continue;
  if(slot.jobId){const scenes=await api.request('projects/'+p.id+'/scenes'),current=scenes.find(s=>s.sceneId==='scene-'+slot.index);if(current&&current.jobId!==slot.jobId){slot.jobId=current.jobId;slot.status='submitted';io.save();}}
  if(!slot.jobId){
   selection=(await api.request('state')).selection;if(!selection)throw Error('الحساب النشط غير محدد.');
   if(slot.status==='ambiguous'||slot.status==='failed')throw Error('حالة إرسال المشهد غير مؤكدة. افحص المهام من إدارة المحركات؛ لا يُعاد التوليد تلقائياً.');
   const initialFrame=i===0&&p.assets.length?await io.asset(p.assets[0].id):undefined;
   const references=i===0?await Promise.all(p.assets.map(async a=>({assetId:a.id,name:a.name,data:await io.asset(a.id)}))):undefined;
   const quote=await api.request('quote',{action:'generate',accountId:selection.accountId,settings:selection.settings,prompt:slot.prompt,projectId:p.id,sceneId:'scene-'+slot.index,previousSceneId:i?'scene-'+p.plan.slots[i-1].index:undefined,initialFrame,references,projectSnapshot:{id:p.id,name:p.name,plan:p.plan,asset_names:p.assets.map(a=>a.name)}});
   if(!quote.paidEnabled)throw Error('التنفيذ المدفوع مقفل بالخادم. التقرير محفوظ، ولا يوجد خصم.');
   if(!confirm('مشهد '+slot.index+' فقط — '+selection.settings.gpu+'\n10 ثوانٍ · 576×1024 · صوت LTX الأصلي\nنافذة الموارد التقديرية: $'+quote.estimate.resourceWindowUSD.toFixed(4)+'\nقد تضاف رسوم بناء/تخزين. هذا ليس سقف فاتورة.\n'+(i?'سيُستخدم آخر إطار فعلي للمشهد السابق؛ الاستمرارية والجودة تحتاجان فحصاً.':'المرجع الأول، إن وجد، يشرط أول إطار؛ ثبات الهوية غير مضمون.')+'\nتوافق على هذه المهمة الواحدة؟'))break;
   slot.status='ambiguous';io.save();
   try{const result=await api.request('execute',{quoteId:quote.id,confirmation:'أوافق على التكلفة'});slot.jobId=result.id;slot.status='submitted';io.save();}
   catch(e){if(e.detail?.jobId){slot.jobId=e.detail.jobId;slot.status='submitted';io.save();}else throw e;}
  }
  let done=false;
  for(let n=0;n<900;n++){
   const job=await api.request('jobs/'+slot.jobId),event=job.events.at(-1);
   io.log('مشهد '+slot.index+' · '+job.status+' · '+(event?.phase||'بانتظار بيانات المرحلة الفعلية'));
   if(job.status==='completed'&&job.result?.videoVerified){
    const r=await fetch(api.videoURL(job.id),{credentials:'include'});if(!r.ok)throw Error('الفيديو محفوظ بالخادم، لكن تنزيله تعثر. استأنف نفس المهمة.');
    await io.clip(p.id+'-clip-'+i,await r.blob());slot.status='done';slot.cost=job.result.recordedCost?.usd??null;slot.estimatedCost=job.estimatedUSD;slot.accountId=job.accountId;slot.gpu=job.settings.gpu;io.save();done=true;break;
   }
   if(['failed','uncertain','recovery_required','stopped'].includes(job.status))throw Error('المشهد '+slot.index+': '+job.status+' — افحص الحالة دون إعادة تلقائية.');
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!done)throw Error('انتهت المراقبة المحلية؛ هذا لا يضمن توقف السحابة. افحص نفس رقم المهمة في إدارة المحركات.');
 }
 if(p.plan.slots.every(s=>s.status==='done'))await io.merge();
}};
