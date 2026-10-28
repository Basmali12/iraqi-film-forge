/* Shared authenticated server-side OpenAI integration. Never returns or persists a key in browser storage. */
(function(root){
 'use strict';
 const api=()=>root.EngineAPI,node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 const errors={OPENAI_KEY_REQUIRED:'احفظ مفتاح أوبن أي من الإعدادات أولاً.',OPENAI_KEY_INVALID:'المفتاح غير صالح أو أُلغي؛ راجعه من إعدادات أوبن أي.',OPENAI_ACCESS_DENIED:'الحساب غير مخوّل لهذا الطلب.',OPENAI_MODEL_UNAVAILABLE:'موديل GPT-6 Luna غير متاح لهذا الحساب؛ لم نبدّل إلى موديل آخر.',OPENAI_RATE_OR_CREDIT_LIMIT:'رصيد OpenAI غير كافٍ أو وصل حد الطلبات؛ لا إعادة تلقائية.',OPENAI_CONNECTION_UNCERTAIN_NO_RETRY:'انقطع الاتصال وقد يكون الطلب احتُسب. لا نعيده تلقائياً.',OPENAI_INTERRUPTED_NO_AUTOMATIC_RETRY:'أُعيد تشغيل الخادم؛ حالة الطلب تحتاج مراجعة دون إعادة تلقائية.',TEXT_MONTHLY_LIMIT_EXCEEDED:'بلغت حد النص الشهري داخل التطبيق. راجع الإعدادات.',ONE_TEXT_REQUEST_AT_A_TIME:'يوجد طلب نصي جارٍ؛ انتظر حتى ينتهي.',OPENAI_INCOMPLETE_OUTPUT_NO_RETRY:'الرد غير مكتمل ضمن حد النص؛ لا إعادة تلقائية.'};
 function message(e){return errors[e.code||e.error]||'تعذر إتمام طلب OpenAI. لا تشغيل GPU ولا إعادة تلقائية. '+String(e.code||e.error||'');}
 let current=null;async function config(){await api().session();current=await api().request('llm/config');return current;}
 async function follow(id,log=()=>{}){for(let i=0;i<190;i++){const r=await api().request('llm/calls/'+id);if(r.status==='completed'){sessionStorage.removeItem('iff-text-request');return r;}if(['failed','uncertain'].includes(r.status)){sessionStorage.removeItem('iff-text-request');const e=new Error(message(r));e.code=r.error;throw e;}log('المخرج يكتب فعلياً… الوقت المتبقي غير معروف.');await new Promise(resolve=>setTimeout(resolve,1000));}throw Error('توقف الانتظار المحلي. الطلب محفوظ ولا نعيد إرساله؛ استخدم متابعة الطلب السابق.');}
 async function call(mode,messages,{projectId='prompt-studio',instruction='',maxTokens=3500,log=()=>{}}={}){
  const c=await config();if(!c.configured)throw Error(errors.OPENAI_KEY_REQUIRED);
  if(sessionStorage.getItem('iff-text-request'))throw Error('عندك طلب نصي محفوظ؛ اضغط متابعة الطلب السابق قبل إرسال طلب آخر.');
  const requestId=crypto.randomUUID();sessionStorage.setItem('iff-text-request',requestId);
  try{await api().request('llm/calls',{requestId,projectId,mode,messages,instruction,maxTokens,approvedTextCost:true});return await follow(requestId,log);}catch(e){if(e.code&&e.code!=='OPENAI_CONNECTION_UNCERTAIN_NO_RETRY')sessionStorage.removeItem('iff-text-request');if(e.code)e.message=message(e);throw e;}
 }
 root.AIStudio={config,call,follow,message};
})(window);
