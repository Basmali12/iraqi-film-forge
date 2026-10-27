"use strict";
const $=id=>document.getElementById(id);
const OR="https://openrouter.ai/api/v1";
const VIDEO="heygen/heygen-video-1";
const PLAN_MODEL="openai/gpt-4.1-mini";
const STORAGE="iff-director-v1";
let projects=[],active=null,settings={router:"",openai:"",backend:"",provider:"router"},working=false,stopping=false,previewUrl=null;
function state(id,message){$(id).textContent=message}
function err(e){return String(e?.message||e).slice(0,420)}
function uid(){return "story-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8)}
function selected(){return projects.find(p=>p.id===active)}
function persist(){localStorage.setItem(STORAGE,JSON.stringify({projects,active}))}
function safeText(s){return String(s||"").slice(0,20000)}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
const toClock=n=>String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0");
function newStory(){
 const p={id:uid(),name:"قصة جديدة",messages:[{role:"assistant",content:"هلا بيك. احچيلي فكرة فيلمك: شنو القصة، الشخصيات، الأسلوب (أنمي أو واقعي)، والمدة القصوى؟ وخل نثبت الصور قبل ما نفكر بالتوليد."}],assets:[],random:false,plan:null,approved:false,created:Date.now()};
 projects.unshift(p);active=p.id;persist();render();$("messageText").focus();
}
function render(){
 const p=selected();if(!p)return;
 $("stories").replaceChildren();
 for(const story of projects){
  const b=document.createElement("div");b.className="story-item"+(story.id===active?" active":"");b.textContent=story.name;
  b.onclick=()=>{if(working)return;active=story.id;persist();render()};$("stories").append(b);
 }
 $("storyName").textContent=p.name;
 $("messages").replaceChildren();
 for(const m of p.messages){const b=document.createElement("div");b.className="chat-bubble "+m.role;b.textContent=m.content;$("messages").append(b)}
 $("messages").scrollTop=$("messages").scrollHeight;
 $("randomImages").checked=!!p.random;
 $("videoEngine").value=p.videoProvider||"heygen";
 $("phaseLabel").textContent=p.approved?"إنتاج معتمد":p.plan?"التقرير جاهز":"نقاش";
 $("reportSection").hidden=!p.plan;
 $("production").hidden=!p.approved;
 renderAssets();renderPlan();renderProgress()
}
function db(){return new Promise((ok,no)=>{const r=indexedDB.open("iff-director-assets-v1",1);r.onupgradeneeded=()=>r.result.createObjectStore("assets");r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)})}
async function putData(k,v){const d=await db();try{await new Promise((ok,no)=>{const t=d.transaction("assets","readwrite");t.objectStore("assets").put(v,k);t.oncomplete=ok;t.onerror=()=>no(t.error)})}finally{d.close()}}
async function getData(k){const d=await db();try{return await new Promise((ok,no)=>{const t=d.transaction("assets","readonly").objectStore("assets").get(k);t.onsuccess=()=>ok(t.result);t.onerror=()=>no(t.error)})}finally{d.close()}}
async function removeData(k){const d=await db();try{await new Promise((ok,no)=>{const t=d.transaction("assets","readwrite");t.objectStore("assets").delete(k);t.oncomplete=ok;t.onerror=()=>no(t.error)})}finally{d.close()}}
function picture(file){return new Promise((ok,no)=>{
 const url=URL.createObjectURL(file),img=new Image();
 img.onload=()=>{
  try{const c=document.createElement("canvas"),scale=Math.min(1,1024/Math.max(img.width,img.height));
   c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
   c.getContext("2d").drawImage(img,0,0,c.width,c.height);ok(c.toDataURL("image/jpeg",.82))}
  catch(e){no(e)}finally{URL.revokeObjectURL(url)}
 };img.onerror=()=>{URL.revokeObjectURL(url);no(Error("تعذر قراءة الصورة"))};img.src=url;
 })}
async function renderAssets(){
 const p=selected();if(!p)return;$("assets").replaceChildren();
 for(const a of p.assets){
  const card=document.createElement("div");card.className="asset";
  const img=document.createElement("img");img.alt=a.name;const stored=await getData(a.id).catch(()=>null);if(stored)img.src=stored;
  const label=document.createElement("small");label.textContent=a.name;
  const del=document.createElement("button");del.textContent="حذف";
  del.onclick=async()=>{if(working)return;await removeData(a.id);p.assets=p.assets.filter(x=>x.id!==a.id);invalidate(p);persist();render()};
  card.append(img,label,del);$("assets").append(card);
 }
}
function invalidate(p){if(p.plan?.videoProvider==="modal"&&p.plan.slots.some(s=>s.jobId))return;p.plan=null;p.approved=false;p.jobs=null}
$("newStory").onclick=newStory;
$("assetFiles").onchange=async()=>{
 const p=selected();if(!p||working)return;
 const files=Array.from($("assetFiles").files||[]);
 try{
  for(const file of files.slice(0,Math.max(0,8-p.assets.length))){
   if(!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>8_000_000)throw Error("استخدم JPEG/PNG/WebP بحجم حتى 8MB");
   const image=await picture(file),id=p.id+"-asset-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);
   await putData(id,image);
   p.assets.push({id,name:file.name});
  }
  invalidate(p);persist();render();
  state("chatStatus","✓ حفظت صور القصة بهذا الجهاز. راجعها قبل تخطيط الفيلم.");
 }catch(e){state("chatStatus",err(e))}finally{$("assetFiles").value=""}
};
$("randomImages").onchange=()=>{const p=selected();if(!p)return;p.random=$("randomImages").checked;invalidate(p);persist()};
$("settingsBtn").onclick=()=>{$("settingsPanel").hidden=!$("settingsPanel").hidden};
$("closeSettings").onclick=()=>{$("settingsPanel").hidden=true};
$("applySettings").onclick=()=>{
 settings.router=$("routerKey").value.trim();settings.openai=$("openaiKey").value.trim();
 settings.backend=$("backendUrl").value.trim().replace(/\/$/,"");
 settings.provider=$("provider").value;
 if($("modalBackendUrl").value.trim()){try{window.EngineAPI.setBase($("modalBackendUrl").value.trim());window.EngineAPI.session().then(()=>{const link=document.querySelector("[data-engine-admin]");if(link)link.hidden=false;}).catch(()=>{});}catch(e){return state("settingsStatus",err(e));}}
 if(settings.backend&&!/^https:\/\//.test(settings.backend))return state("settingsStatus","عنوان السيرفر لازم HTTPS");
 state("settingsStatus",settings.provider==="openai"?"تم حفظ إعدادات OpenAI بالذاكرة مؤقتاً. تشغيله يحتاج خادم وسيط خاص بالمشروع.":"تم حفظ مفتاح OpenRouter بالذاكرة فقط");
 $("routerKey").value="";$("openaiKey").value="";$("settingsPanel").hidden=true;
};
$("clearSettings").onclick=()=>{settings={router:"",openai:"",backend:"",provider:"router"};$("routerKey").value="";$("openaiKey").value="";state("settingsStatus","تم فصل المفاتيح")};
async function invokeChat(system,messages,json=false,maxTokens=1700){
 if(settings.provider==="openai"){
  if(!settings.openai||!settings.backend)throw Error("لتشغيل OpenAI يلزم مفتاح OpenAI وخادمك الخاص HTTPS في الإعدادات. لا نرسل المفتاح مباشرة من GitHub Pages.");
  const r=await fetch(settings.backend+"/api/director/chat",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+settings.openai},body:JSON.stringify({model:"gpt-4.1-mini",messages:[{role:"system",content:system},...messages],max_tokens:maxTokens,response_format:json?{type:"json_object"}:undefined})});
  if(!r.ok)throw Error("OpenAI proxy HTTP "+r.status+": "+(await r.text()).slice(0,200));
  const j=await r.json();return j.choices?.[0]?.message?.content||"";
 }
 if(!settings.router)throw Error("أضف مفتاح OpenRouter في ⚙️ الإعدادات أولاً");
 const r=await fetch(OR+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+settings.router},body:JSON.stringify({model:PLAN_MODEL,messages:[{role:"system",content:system},...messages],temperature:.25,max_tokens:maxTokens,...(json?{response_format:{type:"json_object"}}:{})})});
 if(!r.ok)throw Error("OpenRouter HTTP "+r.status+": "+(await r.text()).slice(0,250));
 const j=await r.json();return j.choices?.[0]?.message?.content||"";
}
const SYSTEM="You are an Iraqi film director and story development partner. Speak naturally in Iraqi Arabic, short conversational turns. Ask clarifying questions ONE at a time about story, maximum duration, art style, historical identity references, recurring characters, and whether images are available or should be imagined. Preserve all prior story constraints. Do NOT generate videos, claim that images were created, commit to a budget, or assume historical faces are accurately matched. On public historical figures require user-approved references before paid generation. If user says start production, tell them to press 'جهّز تقرير الإنتاج' first. Avoid repeating plot beats.";
$("messageForm").onsubmit=async e=>{
 e.preventDefault();if(working)return;
 const p=selected(),q=$("messageText").value.trim();if(!q)return;
 p.messages.push({role:"user",content:q});$("messageText").value="";
 if(p.name==="قصة جديدة")p.name=q.slice(0,45);
 invalidate(p);persist();render();
 working=true;$("sendMessage").disabled=true;state("chatStatus","المخرج يناقشك الآن…");
 try{
  const result=await invokeChat(SYSTEM,p.messages.filter(m=>m.role==="user"||m.role==="assistant").slice(-16).map(m=>({role:m.role,content:m.content})),false,850);
  if(!result.trim())throw Error("ما وصل رد واضح من المخرج");
  p.messages.push({role:"assistant",content:result});persist();render();state("chatStatus","جاهز تكمل النقاش أو تطلب التقرير.");
 }catch(e){state("chatStatus",err(e))}
 finally{working=false;$("sendMessage").disabled=false}
};
function readJson(raw){
 const cleaned=String(raw).replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\x60{3}\s*$/,"").trim();
 const st=cleaned.indexOf("{"),en=cleaned.lastIndexOf("}");
 if(st<0||en<st)throw Error("ما رجع المساعد تقريراً JSON صالحاً");
 return JSON.parse(cleaned.slice(st,en+1));
}
async function strictJson(system,messages,validator,tokens){
 let last="";
 for(let i=0;i<2;i++){
  const result=await invokeChat(i?system+"\nLAST ATTEMPT WAS INVALID, produce short complete valid JSON only. "+last.slice(0,700):system,messages,true,tokens);
  try{const j=readJson(result);if(validator(j))return j;last="missing fields or chronology"}catch(e){last=err(e)}
 }
 throw Error("المخرج ما جهّز تقريراً زمنياً سليماً؛ ما راح نصرف على توليد خاطئ. "+last);
}
function prepareBeats(p){
 const unit=p.videoProvider==="modal"?10:15;
 const sys="Act as a strict screenwriter. Return JSON object {title, duration_seconds, style, synopsis, beats:[{id,story_event,description,characters}]}. Build one MASTER chronological beat sheet from conversation. Required duration: 30 to 600 seconds, multiple of "+unit+", respecting user's maximum duration. Provide between 3 and 16 beats, covering distinct beginning/middle/end exactly once with no repeat or restart. If history, respect the requested dates without inventing missing verified facts. Style includes anime vs realistic. Character descriptions must respect references; do not claim model will resemble real person solely from name. The last beat MUST be the actual story ending; no generic recap. Images are references and are not generated here.";
 const messages=[{role:"user",content:"Create one full story plan from this conversation:\n"+p.messages.map(m=>(m.role==="user"?"USER: ":"DIRECTOR: ")+m.content).join("\n").slice(-24000)+"\nUser has "+p.assets.length+" uploaded visual reference(s), images random setting: "+p.random+". Images are NOT automatically generated. Return JSON only."}];
 return strictJson(sys,messages,j=>Number.isInteger(j.duration_seconds)&&j.duration_seconds>=30&&j.duration_seconds<=600&&j.duration_seconds%unit===0&&Array.isArray(j.beats)&&j.beats.length>=3&&j.beats.length<=16&&j.beats.every(b=>typeof b.description==="string"&&b.description.length>20),3400);
}
function slotPlan(beats,duration,unit=15){
 const slots=[],n=duration/unit;
 const sizes=beats.map(()=>1);
 // Allocate each beat a contiguous share of the film. Never reshuffle beats in batches.
 if(beats.length>n)throw Error("الأحداث أكثر من عدد مقاطع الفيلم. تحتاج مدة أطول");
 for(let j=0;j<n-beats.length;j++)sizes[j%beats.length]++;
 let time=0;
 for(let k=0;k<beats.length;k++){
  const b=beats[k];
  for(let i=0;i<sizes[k];i++){
   slots.push({index:slots.length+1,beat_index:k,beat_id:String(b.id||"B"+(k+1)),start:time,end:time+unit,
     focus:i===0?"ابدأ حدثاً جديداً":"أكمل نفس الحدث بحركة جديدة دون إعادة المقدمة أو الكلام السابق",
     prompt:"",status:"pending",jobId:null,cost:null});
   time+=unit;
  }
 }
 if(time!==duration||slots.length!==n)throw Error("فشل تثبيت توقيت الفيلم");
 return slots;
}
async function detailSlots(p,beats,slots,style){
 for(let i=0;i<slots.length;i+=6){
  const batch=slots.slice(i,i+6);
  state("chatStatus","صياغة المقاطع "+(i+1)+"–"+Math.min(i+6,slots.length)+" حسب ترتيب الأحداث…");
  const sys="Output JSON {scenes:[{index,beat_id,prompt}]}, EXACTLY "+batch.length+" entries. Every index and beat_id MUST match corresponding slot. The given beat is a LOCKED episode; do NOT recap or repeat previous episodes, do NOT jump backwards in time, do not restart story at each batch. English technical direction, natural original Arabic dialogue, one meaningful action and consequence per "+(p.videoProvider==="modal"?10:15)+" sec shot, visual style: "+style+". Character consistency and voice notes remain fixed. Avoid robotic voice promises. Generate only the specified slots.";
  const user=batch.map(x=>({index:x.index,beat_id:x.beat_id,focus:x.focus,beat:beats[x.beat_index].description,actors:beats[x.beat_index].characters})); 
  const j=await strictJson(sys,[{role:"user",content:JSON.stringify({assigned_only:user,completed_prior:slots.slice(0,i).map(s=>({index:s.index,beat_id:s.beat_id,prompt:s.prompt.slice(0,100)}))})}],
   o=>Array.isArray(o.scenes)&&o.scenes.length===batch.length&&o.scenes.every((sc,k)=>sc.index===batch[k].index&&String(sc.beat_id)===String(batch[k].beat_id)&&typeof sc.prompt==="string"&&sc.prompt.length>40),3500);
  j.scenes.forEach((sc,k)=>batch[k].prompt=sc.prompt);
 }
 if(slots.some(s=>!s.prompt))throw Error("مقطع فارغ؛ لا يبدأ التوليد");
}
$("draftReport").onclick=async()=>{
 if(working)return;const p=selected();
 if(p.plan?.videoProvider==="modal"&&p.plan.slots.some(s=>s.jobId))return state("chatStatus","لهذه الخطة مهام محفوظة. أنشئ قصة جديدة لتغييرها دون المساس بالمشاهد السابقة.");
 if(p.messages.filter(m=>m.role==="user").length<1)return state("chatStatus","احچي مع المخرج عن القصة أولاً");
 if(!confirm("تحضير التقرير يستخدم API النصي برسوم بسيطة محتملة، لكن ما يولّد فيديو. موافق؟"))return;
 working=true;$("draftReport").disabled=true;
 try{
  state("chatStatus","قراءة المحادثة كاملة وبناء خط زمني واحد…");
  const a=await prepareBeats(p),slots=slotPlan(a.beats,a.duration_seconds,p.videoProvider==="modal"?10:15);
  await detailSlots(p,a.beats,slots,a.style||"cinematic");
  p.plan={title:String(a.title||p.name),synopsis:String(a.synopsis||""),style:String(a.style||"cinematic"),
   beats:a.beats,slots,seconds:a.duration_seconds,estimate:a.duration_seconds*.01,quality:"480p",ratio:"9:16",
   videoProvider:p.videoProvider||"heygen",preparedAt:Date.now(),frozenConversationSize:p.messages.length,verified:true};
  if(p.videoProvider==="modal"){p.plan.estimate=0;p.plan.quality="576x1024";p.plan.costPending=true;}
  p.approved=false;p.jobs=null;persist();render();
  state("chatStatus","✓ جاهز التقرير؛ شيك التسلسل والكلفة قبل موافقتك");
  $("reportSection").scrollIntoView({behavior:"smooth"});
 }catch(e){state("chatStatus","خطة الإنتاج لم تُعتمد: "+err(e)+". لا يوجد خصم فيديو.")}
 finally{working=false;$("draftReport").disabled=false}
};
function renderPlan(){
 const p=selected(),plan=p?.plan;if(!plan)return;
 $("planSummary").textContent=plan.title+" — "+plan.synopsis+" | "+plan.style;
 $("sumDuration").textContent=toClock(plan.seconds);
 $("sumClips").textContent=plan.slots.length;
 $("sumPrice").textContent=plan.costPending?"تسعير Modal لكل مشهد قبل التنفيذ":"$"+plan.estimate.toFixed(2)+" تقريباً";
 $("sumBeats").textContent=plan.beats.length;
 $("beatList").replaceChildren();
 plan.beats.forEach((b,i)=>{const div=document.createElement("div");div.className="beat";div.textContent=(i+1)+". "+String(b.story_event||b.id||"")+" — "+b.description;$("beatList").append(div)});
 $("approvePlan").disabled=!!p.approved;
 state("planStatus",p.approved?"✓ وافقت على الخطة، تگدر تتابع الإنتاج.":"بانتظار موافقتك. ماكو فيديو يولد لحد الآن.");
}
$("rejectPlan").onclick=()=>{const p=selected();invalidate(p);persist();render();state("chatStatus","رجعنا للنقاش؛ اكتب التصحيح وجهّز تقريراً جديداً.")};
$("exportPlan").onclick=()=>{const p=selected();if(p.plan)download("film-plan.json",JSON.stringify({name:p.name,plan:p.plan,asset_names:p.assets.map(a=>a.name)},null,2))};
$("approvePlan").onclick=async()=>{
 const p=selected();if(!p?.plan||p.approved)return;
 if(p.plan.frozenConversationSize!==p.messages.length)return state("planStatus","القصة تغيرت بعد التقرير؛ أعد تجهيز التقرير");
 const m=p.plan;
 if(!m.verified||m.slots.length!==m.seconds/(m.videoProvider==="modal"?10:15)||m.slots.some((s,i)=>s.index!==i+1||!s.prompt))
  return state("planStatus","التقرير غير مكتمل زمنياً؛ ما يصير نبدأ التوليد");
 const hasHistorical=/صدام|saddam|historical|تاريخي|أحمد حسن|al.bakr/i.test(p.messages.filter(x=>x.role==="user").map(x=>x.content).join(" "));
 if(hasHistorical&&!p.assets.length&&!p.random)
  return state("planStatus","لتجنب شخصية تاريخية عشوائية: ارفع صورة مرجعية أولاً، أو ناقش المرجع مع المخرج. هذا منع للخصم الخطأ.");
 if(m.videoProvider==="modal"){
  p.approved=true;persist();render();await runProduction(true);return;
 }
 if(!settings.router)return state("planStatus","أضف مفتاح OpenRouter للفيديو من ⚙️ إعدادات المفاتيح");
 if(!confirm("موافقة على إنتاج "+m.slots.length+" مقطعاً، مجموع "+m.seconds+" ثانية. السعر المرجعي يبدأ من $"+m.estimate.toFixed(2)+" عند 480p، ولا يشمل التغيّر بالأسعار أو تكرار الطلب. كل مشهد قد يخصم من OpenRouter. هل توافق؟"))return;
 p.approved=true;persist();render();state("chatStatus","✓ تمت الموافقة. يبدأ الآن توليد المشاهد بالترتيب تلقائياً.");
 $("production").scrollIntoView({behavior:"smooth"});
 await runProduction(true);
};
function pushLog(message){const el=document.createElement("div");el.textContent=new Date().toLocaleTimeString("ar-IQ")+" — "+message;$("productionLog").prepend(el)}
function renderProgress(){
 const p=selected();if(!p?.plan)return;
 const slots=p.plan.slots,done=slots.filter(s=>s.status==="done").length,pct=Math.round(100*done/slots.length);
 $("progressBar").style.width=pct+"%";$("progressValue").textContent=pct+"%";
 $("progressText").textContent=done+" / "+slots.length+" مقاطع اكتملت";
 $("startProduction").disabled=working||done===slots.length;
 $("mergeProduction").disabled=working||done!==slots.length;
}
async function videoApi(route,method="GET",body=null,binary=false){
 if(!settings.router)throw Error("مفتاح OpenRouter مفقود");
 const r=await fetch(OR+route,{method,headers:{"Authorization":"Bearer "+settings.router,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,cache:"no-store"});
 if(!r.ok)throw Error("OpenRouter: "+r.status+" "+(await r.text()).slice(0,280));
 return binary?r.blob():r.json();
}
async function lastImage(blob){
 const u=URL.createObjectURL(blob),v=document.createElement("video");v.muted=true;v.playsInline=true;
 try{
  v.src=u;await new Promise((ok,no)=>{v.onloadedmetadata=ok;v.onerror=()=>no(Error("فشل فتح الفيديو السابق"))});
  v.currentTime=Math.max(0,v.duration-.12);
  await new Promise((ok,no)=>{v.onseeked=ok;v.onerror=()=>no(Error("فشل قراءة آخر فريم"))});
  const c=document.createElement("canvas"),scale=Math.min(1,800/Math.max(v.videoWidth,v.videoHeight));
  c.width=Math.round(v.videoWidth*scale);c.height=Math.round(v.videoHeight*scale);c.getContext("2d").drawImage(v,0,0,c.width,c.height);
  return c.toDataURL("image/jpeg",.8);
 }finally{v.src="";URL.revokeObjectURL(u)}
}
const sleep=t=>new Promise(ok=>setTimeout(ok,t));
async function runProduction(alreadyConfirmed=false){
 const modalProject=selected();
 if(modalProject?.plan?.videoProvider==="modal"){
  if(working||!modalProject.approved)return;working=true;stopping=false;renderProgress();
  try{await window.ModalDirector.run(modalProject,{stopping:()=>stopping,asset:getData,clip:putData,save:()=>{persist();renderProgress();},log:message=>{state("progressText",message);},merge:mergeClips});}
  catch(e){pushLog(err(e));state("chatStatus",err(e));}finally{working=false;renderProgress();}
  return;
 }
 const p=selected();if(!p?.approved||working)return;
 if(!settings.router)return state("chatStatus","مفتاح الفيديو OpenRouter غير موجود");
 if(!alreadyConfirmed&&!confirm("هل تريد بدء أو استئناف مهام HeyGen المدفوعة؟ ماكو إعادة تلقائية لمهمة فاشلة أو مجهولة."))return;
 working=true;stopping=false;renderProgress();pushLog("بداية الإنتاج الآمن");
 try{
  const slots=p.plan.slots;
  for(let i=0;i<slots.length;i++){
   if(stopping){pushLog("تم الإيقاف بين المشاهد");break}
   const s=slots[i];if(s.status==="done")continue;
   if(s.status==="failed"||s.status==="ambiguous")throw Error("المشهد "+(i+1)+" يحتاج فحصاً يدوياً قبل أي إعادة إرسال");
   if(s.status!=="submitted"){
    const knownSpent=slots.reduce((sum,item)=>sum+(typeof item.cost==="number"?item.cost:0),0);
    const estimatedUnknown=slots.filter(item=>item.status==="done"&&typeof item.cost!=="number").length*(p.plan.estimate/slots.length);
    if(knownSpent+estimatedUnknown+(p.plan.estimate/slots.length)>p.plan.estimate*1.30)throw Error("بلغنا سقف أمان تقريبي للصرف (130% من تقدير التقرير). توقّفنا لمراجعة الكلفة قبل المزيد.");
    const payload={model:VIDEO,prompt:s.prompt,duration:15,resolution:p.plan.quality,aspect_ratio:p.plan.ratio};
    if(i>0){
     const previous=await getData(p.id+"-clip-"+(i-1));
     if(!previous)throw Error("ملف المشهد السابق مفقود: لا نكمل من صورة عشوائية");
     payload.frame_images=[{type:"image_url",image_url:{url:await lastImage(previous)},frame_type:"first_frame"}];
    }else if(p.assets.length){
     const image=await getData(p.assets[0].id);
     if(image)payload.frame_images=[{type:"image_url",image_url:{url:image},frame_type:"first_frame"}];
    }
    pushLog("المشهد "+(i+1)+": إرسال أمر HeyGen مدفوع");
    // Mark ambiguous BEFORE submission so network ambiguity never triggers an automatic second payment.
    s.status="ambiguous";persist();renderProgress();
    const job=await videoApi("/videos","POST",payload);
    if(!job.id)throw Error("لم يصل رقم المهمة؛ لا تكرر الإرسال تلقائياً");
    s.jobId=job.id;s.status="submitted";persist();
   }
   pushLog("المشهد "+(i+1)+" — انتظار مهمة "+s.jobId);
   let success=false;
   for(let poll=0;poll<125;poll++){
    const info=await videoApi("/videos/"+encodeURIComponent(s.jobId));
    if(info.status==="completed"){
      const file=await videoApi("/videos/"+encodeURIComponent(s.jobId)+"/content","GET",null,true);
      if(!file.size)throw Error("نتيجة المهمة فارغة");
      await putData(p.id+"-clip-"+i,file);
      s.status="done";s.cost=info.usage?.cost??null;persist();renderProgress();
      pushLog("✓ المشهد "+(i+1)+" اكتمل، حفظناه على جهازك.");success=true;break;
    }
    if(["failed","cancelled","expired"].includes(info.status)){s.status="failed";persist();throw Error("فشل المشهد "+(i+1)+" عند المزود. لا إعادة تلقائية")}
    await sleep(7000);
   }
   if(!success)throw Error("المهمة لم تنتهِ؛ ارجع لاستئناف متابعتها بنفس الرقم، لا تنشئ ثانية");
  }
  if(p.plan.slots.every(s=>s.status==="done")&&!stopping){pushLog("المشاهد اكتملت. بدء دمج MP4");await mergeClips()}
 }catch(e){pushLog("⚠ "+err(e))}
 finally{working=false;renderProgress()}
}
async function mergeClips(){
 const p=selected();if(!p?.plan?.slots.every(s=>s.status==="done"))return pushLog("الدمج يحتاج اكتمال جميع المشاهد");
 if(working&&stopping)return;
 try{
  let files=[];
  for(let i=0;i<p.plan.slots.length;i++){const b=await getData(p.id+"-clip-"+i);if(!b)throw Error("المشهد "+(i+1)+" غير محفوظ");files.push(b)}
  while(files.length>1){
   const next=[];
   for(let i=0;i<files.length;i+=6){
    const group=files.slice(i,i+6);
    if(group.length===1){next.push(group[0]);continue}
    const merged=await window.IraqiFilmStitcher.merge(group,"cut",msg=>pushLog(msg));next.push(merged.blob);
   }
   files=next;
  }
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(files[0]);$("resultVideo").src=previewUrl;$("resultDownload").href=previewUrl;
  $("resultBox").hidden=false;pushLog("✅ فيلم موحّد جاهز MP4 بالصوت، بدون كلفة توليد جديدة");
 }catch(e){pushLog("فشل الدمج المحلي: "+err(e)+". احتفظ بالمقاطع المحفوظة ولا تعيد التوليد.")}
}
$("startProduction").onclick=runProduction;
$("pauseProduction").onclick=()=>{stopping=true;pushLog("طلب الإيقاف — سيتم بعد انتهاء المشهد الجاري")};
$("mergeProduction").onclick=mergeClips;
window.addEventListener("pagehide",()=>{stopping=true});
try{const saved=JSON.parse(localStorage.getItem(STORAGE)||"null");if(saved&&Array.isArray(saved.projects)){projects=saved.projects;active=saved.active}}catch{}
if(!selected())newStory();else render();

$("videoEngine").onchange=()=>{const p=selected();if(!p||working)return;if(p.plan?.slots.some(s=>s.status!=="pending")){ $("videoEngine").value=p.videoProvider||"heygen";return state("chatStatus","المشروع يحتوي مهام سابقة. أنشئ قصة مستقلة للمحرك الآخر حتى تبقى النتائج محفوظة."); }p.videoProvider=$("videoEngine").value;invalidate(p);persist();render();};
$("restoreModal").onclick=async()=>{if(working)return;try{await window.EngineAPI.session();const stored=await window.EngineAPI.request("projects"),remote=await window.EngineAPI.request("state");for(const r of stored){if(projects.some(p=>p.id===r.id))continue;const p={...r.snapshot,assets:[],messages:[{role:"assistant",content:"خطة LTX مستعادة من الخادم؛ المراجع الأصلية على جهازها، ونتائج المشاهد تبقى بالخادم."}],videoProvider:"modal",approved:true};const refs=await window.EngineAPI.request("projects/"+p.id+"/references");for(const ref of refs){const response=await fetch(window.EngineAPI.base+"/api/engine/projects/"+p.id+"/references/"+ref.id,{credentials:"include",redirect:"error"});if(!response.ok)throw Error("تعذر استرجاع مرجع محفوظ");const blob=await response.blob(),data=await new Promise((ok,no)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result);reader.onerror=no;reader.readAsDataURL(blob);});await putData(ref.assetId,data);p.assets.push({id:ref.assetId,name:ref.name});}const scenes=await window.EngineAPI.request("projects/"+p.id+"/scenes");for(const slot of p.plan.slots){const saved=scenes.find(s=>s.sceneId==="scene-"+slot.index);const job=saved?{id:saved.jobId}:remote.jobs.find(j=>j.projectId===p.id&&j.sceneId==="scene-"+slot.index);if(job){slot.jobId=job.id;slot.status="submitted";}}projects.push(p);}persist();render();state("chatStatus","تم استرجاع الخطط دون حذف أو استبدال أي مشروع موجود. استئناف المشهد المكتمل ينزّل نتيجته ولا يعيد توليده.");}catch(e){state("chatStatus",err(e));}};
