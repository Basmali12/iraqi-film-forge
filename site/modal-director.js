/* Visible in-page approval; no cloud/API request is made by this component. */
(function(root){
 'use strict';if(typeof document==='undefined')return;let pending=null;const box=document.createElement('dialog');box.className='app-cost-approval';box.setAttribute('aria-label','الموافقة على كلفة التوليد');const title=document.createElement('h2'),text=document.createElement('pre'),yes=document.createElement('button'),no=document.createElement('button');title.textContent='مراجعة التوليد والكلفة';yes.textContent='موافق وتوليد';no.textContent='إلغاء';yes.type=no.type='button';box.append(title,text,yes,no);document.body.append(box);
 const settle=value=>{const done=pending;pending=null;box.close();done?.(value);};yes.onclick=()=>settle(true);no.onclick=()=>settle(false);box.addEventListener('cancel',e=>{e.preventDefault();settle(false);});box.addEventListener('close',()=>{if(pending){const done=pending;pending=null;done(false);}});
 root.FilmApproval={ask(message){if(pending)return Promise.resolve(false);text.textContent=message;box.showModal();return new Promise(resolve=>{pending=resolve;});}};
})(window);

/* Only active video renderer: LTX on Modal. Original clip blobs are preserved. */
window.ModalDirector={async approve(message){return window.FilmApproval?window.FilmApproval.ask(message):confirm(message);},async sync(p,io){
 const api=window.EngineAPI;await api.session();const scenes=await api.request('projects/'+p.id+'/scenes');
 for(const slot of p.plan.slots){
  if(slot.status==='done'||!slot.jobId)continue;
  const current=scenes.find(s=>s.sceneId==='scene-'+slot.index),changed=current&&current.jobId!==slot.jobId;
  if(changed){slot.jobId=current.jobId;slot.status='submitted';}
  const job=await api.request('jobs/'+slot.jobId);
  if(slot.status==='ambiguous'&&!changed)continue;
  slot.retryable=job.status==='failed'&&job.cloudStopped===true&&!job.result?.videoVerified;
  slot.status=slot.retryable?'failed':['failed','uncertain','recovery_required','stopped'].includes(job.status)?'uncertain':'submitted';
 }
 await io.save();
},async run(p,io){
 const api=window.EngineAPI;await api.session();
 const state=await api.request('state');let selection=state.selection;
 if(!selection)throw Error('اختَر الحساب والكرت واحفظهما في إدارة المحركات أولاً.');
 if(p.plan.slots.some(s=>s.end-s.start!==10))throw Error('خطة LTX الحالية تتطلب مشاهد 10 ثوانٍ؛ جهّز تقريراً مستقلاً ولا تغيّر خطة قديمة ناجحة.');
 const limit=io.maxScenes??3;let submitted=0,batchApprovedScope=null;
 for(let i=0;i<p.plan.slots.length;i++){
  if(io.stopping())break;
  const slot=p.plan.slots[i];if(slot.status==='done')continue;
  if(slot.jobId){const scenes=await api.request('projects/'+p.id+'/scenes'),current=scenes.find(s=>s.sceneId==='scene-'+slot.index);if(current&&current.jobId!==slot.jobId){slot.jobId=current.jobId;slot.status='submitted';await io.save();}}
  let retryOfJobId;
  if(io.retryScene===slot.index){
   if(slot.status==='ambiguous')throw Error('إرسال غير مؤكد؛ لا يمكن إعادة المحاولة قبل حسم المهمة.');
   if(!slot.jobId)throw Error('لا توجد مهمة فاشلة محددة لإعادة المحاولة.');
   const previous=await api.request('jobs/'+slot.jobId);
   if(previous.status!=='failed'||previous.cloudStopped!==true||previous.result?.videoVerified)throw Error('إعادة المحاولة تتطلب فشلاً مؤكداً وتوقف موارد المحاولة السابقة.');
   retryOfJobId=slot.jobId;
  }
  if(!slot.jobId||retryOfJobId){
   if(slot.index>(io.maxSceneIndex??60)){io.log?.('راجع أول 3 مشاهد ثم أكد مراجعة الاستمرارية قبل البقية.');break;}
   if(submitted>=limit){io.log?.('انتهت دفعة الاختبار؛ راجع الاستمرارية والصوت قبل متابعة بقية الفيلم.');break;}
   const live=await api.request('state');selection=live.selection;if(!selection)throw Error('الحساب النشط غير محدد.');
   const warm=live.jobs?.find(j=>j.accountId===selection.accountId&&j.action==='start'&&j.status==='ready'&&!j.cloudStopped&&(!j.readyUntil||j.readyUntil>Date.now()));
   if(!warm)throw Error('شغّل المحرك من إدارة المحركات أولاً؛ لن نخصص GPU بديلاً تلقائياً.');
   if(selection.settings?.gpu&&selection.settings.gpu!==warm.settings.gpu)throw Error('الكرت المختار يختلف عن المحرك الجاري. راجع إدارة المحركات؛ لن نبدّل الكرت تلقائياً.');
   const orientation=p.ratio==='16:9'?'landscape':p.ratio==='9:16'?'portrait':(p.plan.ratio==='16:9'?'landscape':p.plan.ratio==='9:16'?'portrait':p.plan.orientation)||warm.settings.orientation||'portrait';
   if(slot.status==='ambiguous'||slot.status==='failed'&&!retryOfJobId)throw Error('حالة إرسال المشهد غير مؤكدة. افحص المهام من إدارة المحركات؛ لا يُعاد التوليد تلقائياً.');
   const initialFrame=i===0&&p.assets.length?await io.asset(p.assets[0].id):undefined;
   const references=i===0?await Promise.all(p.assets.map(async a=>({assetId:a.id,name:a.name,data:await io.asset(a.id)}))):undefined;
   const quote=await api.request('quote',{action:'generate',accountId:selection.accountId,settings:{...warm.settings,orientation},engineJobId:warm.id,retryOfJobId,creativeScene:window.CreativeStudio?.scene(slot),prompt:slot.prompt,audioContract:slot.audioContract,projectId:p.id,sceneId:'scene-'+slot.index,previousSceneId:i?'scene-'+p.plan.slots[i-1].index:undefined,initialFrame,references,projectSnapshot:{id:p.id,name:p.name,plan:p.plan,asset_names:p.assets.map(a=>a.name)}});
   if(!quote.paidEnabled)throw Error('التنفيذ المدفوع مقفل بالخادم. التقرير محفوظ، ولا يوجد خصم.');
   const costText=Number.isFinite(quote.estimate.resourceWindowUSD)?'نافذة الموارد التقديرية: $'+quote.estimate.resourceWindowUSD.toFixed(4):'متابعة يدوية؛ الكلفة النهائية غير معروفة. معدل الموارد التقديري $'+(quote.estimate.rate*60).toFixed(4)+' للدقيقة.';
   if(io.chatApproval)window.FilmChatStart.assert(p,io.chatApproval,quote,warm.id);
   if(io.approvalMode==='film'){
    const scope=JSON.stringify([selection.accountId,warm.id,warm.settings,orientation,quote.estimate.rate,quote.creativeSnapshot?.libraryRevision,quote.dialoguePolicyVersion]);
    if(batchApprovedScope&&batchApprovedScope!==scope)throw Error('تغير الحساب أو الجلسة أو إعدادات الموارد أو التعرفة؛ توقف الفيلم دون إرسال مشهد جديد. ابدأ بموافقة جديدة.');
    if(!batchApprovedScope){
     const remaining=p.plan.slots.slice(i).filter(s=>s.status!=='done'&&!s.jobId).length;
     if(!io.chatApproval&&!await this.approve('تشغيل بقية الفيلم تلقائياً — '+remaining+' مشهداً / '+remaining*10+' ثانية فيديو\nGPU: '+warm.settings.gpu+' · الحساب المحدد نفسه\nمعدل الموارد التقديري $'+(quote.estimate.rate*60).toFixed(4)+' للدقيقة أثناء التشغيل، وليس لكل دقيقة فيديو.\nالزمن والكلفة النهائية غير معروفين مسبقاً. قد تضاف رسوم بناء وتخزين؛ هذا ليس سقف فاتورة.\nسنحفظ كل مشهد ونبدأ التالي ونضم الصوت الأصلي دون تأكيد آخر بين المشاهد.\nيمكنك الإيقاف بعد المشهد الجاري؛ الفشل أو غموض الطلب يوقف التسلسل دون إعادة تلقائية.\nتوافق على تشغيل جميع المشاهد المتبقية بهذه الإعدادات؟'))return {cancelled:true};
     batchApprovedScope=scope;
    }
   }else if(!await this.approve('مشهد '+slot.index+' فقط — '+warm.settings.gpu+'\n10 ثوانٍ · '+(orientation==='landscape'?'1280×720':'720×1280')+' · صوت LTX الأصلي\n'+costText+'\nقد تضاف رسوم بناء/تخزين. هذا ليس سقف فاتورة.\n'+(i?'سيُستخدم آخر إطار فعلي للمشهد السابق؛ الاستمرارية والجودة تحتاجان فحصاً.':'المرجع الأول، إن وجد، يشرط أول إطار؛ ثبات الهوية غير مضمون.')+'\nتوافق على هذه المهمة الواحدة؟'))return {cancelled:true};
   if(io.stopping())break;
   slot.status='ambiguous';slot.retryable=false;await io.save();
   try{const result=await api.request('execute',{quoteId:quote.id,confirmation:'أوافق على التكلفة'});slot.jobId=result.id;slot.status='submitted';submitted++;await io.save();}
   catch(e){if(e.detail?.jobId){slot.jobId=e.detail.jobId;slot.status='submitted';await io.save();}else throw e;}
  }
  let done=false;
  for(let n=0;n<900;n++){
   const job=await api.request('jobs/'+slot.jobId),event=job.events.at(-1);
   io.log('مشهد '+slot.index+' · '+job.status+' · '+(event?.phase||'بانتظار بيانات المرحلة الفعلية'));
   if(job.status==='completed'&&job.result?.videoVerified){
    const r=await fetch(api.videoURL(job.id),{credentials:'include'});if(!r.ok)throw Error('الفيديو محفوظ بالخادم، لكن تنزيله تعثر. استأنف نفس المهمة.');
    await io.clip(p.id+'-clip-'+i,await r.blob());slot.audioVariant='original';
    slot.status='done';slot.cost=job.result.recordedCost?.usd??null;slot.estimatedCost=job.estimatedUSD;slot.accountId=job.accountId;slot.gpu=job.settings.gpu;slot.conditioning=job.result.continuity?.conditioning||null;await io.save();
    try{if(window.AudioStudio){const audio=await window.AudioStudio.process(job.id,message=>io.log(message));if(audio.variant==='clean'){const cleaned=await fetch(audio.url,{credentials:'include'});if(cleaned.ok){await io.clip(p.id+'-clip-'+i+'-clean',await cleaned.blob());slot.audioVariant='clean';slot.audioCleanupId=audio.id;await io.save();}}}}catch{io.log('تعذر حفظ نسخة الصوت المنظف؛ الفيديو الأصلي ناجح ومحفوظ.');}
    done=true;break;
   }
   if(job.status==='needs_review'&&job.result?.generationSucceeded){
    slot.retryable=false;slot.status='uncertain';await io.save();
    throw Error('الفيديو أُنتج وحُفظ، لكن فحص الكتابة لم يقبل النسخة النهائية. لا إعادة توليد تلقائية؛ الأصل محفوظ للفحص.');
   }
   if(['failed','uncertain','recovery_required','stopped'].includes(job.status)){
    slot.retryable=job.status==='failed'&&job.cloudStopped===true&&!job.result?.videoVerified;slot.status=slot.retryable?'failed':'uncertain';await io.save();
    throw Error('المشهد '+slot.index+': '+(slot.retryable?'فشل وتأكد توقف موارد محاولته؛ استخدم زر إعادة المحاولة لمراجعة كلفة جديدة.':'حالة المهمة تحتاج التحقق قبل أي محاولة جديدة.')+' لا إعادة تلقائية.');
   }
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!done)throw Error('انتهت المراقبة المحلية؛ هذا لا يضمن توقف السحابة. افحص نفس رقم المهمة في إدارة المحركات.');
  if(io.retryScene===slot.index)break;
 }
 if(p.plan.slots.every(s=>s.status==='done'))await io.merge();
}};
