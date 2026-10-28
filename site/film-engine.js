/* One shared Modal session; polling never starts paid resources. */
(function(root){
 'use strict';
 function controller(api,notify){
  let snapshot=null,view=null,pending=false,quote=null,error=null;
  function emit(){notify({snapshot,view,pending,quote,error,ready:!!view?.canGenerate&&!error&&snapshot.selection?.accountId===view.account.id&&snapshot.selection.settings.gpu===view.start.settings.gpu});}
  async function poll(){
   try{await api.session();snapshot=await api.request('state');view=root.PrimaryEngineModel.derive(snapshot);error=null;}
   catch(e){view=null;error=root.PrimaryEngineModel.explainError(e.message||e.code);}
   emit();return view;
  }
  async function propose(){
   if(pending)return null;pending=true;quote=null;emit();
   try{
    await poll();if(!view)throw Error(error);
    const selected=snapshot.selection;
    if(!selected||view.account?.id!==selected.accountId)throw Error('اختَر الحساب وإعداداته من إدارة المحركات أولاً.');
    if(view.active)throw Error('توجد جلسة نشطة أو تحتاج تحققاً؛ لن نبدأ محركاً ثانياً.');
    if(!(view.account.discovery?.productionQuality?.ready??view.account.discovery?.ready)||view.account.activated===false)throw Error('أكمل تجهيز الأوزان وحفظ الحساب من إدارة المحركات أولاً.');
    quote=await api.request('quote',{action:'start',accountId:selected.accountId,settings:selected.settings});
    if(!quote.paidEnabled)throw Error('التشغيل المدفوع مقفل بالخادم.');
    return quote;
   }catch(e){quote=null;throw e;}finally{pending=false;emit();}
  }
  async function approve(){
   if(pending||!quote)return;const approved=quote;quote=null;pending=true;emit();
   try{await api.request('execute',{quoteId:approved.id,approvedCost:true});}
   catch(e){error='تعذر تأكيد طلب التشغيل؛ لن نعيده تلقائياً. افحص حالة المحرك. '+root.PrimaryEngineModel.explainError(e.message||e.code);throw Error(error);}
   finally{pending=false;await poll();}
  }
  async function stop(){
   if(pending)return;pending=true;quote=null;emit();
   try{await poll();if(!view?.active)return;const job=view.start||view.active;await api.request('jobs/'+job.id+'/stop',{confirmCancel:true});}
   finally{pending=false;await poll();}
  }
  return {poll,propose,approve,stop,cancel(){quote=null;emit();}};
 }
 root.FilmEngineSetup={controller,ready:false};
 if(!root.document)return;
 const $=id=>document.getElementById(id);let current=null,reading=false;
 const control=controller(root.EngineAPI,data=>{
  current=data;root.FilmEngineSetup.ready=data.ready;
  const view=data.view,job=view?.active,modal=$('filmProvider').value==='modal';
  $('filmEngineBox').hidden=!modal;
  $('filmEngineStatus').textContent=data.error||view?.title||'حالة المحرك غير متاحة؛ افحص الاتصال بالخادم.';
  $('filmEngineAccount').textContent=view?.account?(view.account.workspace+' · '+(view.start?.settings?.gpu||data.snapshot?.selection?.settings?.gpu||'اختر الكرت')):'الحساب غير متاح';
  $('filmEnginePower').textContent=job?'إيقاف المحرك':'تشغيل المحرك';
  $('filmEnginePower').disabled=data.pending||!view||!data.snapshot?.selection||(job?view.state==='stopping':view.action!=='start');
  const items=root.PrimaryEngineModel.stages(job);$('filmEngineStages').replaceChildren();
  if(job?.action==='start')for(const item of items){const li=document.createElement('li');li.textContent=(item.status==='done'?'✓ ':item.status==='current'?'◉ ':'○ ')+item.label;li.className=item.status;$('filmEngineStages').append(li);}
  const progress=root.PrimaryEngineModel.progress(job),bar=$('filmEngineProgress');bar.hidden=!job||data.ready||view.state==='stopping';
  if(progress.completed!==null){bar.max=progress.steps;bar.value=progress.completed;}else bar.removeAttribute('value');
  const elapsed=job?.startedAt?Math.max(0,Math.floor((Date.now()-job.startedAt)/1000)):null;
  $('filmEngineTiming').textContent=data.ready?'جاهز للتوليد؛ بقاء GPU جاهزاً قد يُحاسب عليه.':job?(progress.label+' · '+(elapsed===null?'':'المنقضي '+elapsed+' ثانية · ')+'المتبقي: غير معروف'):'يمكنك كتابة القصة؛ التوليد ينتظر جاهزية المحرك.';
  if(progress.error)$('filmEngineStatus').textContent=progress.error;
  root.dispatchEvent(new Event('film-engine-state'));
 });
 async function refresh(){if(reading||$('filmProvider').value!=='modal')return;reading=true;try{await control.poll();}finally{reading=false;}}
 root.FilmEngineSetup.refresh=refresh;
 $('filmEnginePower').onclick=async()=>{
  try{
   if(current?.view?.active){if(!confirm('إيقاف المحرك؟ إذا يوجد مشهد جارٍ سيُطلب إلغاؤه. الأوزان والفيديوهات المحفوظة تبقى.'))return;await control.stop();return;}
   const q=await control.propose();if(!q)return;
   $('filmEngineQuote').textContent=['تشغيل جلسة واحدة — '+q.settings.gpu,
    'الحساب: '+current.view.account.workspace,
    'معدل الموارد التقديري: $'+(q.estimate.rate*60).toFixed(4)+' للدقيقة.',
    Number.isFinite(q.estimate.resourceWindowUSD)?'نافذة الموارد: $'+q.estimate.resourceWindowUSD.toFixed(4):'المدة والكلفة النهائية غير معروفتين مسبقاً.',
    'يبدأ احتساب التجهيز والتحميل وانتظار GPU. قد تضاف رسوم البناء والتخزين. هذا ليس سقف فاتورة.',
    'اضغط إيقاف عند الانتهاء؛ الخمول التلقائي حسب إعداد الجلسة. لا يبدأ توليد فيديو بهذا الزر.'].join('\n');
   $('filmEngineApproval').showModal();
  }catch(e){$('filmEngineStatus').textContent=root.PrimaryEngineModel.explainError(e.message||e.code);}
 };
 $('filmEngineApprove').onclick=async()=>{
  $('filmEngineApproval').close();try{await control.approve();}catch(e){$('filmEngineStatus').textContent=e.message;}
 };
 $('filmEngineCancel').onclick=()=>{$('filmEngineApproval').close();control.cancel();};
 $('filmEngineApproval').addEventListener('cancel',()=>control.cancel());
 $('filmEngineRefresh').onclick=refresh;
 setInterval(refresh,3000);
})(window);
/* Explicit chat consent binds one film, account, model, resources and price.
   Loading this module or preparing an offer never executes paid work. */
(function(root){
 'use strict';
 const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 function isCommand(text){return /^(?:(?:تمام|موافق|اوكي|يلا|زين)\s+)?(?:ابدا(?:\s+(?:الان|التنفيذ|التوليد|بتنفيذ الفيلم|بتوليد الفيلم))?|نفذ(?:\s+(?:الفيلم|الخطة|التوليد))?|ولد(?:\s+(?:الفيديو|الفيلم))?)[.!،؟\s]*$/u.test(String(text).trim().replace(/[\u064b-\u065f\u0670]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي'));}
 function signature(p,creative){return stable([p.id,p.videoProvider,p.plan?.seconds,p.ratio||p.plan?.ratio,p.plan?.quality,p.plan?.slots?.map(s=>[s.index,s.start,s.end,s.prompt,s.audioContract,creative?.(s)]),p.assets?.map(a=>[a.id,a.name])]);}
 function needsFork(p){return Number.isInteger(p.plan?.frozenConversationSize)&&p.plan.slots.some(s=>s.jobId)&&p.messages.slice(p.plan.frozenConversationSize).some(m=>m.role==='user');}
 function forkDiscussion(p,id){
  if(!needsFork(p))return null;
  const messages=JSON.parse(JSON.stringify(p.messages.slice(p.plan.frozenConversationSize)));
  const topic=messages.find(m=>m.role==='user'&&m.content.length>15)?.content||'قصة جديدة';
  return {id,name:topic.slice(0,45),videoProvider:'modal',messages:[{role:'assistant',content:'هذه قصة مستقلة من نقاشك الأخير. الفيلم السابق ومشاهده محفوظة ولن نعيد توليدها.'},...messages],
   assets:JSON.parse(JSON.stringify(p.assets||[])),random:!!p.random,directorState:p.directorState?JSON.parse(JSON.stringify(p.directorState)):undefined,
   plan:null,approved:false,created:Date.now(),parentProjectId:p.id};
 }
 function serverSnapshot(p){
  const allowed=['id','name','messages','assets','random','plan','approved','created','videoProvider','jobs','directorState'];
  const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(allowed.filter(k=>p[k]!==undefined).map(k=>[k,p[k]]))));
  if(snapshot.plan){if(p.chatStartOffer)snapshot.plan.executionOffer=JSON.parse(JSON.stringify(p.chatStartOffer));if(p.parentProjectId)snapshot.plan.parentProjectId=p.parentProjectId;}
  return snapshot;
 }
 function scope(q){return stable([q.accountId,q.settings,q.quality,q.estimate?.rate,q.creativeSnapshot?.libraryRevision,q.dialoguePolicyVersion]);}
 function create(api,{now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),creative=slot=>root.CreativeStudio?.scene(slot)}={}){
  const selected=(state,offer)=>{if(stable(state.selection)!==offer.selection)throw Error('تغير الحساب أو إعداداته بعد عرض الكلفة؛ جهّز عرضاً جديداً واضغط موافق مجدداً.');};
  const active=state=>{
   const jobs=(state.jobs||[]).filter(j=>j.action==='start'&&!j.cloudStopped);
   if(jobs.length>1||jobs.some(j=>!['queued','running','ready'].includes(j.status)))throw Error('توجد جلسة غير محسومة؛ افحص الموارد قبل أي تشغيل.');
   if((state.jobs||[]).some(j=>j.action==='generate'&&!j.cloudStopped&&['queued','running','uncertain','recovery_required','stopping'].includes(j.status)))throw Error('يوجد مشهد جارٍ أو غير محسوم؛ لا نبدأ فيلماً ثانياً.');
   return jobs[0]||null;
  };
  return {
   isCommand,needsFork,forkDiscussion,serverSnapshot,
   async prepare(p){
    if(!p.plan?.verified)throw Error('جهّز تقريراً زمنياً سليماً أولاً.');
    if(p.plan.slots.some(s=>s.status!=='done'&&(s.jobId||['failed','uncertain','ambiguous','submitted'].includes(s.status))))throw Error('توجد مشاهد سابقة تحتاج متابعة أو فحصاً؛ لا إعادة تلقائية.');
    const slot=p.plan.slots.find(s=>s.status!=='done');if(!slot)throw Error('الفيلم مكتمل؛ لن نعيد توليده.');
    if(!root.ArabicDialogue)throw Error('حدّث الصفحة لتحميل فحص الحوار العربي.');
    for(const scene of p.plan.slots.filter(s=>s.status!=='done'))root.ArabicDialogue.checkPrompt(scene.prompt,scene.audioContract);
    await api.session();const state=await api.request('state'),selection=state.selection;
    if(!selection)throw Error('اختَر حساب Modal محفوظاً أولاً.');
    const engine=active(state);if(engine&&engine.accountId!==selection.accountId)throw Error('المحرك الجاري لحساب آخر؛ لا نبدل الحساب تلقائياً.');
    const orientation=(p.ratio||p.plan.ratio)==='16:9'?'landscape':'portrait';
    const q=await api.request('quote',{action:'generate',accountId:selection.accountId,settings:{...selection.settings,orientation},prompt:slot.prompt,audioContract:slot.audioContract,projectId:p.id,sceneId:'scene-'+slot.index,creativeScene:creative(slot)});
    if(!q.paidEnabled||!Number.isFinite(q.estimate?.rate)||q.estimate.rate<=0)throw Error('تعذر عرض تعرفة تشغيل صالحة؛ لم يبدأ GPU.');
    const start=engine?null:await api.request('quote',{action:'start',accountId:selection.accountId,settings:selection.settings});
    if(start&&(!start.paidEnabled||!Number.isFinite(start.estimate?.rate)))throw Error('تشغيل المحرك غير متاح؛ لم يبدأ GPU.');
    if(start&&(start.quality?.contract!==q.quality?.contract||start.settings.gpu!==q.settings.gpu||start.estimate.rate!==q.estimate.rate))throw Error('تغير النموذج أو الموارد أثناء التسعير؛ حدّث التقرير.');
    return {kind:'film-chat-approval',plan:signature(p,creative),selection:stable(selection),scope:scope(q),rate:q.estimate.rate,startRate:start?.estimate.rate,
     accountId:selection.accountId,workspace:state.accounts?.find(a=>a.id===selection.accountId)?.workspace||selection.accountId,
     settings:q.settings,quality:q.quality,remaining:p.plan.slots.filter(s=>s.status!=='done').length,
     expiresAt:Math.min(q.expiresAt||now()+300000,start?.expiresAt||now()+300000),
     engineJobId:engine?.id||null,startQuoteId:start?.id||null,consumedAt:null,engineSubmitted:false};
   },
   describe(o){return ['الخطة جاهزة: '+o.remaining+' مشهداً، '+o.remaining*10+' ثانية فيديو، 720p والصوت الأصلي.',
    'النموذج: '+(o.quality?.model||'حسب عقد الخادم')+' · '+(o.quality?.pipeline||(o.quality?.convVAE?'Conv VAE':'مسار الخادم المعتمد'))+'.',
    'الحساب: '+o.workspace+' · '+o.settings.gpu+' · RAM '+o.settings.ram+'GiB · CPU '+o.settings.cpu+'.',
    'معدل الموارد التقديري: $'+(o.rate*60).toFixed(4)+' لكل دقيقة حوسبة، وليس لكل دقيقة فيديو.',
    o.startRate?'تشغيل المحرك من التوقف: $'+(o.startRate*60).toFixed(4)+' لكل دقيقة حوسبة أثناء التجهيز والانتظار.':'سنستخدم جلسة المحرك الحالية نفسها دون تشغيل بديل.',
    'الزمن والكلفة النهائية غير معروفين مسبقاً؛ قد تضاف رسوم بناء وتخزين. هذا ليس سقف فاتورة.',
    'اضغط «موافق وابدأ» للموافقة على كلفة تنفيذ هذه الخطة كلها: تشغيل المحرك عند الحاجة، انتظار جاهزيته، توليد المشاهد بالترتيب ثم الدمج، بدون أزرار إضافية.',
    'الخطأ أو تغيير الخطة أو الحساب يوقف التنفيذ؛ لا إعادة محاولة تلقائية.'].join('\n');},
   async refreshApproval(p,o,scenes){
    if(o?.engineSubmitted||p.plan.slots.some(s=>s.jobId||['ambiguous','submitted','uncertain','failed'].includes(s.status))||scenes.length)throw Error('توجد محاولة سابقة؛ تابع نفس المهمة ولا تعِد التشغيل.');
    const offer=await this.prepare(p);
    return {offer,changed:!o||offer.plan!==o.plan||offer.scope!==o.scope||offer.selection!==o.selection||offer.engineJobId!==o.engineJobId||offer.startRate!==o.startRate};
   },
   accept(p,o){
    if(!o||o.kind!=='film-chat-approval')throw Error('نعرض الخطة والكلفة أولاً، بعدها اضغط موافق.');
    if(o.consumedAt!==null)throw Error('سُجل أمر البدء سابقاً؛ تابع نفس المهمة ولا تكرر الطلب.');
    if(now()>=o.expiresAt||signature(p,creative)!==o.plan)throw Error('تغيرت الخطة أو انتهت صلاحية عرض الكلفة؛ حدّث العرض ثم اضغط موافق.');
    o.consumedAt=now();return o;
   },
   async ensure(p,o,io){
    if(o.consumedAt===null||signature(p,creative)!==o.plan)throw Error('موافقة الفيلم غير صالحة.');
    let state=await api.request('state');selected(state,o);let engine=active(state);
    if(engine&&engine.id!==o.engineJobId)throw Error('تغيرت جلسة المحرك؛ لا تشغيل أو تبديل تلقائي.');
    if(!engine){
     if(o.engineJobId||o.engineSubmitted)throw Error('انتهت الجلسة أو إرسالها غير مؤكد؛ لا نبدأ محركاً ثانياً.');
     if(!o.startQuoteId||now()>=o.expiresAt)throw Error('انتهت صلاحية موافقة تشغيل المحرك.');
     if(io.stopping())throw Error('تم إلغاء البدء قبل تشغيل GPU.');
     o.engineSubmitted=true;await io.save();
     const job=await api.request('execute',{quoteId:o.startQuoteId,approvedCost:true});
     o.engineJobId=job.id;await io.save();
    }
    const deadline=now()+1200000;
    while(now()<deadline){
     if(io.stopping())throw Error('توقفت المتابعة بطلبك؛ افحص زر إيقاف المحرك، فقد تبقى الجلسة مدفوعة.');
     state=await api.request('state');selected(state,o);engine=active(state);
     if(!engine||engine.id!==o.engineJobId)throw Error('جلسة المحرك توقفت أو تغيرت؛ لا إعادة تشغيل تلقائية.');
     if(engine.status==='ready'){
      if(engine.readyUntil&&engine.readyUntil<=now())throw Error('انتهت جلسة المحرك؛ يلزم أمر جديد بعد عرض الكلفة.');
      if(engine.accountId!==o.accountId)throw Error('جلسة الحساب غير مطابقة.');
      return engine;
     }
     io.log('ننتظر جاهزية نفس المحرك · '+engine.status+' · المتبقي غير معروف');await sleep(2000);
    }
    throw Error('انتهت المراقبة المحلية؛ هذا لا يضمن توقف GPU. افحص نفس الجلسة دون إعادة التشغيل.');
   },
   assert(p,o,q,engineId){if(o?.kind!=='film-chat-approval'||o.consumedAt===null||o.engineJobId!==engineId||signature(p,creative)!==o.plan||scope(q)!==o.scope)throw Error('تغيرت الخطة أو الحساب أو النموذج أو الموارد أو التعرفة؛ يلزم عرض وموافقة جديدان.');}
  };
 }
 root.FilmChatStart={create,...create(root.EngineAPI)};
})(window);
