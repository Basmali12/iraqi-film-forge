(function(root){
 'use strict';
 function derive(snapshot,now=Date.now()){
  const account=snapshot.accounts.find(a=>a.id===snapshot.selection?.accountId)||snapshot.accounts.find(a=>a.role==='primary'&&a.workspace==='basm1998ali');
  const jobs=account?snapshot.jobs.filter(j=>j.accountId===account.id).sort((a,b)=>a.createdAt-b.createdAt):[];
  const active=[...jobs].reverse().find(j=>['start','generate','prepare'].includes(j.action)&&j.cloudStopped!==true&&!(j.status==='completed'&&j.attachedEngineId&&j.result?.videoVerified));
  const start=active?.attachedEngineId?jobs.find(j=>j.id===active.attachedEngineId):active;
  const video=[...jobs].reverse().find(j=>j.status==='completed'&&j.result?.videoVerified);
  let state='off',title='متوقف',detail='اضغط تشغيل لتحضير النموذج من الأوزان المحفوظة.',action='start';
  if(!account){state='unlinked';title='الحساب الأساسي يحتاج تفويضاً';detail='اسم الحساب ثابت؛ ربطه الآمن بالخادم لم يكتمل بعد.';action=null;}
  else if(active){
   action='stop';
   if(active.status==='stopping'||active.stopRequestedAt&&['queued','running','ready'].includes(active.status)){state='stopping';title='جارٍ الإيقاف';detail='ننتظر تأكيد توقف الحاويات؛ انتهاء الانتظار وحده ليس تأكيداً.';}
   else if(!['queued','running','ready'].includes(active.status)){state='uncertain';title='يلزم التحقق من توقف الموارد';detail='لن نبدأ مهمة جديدة قبل حسم حالة المحرك السابق.';action='reconcile';}
   else if(active.status==='ready'&&active.action==='start'){
    if(active.readyUntil&&active.readyUntil<=now){state='stopping';title='انتهت مهلة الخمول';detail='بانتظار تأكيد الإيقاف التلقائي؛ لن نشغّل GPU بديلاً.';action='reconcile';}
    else{state='ready';title='تم — المحرك جاهز';detail='اكتب وصفك وأنشئ فيديو، أو اضغط إيقاف.';}
   }else if(active.action==='prepare'){state='settingup';title='جارٍ تجهيز الحساب';detail='نقل الأوزان وفحصها؛ لا يعمل GPU في مرحلة النقل.';}
   else if(active.action==='generate'){state='generating';title='جارٍ إنشاء الفيديو';detail='الصورة والحوار والصوت من LTX-2.5 نفسه.';}
   else{state='preparing';title='جارٍ تجهيز المحرك';detail='نعرض مراحل التنفيذ الواردة من السحابة فقط.';}
  }else if(!(account.discovery?.productionQuality?.ready??account.discovery?.ready)){title='الحساب يحتاج تجهيز';detail='افحص خطة النقل والكلفة أولاً؛ لا تشغيل GPU بمجرد اختيار الحساب.';action=account.role==='primary'?'start':'prepare';}
  else if(account.activated===false){title='جاهز — احفظ الحساب';detail='اكتملت جاهزية الأوزان. اضغط حفظ والبدء لإتاحته للتشغيل.';action='activate';}
  else if(jobs.at(-1)?.status==='needs_review'&&jobs.at(-1)?.result?.generationSucceeded){title='الفيديو محفوظ — فحص الكتابة يحتاج مراجعة';detail='التوليد نجح، لكن النسخة لم تجتز فحص النصوص؛ لا إعادة توليد تلقائية.';}
  else if(['failed','uncertain','recovery_required'].includes(jobs.at(-1)?.status)){title='توقفت العملية بسبب خطأ';detail='توقف الموارد مؤكد؛ التجهيز لم يكتمل. راجع التقرير قبل أي محاولة جديدة.';}
  else if(video){title='الفيديو جاهز — المحرك متوقف';detail='تقدر تنزّل النتيجة أو تبدأ مشهداً جديداً.';}
  return {account,jobs,active,start,video,state,title,detail,action,canGenerate:state==='ready',idleRemaining:state==='ready'&&active.readyUntil?Math.max(0,Math.ceil((active.readyUntil-now)/1000)):null};
 }
 function stages(job){
  const generate=job?.action==='generate';
  const list=job?.action==='prepare'?[['connection','فحص اتصال الحسابين'],['source_discovery','جلب معلومات الحساب الأساسي'],['storage','تجهيز التخزين'],['transfer','نقل الأوزان'],['integrity','فحص سلامة الملفات'],['engine_configuration','إعداد المحرك'],['ready','جاهز للحفظ']]:generate?[[job?.quality?.pipeline==='DFRPipeline'?'prompt_prepare':'text_forward','ترميز الوصف والحوار'],['denoise_stage_1','التوليد — المرحلة الأولى'],['denoise_stage_2','التوليد — المرحلة الثانية'],['video_decode','فك الصورة'],['audio_decode','فك الصوت الأصلي'],['finalize_mp4','حفظ MP4'],...(job?.quality?.textQualityRequired?[['text_detection','فحص الكتابة على CPU'],['text_verification','فحص النسخة النهائية والصوت']]:[])]:[['application_setup','تجهيز التطبيق'],['gpu_dispatch_to_first_event','إقلاع GPU'],['runtime_imports','تهيئة بيئة النموذج'],['pipeline_setup','تجهيز مسار الاستدلال'],...(job?.quality?.pipeline==='DFRPipeline'?[]:[['transformer_build','قراءة الأوزان وبناء Transformer']]),['ready',job?.quality?.pipeline==='DFRPipeline'?'مسار DFR جاهز؛ الأوزان تُحمّل عند التوليد':'جاهز لاستقبال الوصف']];
  const events=job?.events||[];
  return list.map(([key,label])=>{
   const configured=events.some(e=>e.phase==='engine_configuration');
   const done=events.some(e=>(e.phase===key&&e.kind==='phase_end')||(key==='application_setup'&&e.kind==='app_created')||(key==='ready'&&e.kind==='ready'))||(job?.action==='prepare'&&((['transfer','integrity'].includes(key)&&configured)||(key==='ready'&&job.result?.ready===true)));
   const current=!done&&events.some(e=>e.phase===key&&e.kind==='phase_start');
   return {key,label,status:done?'done':current?'current':'pending'};
  });
 }
 function explainError(code){
  if(code==='GENERATION_SUCCEEDED_TEXT_REVIEW_REQUIRED')return 'الفيديو أُنتج والأصل محفوظ، لكن إزالة الكتابة أو فحصها يحتاج مراجعة. لا إعادة توليد تلقائية.';
  if(code==='LTX_DFR_WEIGHTS_REQUIRED')return 'الحساب يحتاج ملفي Diffusion VAE وLoRA الخاصين بـDFR. لن نرجع إلى النموذج القديم أو ننزل أوزاناً تلقائياً.';
  if(code==='TEXT_QC_NOT_CONFIGURED')return 'فاحص الكتابة على CPU غير مجهز على الخادم؛ لم يبدأ GPU.';
  if(code==='ENGINE_QUALITY_CHANGED_STOP_OLD_SESSION')return 'توقفت الموافقة لأن الجلسة تستخدم المسار السابق؛ أوقفها أولاً ثم جهز DFR.';
  const value=String(code||'');
  const setup={APPLICATION_MONTHLY_LIMIT_REQUIRES_BOUNDED_PLAN:'يوجد حد شهري منفصل للتطبيق؛ لا يمكن اعتماد مدة مفتوحة ضمنه. إعدادات فوترة Modal لم تتغير.',NO_SAVED_WEIGHTS_TO_VERIFY:'لا توجد أوزان محفوظة لفحصها. لم يبدأ عامل أو نقل.',TRANSFER_CANCELLED:'أُوقفت المهمة بطلبك؛ الملفات المحفوظة باقية ولم تبدأ محاولة بديلة.',DESTINATION_VERIFIER_NOT_READY:'عامل فحص حساب الوجهة غير جاهز.',DESTINATION_VERIFICATION_FAILED:'تعذر فحص ملفات الوجهة؛ لم نعلن الجاهزية ولم نعد النقل تلقائياً.',DESTINATION_VERIFIER_TIMEOUT:'انتهت مهلة فحص الوجهة؛ تحقق من توقف العامل قبل محاولة جديدة.',CLOUD_WORKER_NOT_DEPLOYED:'عامل النقل السحابي غير مهيأ بعد. يلزم اعتماد نشره واختبار ملف صغير قبل النقل الكامل؛ لا توجد عملية في الخلفية.',CLOUD_TRANSFER_RECONCILIATION_REQUIRED:'تعثر اتصال مراقبة النقل. نراجع المهمة نفسها دون إنشاء نقل ثانٍ؛ تأكد من تجديد التفويض إذا انتهت صلاحيته.',CLOUD_TRANSFER_STOP_UNCONFIRMED:'أُرسل إيقاف عامل النقل لكن لم يتأكد توقفه. لا نبدأ مهمة بديلة حتى نحسم الحالة.',CLOUD_TRANSFER_FAILED:'فشل نقل الأوزان السحابي. الملفات السليمة تبقى محفوظة؛ راجع الخطأ ثم أنشئ خطة جديدة للناقص فقط.',TRANSFER_TIMEOUT:'انتهت مهلة عامل النقل. تحقق من توقفه ثم راجع خطة الملفات الناقصة.',INTEGRITY_CHANGED_SCOPE_APPROVE_NEW_PLAN:'كشف فحص البصمات ملفات ناقصة أو تالفة خارج الخطة المعتمدة؛ اعتمد خطة جديدة قبل أي نقل إضافي.',INVALID_CREATIVE_BRIEF:'اكتب طلباً مختصراً حتى 4000 حرف، وتفاصيل حتى 500 حرف؛ أو اختر وصف جاهز لإرسال نصك المطوّل كما هو.',PRIVATE_STAGING_DISK_INSUFFICIENT:'مساحة قرص التجهيز بالخادم لا تكفي لنقل أكبر ملف أوزان. لم يبدأ النقل؛ راجع المساحة وخطة التجهيز.',ACCOUNT_SETUP_CONFIRMATION_REQUIRED:'أكمل تجهيز الحساب واضغط حفظ والبدء قبل تشغيله.',STOP_ACTIVE_ENGINE_BEFORE_SWITCH:'أوقف المحرك الحالي وتأكد من توقف موارده قبل تبديل الحساب.',INVALID_TOKEN_FORMAT:'صيغة مفاتيح Modal غير صحيحة. أدخل Token ID وToken Secret من حسابك.',ACCOUNT_ALREADY_LINKED:'هذا الحساب محفوظ مسبقاً؛ اختره من القائمة بدلاً من إضافته مرة ثانية.',INVALID_ORIENTATION:'اختر عمودي أو أفقي فقط.',SOURCE_SHA256_MISMATCH:'بصمة ملف المصدر غير مطابقة. توقف النقل؛ لم تُحذف النسخة الأصلية.',DESTINATION_SHA256_MISMATCH:'فشل فحص سلامة الملف المنقول؛ يحتاج خطة فحص جديدة قبل إعادة المحاولة.'};
  if(setup[value])return setup[value];
  const messages={PROMPT_REQUIRED:'اكتب وصف المشهد أولاً؛ الوصف القصير مقبول.',FRESH_EXPLICIT_COST_APPROVAL_REQUIRED:'انتهت صلاحية عرض الكلفة. راجع عرضاً جديداً قبل التأكيد.',PAID_ACTIONS_DISABLED_ON_SERVER:'التشغيل المدفوع مقفل على الخادم.',ENGINE_SESSION_EXPIRED_NO_NEW_GPU:'انتهت جلسة المحرك. لم نشغّل كرتاً بديلاً؛ شغّل المحرك مجدداً بموافقة جديدة.',ONE_ACTIVE_OR_UNCERTAIN_JOB_ONLY:'توجد مهمة شغالة أو تحتاج التحقق من توقفها. لن نبدأ مهمة ثانية.',RESOURCE_WINDOW_EXCEEDS_JOB_BUDGET:'الكلفة التقديرية تتجاوز الحد الذي حددته للمهمة.',APPLICATION_MONTHLY_LIMIT_EXCEEDED:'وصلت إلى حد الإنفاق المحدد داخل التطبيق.',WEIGHTS_NOT_READY:'الأوزان المحفوظة غير جاهزة. لم نبدأ التوليد.',GPU_REPORTED_FAILURE_CLOUD_STOPPED_NO_AUTOMATIC_RETRY:'أبلغ كرت الشاشة عن فشل وتأكد إيقافه. لن نكرر التوليد تلقائياً.',OPERATION_STATE_UNCERTAIN_DO_NOT_RESUBMIT:'تعذر تأكيد نتيجة العملية. افحص حالة الموارد قبل أي محاولة جديدة.',OutOfMemoryError:'ذاكرة كرت الشاشة لم تكفِ لإكمال هذه المرحلة.',MemoryBudgetExceeded:'توقفت المرحلة لحماية حد الذاكرة.',AUTHENTICATION_REQUIRED:'انتهت جلسة الدخول؛ سجّل الدخول مجدداً.'};
  if(messages[value])return messages[value];
  if(/[\u0600-\u06ff]/.test(value))return value;
  return 'تعذّر إكمال العملية. راجع تفاصيل الخطأ في التقرير؛ لا تعِد التشغيل قبل التحقق من الموارد.';
 }
 function progress(job){
  const items=stages(job),events=job?.events||[],last=[...events].reverse().find(e=>['phase_start','phase_end','progress','phase_error','ready'].includes(e.kind));
  const names={text_detection:'فحص الكتابة على CPU',text_verification:'فحص النصوص بعد الإزالة مع حفظ الصوت',text_encoder_load:'تحميل مرمّز النص',prompt_prepare:'تجهيز الوصف والحوار',weights_read_transform:'قراءة الأوزان من التخزين',gpu_operation:'تنفيذ النموذج',device_preflight:'فحص كرت الشاشة',render:'توليد الصورة والصوت',upload:'رفع الملف إلى Volume الوجهة — نسبة الرفع غير متاحة',cloud_transfer:'نقل الأوزان سحابياً باستخدام CPU',destination_verifier_setup:'تجهيز عامل فحص CPU في حساب الوجهة'};
  const finishedType=job?.status==='completed'?(job.result?.videoVerified?'video':job.result?.ready?'account':job.result?.probeVerified?'probe':job.result?.verificationOnly?'verification':null):null;
  const finished=!!finishedType;
  const cancelled=job?.status==='stopped'&&job.cloudStopped===true&&!!job.stopRequestedAt;
  const idle=job?.action==='start'&&job.status==='ready';
  const label=cancelled?'تم إيقاف النقل وتأكد توقف موارده':finishedType==='video'?'اكتمل الفيديو وحفظ MP4':finishedType==='account'?'اكتمل تجهيز الأوزان وفحص READY.json':finishedType==='probe'?'نجح اختبار النقل الصغير؛ لم يبدأ نقل الأوزان':finishedType==='verification'?'اكتمل فحص الموجود؛ لم يبدأ نقل جديد':idle?'المحرك جاهز — لا توجد عملية توليد جارية':items.find(s=>s.key===last?.phase)?.label||names[last?.phase]||'انتظار تحديث المرحلة من الخادم';
  const counter=last?.kind==='progress'&&Number.isFinite(last.completed)&&Number.isFinite(last.total)&&last.total>0&&last.completed>=0&&last.completed<=last.total?last:null;
  const failed=[...events].reverse().find(e=>e.kind==='phase_error');
  const numerical=job?.action==='generate'?[...events].reverse().find(e=>e.kind==='progress'&&Number.isFinite(e.global_completed)&&Number.isFinite(e.global_total)&&e.global_total>0&&e.global_completed>=0&&e.global_completed<=e.global_total):null;
  return {label,finished,finishedType,cancelled,idle,done:items.filter(s=>s.status==='done').length,total:items.length,completed:counter?.completed??null,steps:counter?.total??null,denoiseCompleted:numerical?.global_completed??null,denoiseTotal:numerical?.global_total??null,percent:numerical?Math.floor(numerical.global_completed/numerical.global_total*100):null,error:cancelled?null:failed?explainError(failed.error_type):job?.error?explainError(job.error):null};
 }
 function trackedJob(view){
  if(view.active?.action==='start'&&view.active.status==='ready'&&view.video?.attachedEngineId===view.active.id)return view.video;
  return view.active||view.jobs.at(-1);
 }
 function byteProgress(job){
  const events=job?.events||[],last=events.at(-1);
  if(!last||!['transfer','integrity'].includes(last.phase)||last.kind==='phase_error')return null;
  const samples=events.filter(e=>e.kind==='progress'&&e.phase===last.phase&&e.file===last.file),e=samples.at(-1);if(!e)return null;
  const completed=e.phase==='integrity'?e.completed:e.transferred,total=e.phase==='integrity'?e.total:e.required;
  if(!(Number.isFinite(completed)&&Number.isFinite(total)&&total>0&&completed>=0&&completed<=total))return null;
  let rate=Number.isFinite(e.rate)&&e.rate>0?e.rate:null;
  const previous=samples.at(-2),seconds=previous&&e.time-previous.time;
  if(rate===null&&seconds>=1){const before=e.phase==='integrity'?previous.completed:previous.transferred;if(completed>before)rate=(completed-before)/seconds;}
  return {phase:e.phase,completed,total,rate};
 }
 root.PrimaryEngineModel={derive,stages,progress,trackedJob,explainError,byteProgress};
})(window);
