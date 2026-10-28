'use strict';
const el=id=>document.getElementById(id),api=window.EngineAPI,model=window.PrimaryEngineModel;
let snapshot=null,view=null,quote=null,busy=false,restored=false,loadedVideo=null,accountOptions='',draftTimer,draftTouched=false,draftSave=Promise.resolve(),preparedSource=null,approvedPrompt=null,renewingAccount=null;
const labels={start:'تحميل المحرك فقط، دون توليد تلقائي',generate:'إنشاء فيديو واحد على نفس المحرك',prepare:'تجهيز الحساب ونقل الأوزان — دون GPU'};
const gib=n=>(Number(n||0)/2**30).toFixed(2)+' GiB';
function notice(text){el('notice').textContent=/^[A-Z][A-Z_0-9]+$/.test(String(text))?model.explainError(text):text;}
function values(){return {gpu:'RTX-PRO-6000',cpu:4,ram:96,timeout:0,startup:0,idleSeconds:1200,budget:0,seed:42,orientation:'portrait'};}
async function action(fn){if(busy)return;busy=true;render();try{await fn();}catch(error){notice(model.explainError(error.message));}finally{busy=false;await refresh().catch(error=>notice(model.explainError(error.message)));}}
async function refresh(){snapshot=await api.request('state');if(!restored){for(const [field,value] of Object.entries(snapshot.selection?.settings||{}))if(el(field))el(field).value=value;restored=true;}render();}
function render(){
 if(!snapshot)return;view=model.derive(snapshot);
 const optionsKey=JSON.stringify(snapshot.accounts.map(a=>[a.id,a.workspace,a.activated,a.discovery?.ready]));
 if(optionsKey!==accountOptions){accountOptions=optionsKey;el('accountSelect').replaceChildren();for(const a of snapshot.accounts){const option=document.createElement('option');option.value=a.id;option.textContent=a.workspace+(a.role==='primary'?' — الأساسي':a.activated===false?' — يحتاج إكمال التجهيز':' — محفوظ');el('accountSelect').append(option);}}
 el('accountSelect').value=view.account?.id||'';
 const occupied=snapshot.jobs.some(j=>!j.cloudStopped&&!(j.status==='completed'&&j.attachedEngineId&&j.result?.videoVerified));
 el('accountSelect').disabled=busy||occupied;
 el('accountName').textContent=view.account?.workspace||'لا يوجد حساب مربوط';el('accountRole').textContent=view.account?.role==='primary'?'الحساب الأساسي':'الحساب المحدد';
 const tracked=model.trackedJob(view),progress=model.progress(tracked);el('liveProgress').hidden=!tracked;
 el('liveTitle').textContent=progress.finished&&view.state==='ready'?'اكتمل الفيديو — المحرك جاهز لمشهد آخر':view.title;el('liveStage').textContent=progress.label;
 const bar=el('phaseProgress');if(progress.completed!==null){bar.max=progress.steps;bar.value=progress.completed;}else{bar.removeAttribute('value');}
 const transfer=model.byteProgress(tracked);
 if(tracked?.action==='prepare'&&transfer){bar.max=transfer.total;bar.value=transfer.completed;}
 if(progress.denoiseTotal!==null){bar.max=progress.denoiseTotal;bar.value=progress.denoiseCompleted;}
 bar.hidden=!view.active||progress.idle||progress.finished||(tracked?.action==='generate'&&progress.denoiseTotal===null&&progress.completed===null);
 const finishedText=progress.finishedType==='video'?'اكتمل الفيديو 100%':progress.finishedType==='probe'?'اختبار 64KiB مكتمل؛ الحساب يحتاج نقل الأوزان':progress.finishedType==='verification'?'اكتمل فحص الموجود في حساب الوجهة؛ لا نقل جديد':'اكتملت الأوزان؛ احفظ الحساب';
 const byteText=transfer?(transfer.phase==='integrity'?'فحص بصمة الوجهة: ':'قراءة المصدر: ')+gib(transfer.completed)+' / '+gib(transfer.total)+'؛ السرعة: '+(transfer.rate===null?'غير معروفة':(transfer.rate/2**20).toFixed(1)+' MiB/ثانية'):'عداد هذه المرحلة غير متاح؛ لا نعرض نسبة رفع غير مقاسة';
 el('liveCounter').textContent=progress.cancelled?'المهمة متوقفة؛ الملفات المحفوظة باقية.':progress.finished?finishedText:progress.idle?'جاهز لوصف جديد؛ انتظار GPU مدفوع':tracked?.action==='prepare'?byteText+'؛ ملفات تحقق منها: '+(tracked.verifiedFiles?.length||0):progress.denoiseTotal!==null?'خطوات التوليد: '+progress.denoiseCompleted+' / '+progress.denoiseTotal+' ('+progress.percent+'٪) — فك الفيديو والحفظ لاحقاً':progress.completed!==null?'خطوات المرحلة: '+progress.completed+' / '+progress.steps:'المراحل المكتملة: '+progress.done+' / '+progress.total+'؛ لا تمثل نسبة الزمن';
 el('liveError').hidden=!progress.error;el('liveError').textContent=progress.error||'';
 el('progressHint').textContent=progress.cancelled?'تأكد توقف الموارد؛ لا توجد إعادة محاولة تلقائية.':progress.finished?(progress.finishedType==='video'?'انتهى إنشاء الفيديو. بقاء GPU جاهزاً حالة منفصلة وقد يُحاسب عليها.':'انتهت مهمة CPU وتأكد توقف مواردها؛ التخزين الدائم يبقى.'):progress.idle?'لا توجد عملية توليد قيد التنفيذ.':'الوقت المتبقي: غير معروف. الأرقام تتغير فقط عند وصول خطوات فعلية.';
 el('engineStatus').textContent=view.title;el('statusDetail').textContent=view.detail;el('statusOrb').className='status-orb '+view.state;
 el('powerToggle').textContent=view.action==='stop'?'إيقاف':view.action==='reconcile'?'تحقق من الإيقاف':view.action==='prepare'?'تجهيز الحساب':view.action==='activate'?'حفظ والبدء':'تشغيل';
 el('powerToggle').className='power-toggle'+(view.action==='stop'?' danger':'');el('powerToggle').disabled=busy||!view.action||view.state==='stopping'&&view.action!=='reconcile';
 el('paidState').textContent=snapshot.allowPaid?'كل تشغيل يحتاج مراجعة الكلفة وموافقتك.':'التشغيل المدفوع مقفل حالياً؛ يمكن عرض الخطة فقط.';
 const resource=(tracked?.action==='prepare'?tracked:view.start)||[...view.jobs].reverse().find(j=>j.action==='start'),stopAt=resource?.cloudStopped?(resource.stoppedAt||resource.finishedAt||resource.updatedAt):Date.now(),seconds=resource?.startedAt?Math.max(0,(stopAt-resource.startedAt)/1000):0;
 const recorded=resource?.result?.recordedCost||view.active?.cleanup?.recordedCost||view.video?.result?.recordedCost;
 const estimateUSD=resource?.action==='prepare'&&!resource.cloudStopped?resource.estimate?.resourceWindowUSD:resource?.estimatedUSD??(Number.isFinite(resource?.estimate?.rate)?seconds*resource.estimate.rate:null);
 el('elapsed').textContent=resource?seconds.toFixed(0)+' ثانية':'—';
 el('cost').textContent=resource?(Number.isFinite(estimateUSD)?'$'+estimateUSD.toFixed(4)+(resource.action==='prepare'&&!resource.cloudStopped?' (نافذة حوسبة الحسابين)':''):'غير معروفة')+' / '+(recorded?'$'+recorded.usd:'غير متاحة'):'—';
 const gpu=(resource?.settings?.gpu||values().gpu)==='L40S'?'L40S · 48GB':'RTX PRO 6000 · 96GB';
 el('gpuName').textContent=gpu+(resource?.action==='prepare'?' — مختار؛ التجهيز CPU فقط':'');
 const inFlight=['preparing','ready','generating','settingup','stopping','uncertain'].includes(view.state);el('preparation').hidden=!inFlight||progress.idle;el('phaseTitle').textContent=view.state==='settingup'?'مراحل تجهيز الحساب':tracked?.action==='generate'?'مراحل إنشاء الفيديو':'مراحل تجهيز المحرك';
 const steps=model.stages(tracked);el('stages').replaceChildren();for(const step of steps){const item=document.createElement('li');item.className=step.status;item.textContent=step.label;el('stages').append(item);}
 const last=tracked?.events?.at(-1);el('phaseSpinner').hidden=progress.finished||progress.idle||!['preparing','settingup','stopping'].includes(view.state);el('phaseCounter').textContent=steps.filter(s=>s.status==='done').length+' / '+steps.length+' مراحل مؤكدة';
 el('phaseDetail').textContent=last?.kind==='progress'&&last.total>0?last.completed+' / '+last.total+' — تقدم هذه المرحلة فقط':view.state==='ready'?'ورد تأكيد الجاهزية الفعلي من GPU.':'لا توجد نسبة إجمالية مصطنعة؛ المتبقي غير معروف.';

}
async function prepareQuote(kind,probeOnly=false,verifyOnly=false){
 if(!view?.account)throw Error('الحساب الأساسي يحتاج تفويضاً آمناً على الخادم.');
 const input={action:kind,accountId:view.account.id,settings:values()};
 if(kind==='prepare'&&probeOnly)input.probeOnly=true;
 if(kind==='prepare'&&verifyOnly)input.verifyOnly=true;
 quote=await api.request('quote',input);
 const cloud=quote.plan?.transport==='modal-cpu-cloud';
 let lines;
 if(kind==='prepare'){
  const plan=quote.plan,verify=plan.mode==='verify-only',probe=plan.mode==='probe';
  lines=[verify?'فحص الأوزان الموجودة فقط — لا نقل ولا GPU':labels[kind],
   'الحساب المقصود: '+view.account.workspace,
   probe?'اختبار 64KiB فقط؛ لا ينقل النموذج ولا يعلن الحساب جاهزاً.':verify?'نفحص بصمات الموجود داخل حساب الوجهة؛ لا نحذف أو نرفع أي وزن.':'الملفات الناقصة: '+plan.files.length+'، الحجم '+gib(plan.requiredBytes),
   'الحساب الأساسي وأوزانه لا تُحذف أو تُعدّل.'];
  if(cloud){
   lines.push('المسار الجديد: نسخ من المصدر السحابي وفحص SHA256 محلياً قرب Volume الوجهة؛ لا تمر الأوزان بقرص HostHatch.',
    'CPU المصدر: 2 CPU و4 GiB RAM؛ مهلة '+plan.compute.timeoutSeconds+' ثانية.',
    'استدعاءات فحص CPU في حساب الوجهة: '+plan.compute.destination.calls+'؛ لكل منها 2 CPU و4 GiB RAM ومهلة 600 ثانية.',
    'تقدير نافذة الحوسبة للحسابين معاً $'+plan.compute.resourceWindowUSD.toFixed(4)+'؛ ليس سقف فاتورة.',
    plan.destinationVerifierMayDeploy?'أول تجهيز لهذا الحساب قد ينشئ تطبيق فحص CPU وVolume إذا كان النقل الكامل يحتاجه. بناء صورة العامل وتخزينه كلفتهما غير معروفة ومنفصلة؛ لا GPU.':'هذا الاختبار الصغير لا يثبت سرعة فحص الأوزان الكبيرة.',
    'رسوم النقل والتخزين والحصص المجانية غير متحققة. تقدير الحوسبة لا يشملها.',
    plan.workerReady?'العامل يطابق نسخة البروتوكول الجديدة.':'التنفيذ محجوب: يلزم نشر نسخة العامل الجديدة بموافقة منفصلة؛ لا نقل بالخلفية.');
  }else lines.push('المسار القديم يستخدم قرص HostHatch مؤقتاً. المطلوب '+gib(plan.localStagingRequiredBytes)+'؛ المتاح '+gib(plan.localStagingAvailableBytes));
  if(!verify&&!probe)lines.push('سعر قائمة التخزين نحو $'+plan.storageUSDPerMonth.toFixed(2)+' شهرياً قبل الحصص؛ لا يعاد النقل كل شهر.');
 }else lines=[labels[kind],'الحساب: '+view.account.workspace,'GPU: '+quote.settings.gpu,
  'الأبعاد: '+quote.quality.width+'×'+quote.quality.height,
  Number.isFinite(quote.estimate.resourceWindowUSD)?'تقدير نافذة الجلسة الحالية: $'+quote.estimate.resourceWindowUSD.toFixed(4):'المدة والكلفة النهائية غير معروفتين مسبقاً؛ متابعة وإيقاف يدويان.',
  'معدل الموارد التقديري: $'+(quote.estimate.rate*60).toFixed(4)+' للدقيقة. ليس فاتورة نهائية.',
  quote.settings.budget===0?'لا يوجد حد مالي مخصص لهذه المهمة داخل التطبيق.':'الجلسة الحالية تحتفظ بإعدادات تشغيلها السابقة حتى تتوقف.',
  'الخمول مدفوع ويتوقف بعد 20 دقيقة؛ زر إيقاف يحرر الموارد. تبقى مهلة Modal التقنية؛ البناء والتخزين والنقل قد تضاف.'];
 if(!quote.paidEnabled)lines.push('التنفيذ المدفوع مقفل بالخادم.');quote.canExecute=quote.paidEnabled&&(kind!=='prepare'||(cloud?quote.plan.executionReady:quote.plan.localStagingReady));
 el('approvedText').hidden=kind!=='generate';el('sentPrompt').textContent=quote.prompt||'';
 el('quote').textContent=lines.join('\n');el('execute').disabled=!quote.canExecute;el('approval').showModal();
}
el('powerToggle').onclick=()=>action(async()=>{
 if(view.action==='start'){await prepareQuote('start');return;}
 if(view.action==='prepare'){await prepareQuote('prepare');return;}
 if(view.action==='activate'){await api.request('accounts/'+view.account.id+'/activate',{});await api.request('selection',{accountId:view.account.id,settings:values()});notice('انحفظ الحساب وأصبح متاحاً من قائمة الحسابات؛ اضغط تشغيل عند الحاجة.');return;}
 const job=view.active;if(!job)return;
 if(view.action==='reconcile'){const check=await api.request('jobs/'+job.id+'/reconcile',{});if(!check.cloudStopped)await api.request('jobs/'+job.id+'/stop',{confirmCancel:true});notice('تم فحص الموارد وطلب إيقاف المتبقي منها، دون تشغيل جديد.');return;}
 await api.request('jobs/'+job.id+'/stop',{confirmCancel:true});notice('أُرسل طلب الإيقاف. ننتظر تأكيد توقف الموارد.');
});
el('approve').onsubmit=event=>{event.preventDefault();if(!quote?.canExecute||busy)return;action(async()=>{el('execute').disabled=true;try{const result=await api.request('execute',{quoteId:quote.id,approvedCost:true});el('approval').close();notice('سُجلت مهمة واحدة. الحالة تُحدث من الخادم.');}finally{el('execute').disabled=!quote?.canExecute;}});};
el('cancelQuote').onclick=()=>el('approval').close();
el('accountSelect').onchange=()=>action(async()=>{const id=el('accountSelect').value;await api.request('selection',{accountId:id,settings:values()});notice('تم فحص الحساب واختياره؛ لم يبدأ GPU أو نقل أوزان.');});
function clearCredentials(){el('modalTokenId').value='';el('modalTokenSecret').value='';}
el('cancelAccount').onclick=()=>{clearCredentials();el('accountDialog').close();};
el('accountDialog').addEventListener('close',clearCredentials);
el('accountForm').onsubmit=event=>{event.preventDefault();action(async()=>{
 const credentials={tokenId:el('modalTokenId').value.trim(),tokenSecret:el('modalTokenSecret').value.trim()};clearCredentials();
 el('saveAccount').disabled=true;el('accountMessage').textContent='جارٍ التحقق من الحساب عبر Modal وحفظ التفويض مشفّراً…';
 try{if(renewingAccount){await api.request('accounts/'+renewingAccount+'/credentials',credentials);el('accountDialog').close();notice('تم التحقق من التفويض الجديد وحفظه مشفّراً دون تغيير الأوزان.');return;}const linked=await api.request('accounts',credentials);await api.request('selection',{accountId:linked.id,settings:values()});el('accountDialog').close();await refresh();notice('تم الربط المشفّر. جارٍ فحص خطة التجهيز، دون تنفيذ نقل.');await prepareQuote('prepare');}
 catch(error){el('accountMessage').textContent=model.explainError(error.message);throw error;}
 finally{el('saveAccount').disabled=false;credentials.tokenId='';credentials.tokenSecret='';}
});};
api.session().then(async()=>{await refresh();notice('اختر الحساب ثم شغّل المحرك؛ التوليد والنقاش داخل صناعة فيلم كامل.');}).catch(error=>{notice(model.explainError(error.message));if(!snapshot){el('accountSelect').options[0].textContent='تعذر جلب الحسابات — الخلفية غير متصلة';el('engineStatus').textContent='الخلفية غير متصلة';el('statusDetail').textContent='لم يتم جلب بيانات الحسابات من الخادم. هذا لا يعني حذف الحسابات المحفوظة.';}});
setInterval(()=>{if(snapshot&&!busy)refresh().catch(error=>notice(model.explainError(error.message)));},2000);setInterval(()=>{if(snapshot&&!busy)render();},1000);
