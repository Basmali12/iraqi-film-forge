"use strict";
const $=id=>document.getElementById(id);
const STORAGE="iff-director-v1";
let projects=[],active=null,working=false,stopping=false,previewUrl=null;
function state(id,message){$(id).textContent=message}
function err(e){return String(e?.message||e).replace(/(?:sk-|ak-|as-)[A-Za-z0-9_-]{12,}/g,'[مفتاح مخفي]').slice(0,420)}
function uid(){return "story-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8)}
function pIsArchive(p){return !!p&&((p.videoProvider&&p.videoProvider!=='modal')||(p.plan?.videoProvider&&p.plan.videoProvider!=='modal'));}
function selected(){return projects.find(p=>p.id===active)}
let serverSyncEnabled=false,serverSyncTimer=null,serverWrites=Promise.resolve();
function persist(){localStorage.setItem(STORAGE,JSON.stringify({projects,active}));if(serverSyncEnabled){clearTimeout(serverSyncTimer);serverSyncTimer=setTimeout(()=>saveServerDraft().catch(()=>{}),750);}}
function safeText(s){return String(s||"").slice(0,20000)}
function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
const toClock=n=>String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0");
function newStory(){ if(working)return;
 const p={id:uid(),name:"قصة جديدة",videoProvider:'modal',messages:[{role:"assistant",content:"هلا بيك. احچيلي فكرة فيلمك والأسلوب: واقعي، أنمي أو ثلاثي الأبعاد؟ إذا عندك مدة ببالك اذكرها، وإلا أقترحها قبل كتابة المشاهد. نحدد الشخصيات والحوار والمراجع، وما أعتبر الوجوه مثبتة أو الصور مصممة قبل تنفيذها فعلياً."}],assets:[],random:false,plan:null,approved:false,created:Date.now()};
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
 $("videoEngine").value=p.videoProvider||"modal";
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
function invalidate(p){if(pIsArchive(p))return;if(p.plan?.videoProvider==="modal"&&p.plan.slots.some(s=>s.jobId))return;p.plan=null;p.approved=false;p.jobs=null;p.chatStartOffer=null}
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
async function invokeChat(system,messages,json=false,maxTokens=1700){
 if(pIsArchive(selected()))throw Error("هذا مشروع أرشيفي؛ أنشئ قصة جديدة للتوليد بالمحرك الحالي.");
 if(!window.AIStudio)throw Error("حدّث الصفحة لتحميل إعدادات OpenAI الآمنة.");
 const p=selected(),mode=!json?'discuss':system.startsWith('Act as a strict')?'outline':'details';
 const r=await window.AIStudio.call(mode,messages,{projectId:p.id,instruction:system,maxTokens,log:m=>state('chatStatus',m)});
 if(r.discussion){p.directorState=r.discussion;serverSyncEnabled=true;persist();return r.discussion.reply+(r.discussion.proposed_duration_seconds?'\nالمدة المقترحة للفيلم: '+r.discussion.proposed_duration_seconds+' ثانية.':'');}
 return r.text;
}
const SYSTEM="Discuss the film in Iraqi Arabic. Propose total duration before writing a full script, honoring any requested minutes. Distinguish live action, 3D and anime. Explain portrait design is a text description only, references/voice conditioning unavailable until actually configured. Do not claim a license, exact historical likeness, generated images, or a completed video. If the user agrees to a previously proposed duration and asks to start writing, set ready_to_write true; this authorizes text planning only, never video. Ask one useful question at a time. Keep exact props, named speakers and listener silence. Suggested duration should align to 10-second scene windows for Modal, not restrict the whole film to ten seconds.";
$("messageForm").onsubmit=async e=>{
 e.preventDefault();if(working)return;
 let p=selected();const q=$("messageText").value.trim();if(!q)return;if(pIsArchive(p))return state("chatStatus","المشروع أرشيفي؛ أنشئ قصة جديدة للنقاش أو التوليد.");
 if(window.FilmChatStart?.isCommand(q)&&window.FilmChatStart.needsFork(p)){
  const next=window.FilmChatStart.forkDiscussion(p,uid());projects.unshift(next);active=next.id;p=next;persist();render();
 }
 if(window.FilmChatStart?.isCommand(q)&&!p.plan&&p.messages.some(m=>m.role==='user')){
  p.messages.push({role:'user',content:q});$("messageText").value='';persist();render();await draftPlan(true);return;
 }
 if(window.FilmChatStart?.isCommand(q)&&p.plan){
  working=true;$("sendMessage").disabled=true;$("messageText").value="";
  try{p.messages.push({role:"user",content:q});await prepareChatOffer(p);$("reportSection").scrollIntoView({behavior:"smooth"});}
  catch(e){state("chatStatus",err(e));}finally{working=false;$("sendMessage").disabled=false;renderProgress();}return;
 }
 p.messages.push({role:"user",content:q});$("messageText").value="";
 if(p.name==="قصة جديدة")p.name=q.slice(0,45);
 invalidate(p);persist();render();
 working=true;$("sendMessage").disabled=true;state("chatStatus","المخرج يناقشك الآن…");
 try{
  const result=await invokeChat(SYSTEM,p.messages.filter(m=>m.role==="user"||m.role==="assistant").slice(-80).map(m=>({role:m.role,content:m.content})),false,850);
  if(!result.trim())throw Error("ما وصل رد واضح من المخرج");
  p.messages.push({role:"assistant",content:result});persist();render();state("chatStatus","جاهز تكمل النقاش أو تطلب التقرير.");
 }catch(e){state("chatStatus",err(e))}
 finally{working=false;$("sendMessage").disabled=false}
 if(p.directorState?.ready_to_write){p.directorState.ready_to_write=false;persist();await draftPlan(true);}
};
function readJson(raw){
 const cleaned=String(raw).replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\x60{3}\s*$/,"").trim();
 const st=cleaned.indexOf("{"),en=cleaned.lastIndexOf("}");
 if(st<0||en<st)throw Error("ما رجع المساعد تقريراً JSON صالحاً");
 return JSON.parse(cleaned.slice(st,en+1));
}
async function strictJson(system,messages,validator,tokens){
 let last="";
 for(let i=0;i<1;i++){
  const result=await invokeChat(i?system+"\nLAST ATTEMPT WAS INVALID, produce short complete valid JSON only. "+last.slice(0,700):system,messages,true,tokens);
  try{const j=readJson(result);if(validator(j))return j;last="missing fields or chronology"}catch(e){last=err(e)}
 }
 throw Error("المخرج ما جهّز تقريراً زمنياً سليماً؛ ما راح نصرف على توليد خاطئ. "+last);
}
function prepareBeats(p){
 const unit=10;
 const agreed=p.directorState?.proposed_duration_seconds;
 const sys="Act as a strict screenwriter. Return JSON object {title, duration_seconds, style, synopsis, beats:[{id,story_event,description,characters}]}. Build one MASTER chronological beat sheet from conversation. Total duration 10 to 3600 seconds, multiple of "+unit+", respecting user's maximum duration. "+(agreed?'Agreed duration is exactly '+agreed+' seconds; do not silently change it. ':'')+"Provide 1 to 48 beats, no more than number of scene windows, covering distinct beginning/middle/end exactly once with no repeat or restart. Do not invent verified historical facts. Match anime vs realistic style. No claim of guaranteed face matching. Last beat must be story ending. No images generated here.";
 const messages=[{role:"user",content:"Create one full story plan from this conversation:\n"+(p.directorState?.continuity_notes ? [{role:"assistant",content:"Agreed continuity notes: "+p.directorState.continuity_notes},...p.messages] : p.messages).map(m=>(m.role==="user"?"USER: ":"DIRECTOR: ")+m.content).join("\n").slice(-24000)+"\nUser has "+p.assets.length+" uploaded visual reference(s), images random setting: "+p.random+". Images are NOT automatically generated. Return JSON only."}];
 return strictJson(sys,messages,j=>Number.isInteger(j.duration_seconds)&&j.duration_seconds>=unit&&j.duration_seconds<=3600&&j.duration_seconds%unit===0&&(!agreed||j.duration_seconds===agreed)&&Array.isArray(j.beats)&&j.beats.length>=1&&j.beats.length<=48&&j.beats.every(b=>typeof b.description==="string"&&b.description.length>20),5000);
}
function slotPlan(beats,duration,unit=10){
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
 if(!window.ArabicDialogue)throw Error("حدّث الصفحة لتحميل قواعد الحوار العربي");
 const userRequests=p.messages.filter(m=>m.role==="user").map(m=>m.content).join("\n");
 // Only a user's explicit request can allow an intentionally silent scene.
 const silenceAllowed=/(?:بدون\s+(?:حوار|كلام)|(?:مشهد|فيلم|فيديو)\s+صامت|بلا\s+حوار|no\s+(?:dialogue|speech)|silent\s+(?:scene|film))/iu.test(userRequests);
 for(let i=0;i<slots.length;i+=6){
  const batch=slots.slice(i,i+6);
  state("chatStatus","كتابة الأحداث والجمل العربية للمقاطع "+(i+1)+"–"+Math.min(i+6,slots.length)+"…");
  const sys="Output JSON {scenes:[{index,beat_id,prompt,audioContract:{language:'ar',dialect:'iraqi',mode:'dialogue',lines:[{speaker,text}]}}]}, EXACTLY "+batch.length+" entries. Use valid JSON with double-quoted keys. Every index and beat_id MUST match its slot. The beat is LOCKED: do not recap, repeat completed lines or events, restart the story or reverse cause and effect. prompt is ONLY English visual/action/camera and nonverbal sound direction, no quotes, no speech instructions and no dialogue text. Each 10-second scene MUST have 1 to 3 short complete coherent Arabic-script spoken lines, <=26 Arabic words TOTAL. Arabic speech is mandatory even if the user omitted a language; default natural IRAQI colloquial, but preserve an explicitly requested Arabic dialect or formal Arabic (dialect values iraqi/msa/egyptian/gulf/levantine/maghrebi). Never Latin/Arabizi transliteration or fragments of disconnected letters. speaker must name and physically identify exactly who speaks; use consistent actor descriptions/voice traits across scenes; different characters never ask and answer each other's lines. Write the actual finished sentences, not placeholders. No improvisation, foreign words, subtitles or on-screen lettering. A silent opening is NOT the default. "+(silenceAllowed?"An explicitly requested silent scene may instead use mode:'silent',silenceRequested:true,lines:[].":"Silent mode is forbidden because user did not request silence.")+" Visual style: "+style+". Only output the assigned slots. Native LTX original audio only.";
  const user=batch.map(x=>({index:x.index,beat_id:x.beat_id,focus:x.focus,beat:beats[x.beat_index].description,actors:beats[x.beat_index].characters}));
  const j=await strictJson(sys,[{role:"user",content:JSON.stringify({user_requests:userRequests.slice(-18000),assigned_only:user,completed_prior:slots.slice(0,i).map(s=>({index:s.index,beat_id:s.beat_id,audioContract:s.audioContract,prompt:s.prompt.slice(0,120)}))})}],
   o=>Array.isArray(o.scenes)&&o.scenes.length===batch.length&&o.scenes.every((sc,k)=>{
    if(sc.index!==batch[k].index||String(sc.beat_id)!==String(batch[k].beat_id)||typeof sc.prompt!=="string"||sc.prompt.length<40)return false;
    window.ArabicDialogue.validate(sc.audioContract,{silenceAllowed});window.ArabicDialogue.checkPrompt(sc.prompt,sc.audioContract);return true;
   }),5500);
  j.scenes.forEach((sc,k)=>{batch[k].prompt=sc.prompt;batch[k].audioContract=window.ArabicDialogue.validate(sc.audioContract,{silenceAllowed});});
 }
 if(slots.some(s=>!s.prompt||!s.audioContract))throw Error("مقطع أو حوار ناقص؛ لا يبدأ التوليد");
}
async function draftPlan(fromDiscussion=false){
 if(working)return;const p=selected();if(pIsArchive(p))return state("chatStatus","هذا مشروع أرشيفي محفوظ؛ أنشئ قصة جديدة لكتابة أو توليد فيلم.");
 if(p.plan?.videoProvider==="modal"&&p.plan.slots.some(s=>s.jobId))return state("chatStatus","لهذه الخطة مهام محفوظة. أنشئ قصة جديدة لتغييرها دون المساس بالمشاهد السابقة.");
 if(p.messages.filter(m=>m.role==="user").length<1)return state("chatStatus","احچي مع المخرج عن القصة أولاً");
 if(!fromDiscussion&&!confirm("تحضير التقرير يستخدم API النصي برسوم بسيطة محتملة، لكن ما يولّد فيديو. موافق؟"))return;
 working=true;$("draftReport").disabled=true;
 try{
  state("chatStatus","قراءة المحادثة كاملة وبناء خط زمني واحد…");
  const a=await prepareBeats(p),slots=slotPlan(a.beats,a.duration_seconds,10);
  await detailSlots(p,a.beats,slots,a.style||"cinematic");
  p.plan={title:String(a.title||p.name),synopsis:String(a.synopsis||""),style:String(a.style||"cinematic"),
   beats:a.beats,slots,seconds:a.duration_seconds,estimate:0,quality:"720p",ratio:document.getElementById("filmOrientation")?.value||"9:16",
   videoProvider:p.videoProvider||"modal",preparedAt:Date.now(),frozenConversationSize:p.messages.length,verified:true};
  if(p.videoProvider==="modal"){p.plan.estimate=0;p.plan.quality="720p";p.plan.costPending=true;}
  p.approved=false;p.jobs=null;persist();render();
  state("chatStatus","✓ جاهز التقرير؛ شيك التسلسل والكلفة قبل موافقتك");
  if(window.FilmChatStart)await prepareChatOffer(p);
  $("reportSection").scrollIntoView({behavior:"smooth"});
 }catch(e){state("chatStatus","خطة الإنتاج لم تُعتمد: "+err(e)+". لا يوجد خصم فيديو.")}
 finally{working=false;$("draftReport").disabled=false;renderProgress();}
}
async function prepareChatOffer(p){
 if(p.chatStartOffer?.consumedAt!=null)throw Error('سُجلت موافقة هذه الخطة سابقاً؛ تابع نفس الجلسة والمهام ولا تبدأ محاولة أخرى.');
 p.chatStartOffer=null;persist();
 try{const offer=await window.FilmChatStart.prepare(p);p.chatStartOffer=offer;
  p.messages.push({role:'assistant',content:window.FilmChatStart.describe(offer)});
  p.plan.frozenConversationSize=p.messages.length;persist();render();
  state('planStatus','راجع التقرير والكلفة، ثم اضغط «موافق وابدأ». بعدها التنفيذ تلقائي بدون تأكيدات أخرى.');
 }catch(e){p.chatStartOffer=null;persist();state('planStatus','التقرير محفوظ، لكن عرض التشغيل غير جاهز: '+err(e));throw e;}
}
$("draftReport").onclick=()=>draftPlan(false);
function renderPlan(){
 const p=selected(),plan=p?.plan;if(!plan)return;
 $("planSummary").textContent=plan.title+" — "+plan.synopsis+" | "+plan.style;
 $("sumDuration").textContent=toClock(plan.seconds);
 $("sumClips").textContent=plan.slots.length;
 if($("filmExecutionQuote"))$("filmExecutionQuote").textContent=p.chatStartOffer?(window.FilmChatStart?.describe(p.chatStartOffer)||'جارٍ تحميل تفاصيل كلفة التشغيل…'):"التقرير محفوظ؛ يلزم جلب عرض تشغيل قبل الموافقة.";
 $("sumPrice").textContent=p.chatStartOffer?"$"+(p.chatStartOffer.rate*60).toFixed(4)+" / دقيقة حوسبة":plan.costPending?"تسعير Modal لكل مشهد قبل التنفيذ":"$"+plan.estimate.toFixed(2)+" تقريباً";
 $("sumBeats").textContent=plan.beats.length;
 $("beatList").replaceChildren();
 plan.beats.forEach((b,i)=>{const div=document.createElement("div");div.className="beat";div.textContent=(i+1)+". "+String(b.story_event||b.id||"")+" — "+b.description;$("beatList").append(div)});
 const script=document.createElement("details");const heading=document.createElement("summary");heading.textContent="الحوار العربي المعتمد — النص والمتحدث لكل مشهد";script.append(heading);
 for(const slot of plan.slots){const line=document.createElement("p");line.textContent="مشهد "+slot.index+" · "+(slot.audioContract?.mode==='silent'?"صامت بطلب صريح":slot.audioContract?.lines?.map(l=>l.speaker+": «"+l.text+"»").join(" | ")||"لا يوجد نص عربي معتمد؛ جهّز تقريراً جديداً قبل التوليد");script.append(line);}$("beatList").append(script);
 const roles=$("creativeSceneCards");if(roles){roles.replaceChildren();if(p.videoProvider==='modal')for(const slot of plan.slots)window.CreativeStudio?.sceneEditor(roles,slot,()=>persist(),working);}
 $("approvePlan").disabled=working||pIsArchive(p)||plan.slots.every(s=>s.status==="done");$("approvePlan").textContent=p.approved?"متابعة التوليد":"موافق وابدأ";
 state("planStatus",p.approved?"✓ وافقت على الخطة، تگدر تتابع الإنتاج.":"بانتظار موافقتك. ماكو فيديو يولد لحد الآن.");
}
$("rejectPlan").onclick=()=>{const p=selected();invalidate(p);persist();render();state("chatStatus","رجعنا للنقاش؛ اكتب التصحيح وجهّز تقريراً جديداً.")};
$("exportPlan").onclick=()=>{const p=selected();if(p.plan)download("film-plan.json",JSON.stringify({name:p.name,plan:p.plan,asset_names:p.assets.map(a=>a.name)},null,2))};
$("approvePlan").onclick=async()=>{
 const p=selected();if(!p?.plan||working||pIsArchive(p))return;if(p.approved)return runProduction();
 if(p.plan.frozenConversationSize!==p.messages.length)return state("planStatus","القصة تغيرت بعد التقرير؛ أعد تجهيز التقرير");
 const m=p.plan;
 if(!m.verified||m.slots.length!==m.seconds/10||m.slots.some((s,i)=>s.index!==i+1||!s.prompt))
  return state("planStatus","التقرير غير مكتمل زمنياً؛ ما يصير نبدأ التوليد");
 const hasHistorical=/صدام|saddam|historical|تاريخي|أحمد حسن|al.bakr/i.test(p.messages.filter(x=>x.role==="user").map(x=>x.content).join(" "));
 if(hasHistorical&&!p.assets.length&&!p.random)
  return state("planStatus","لتجنب شخصية تاريخية عشوائية: ارفع صورة مرجعية أولاً، أو ناقش المرجع مع المخرج. هذا منع للخصم الخطأ.");
 let chatApproval=null,accepted=false;
 working=true;renderProgress();window.ProductionNetwork?.open(p,getData);window.ProductionNetwork?.phase('جارٍ حفظ الخطة وفحص الموافقة؛ لم يبدأ توليد بعد.');
 try{
  await saveServerDraft();
  if(window.FilmChatStart){
   if(!p.chatStartOffer){await prepareChatOffer(p);window.ProductionNetwork?.close();return;}
   if(p.chatStartOffer.consumedAt!==null||p.chatStartOffer.expiresAt<=Date.now()){
    const scenes=await window.EngineAPI.request('projects/'+p.id+'/scenes');
    const fresh=await window.FilmChatStart.refreshApproval(p,p.chatStartOffer,scenes);
    p.chatStartOffer=fresh.offer;persist();
    if(fresh.changed){render();window.ProductionNetwork?.close();state('planStatus','تغيرت شروط التشغيل؛ راجع الكلفة الحالية واضغط موافق من جديد.');return;}
   }
   chatApproval=window.FilmChatStart.accept(p,p.chatStartOffer);
  }
  p.approved=true;accepted=true;persist();render();
 }catch(e){state('planStatus',err(e));window.ProductionNetwork?.phase('توقف قبل التوليد: '+err(e));}
 finally{working=false;renderProgress();}
 if(accepted)await runProduction(false,chatApproval);
};
function pushLog(message){window.ProductionNetwork?.phase(message);const el=document.createElement("div");el.textContent=new Date().toLocaleTimeString("ar-IQ")+" — "+message;$("productionLog").prepend(el)}
function renderProgress(){
 const p=selected();if(!p?.plan)return;
 const slots=p.plan.slots,done=slots.filter(s=>s.status==="done").length,pct=Math.round(100*done/slots.length);
 $("approvePlan").disabled=working||pIsArchive(p)||done===slots.length;
 window.ProductionNetwork?.render(p,getData);
 $("progressBar").style.width=pct+"%";$("progressValue").textContent=pct+"%";
 $("progressText").textContent=done+" / "+slots.length+" مقاطع اكتملت";
 $("startProduction").disabled=working||pIsArchive(p)||done===slots.length;
 $("mergeProduction").disabled=working||done!==slots.length;
}
async function runProduction(alreadyConfirmed=false,chatApproval=null){
 const modalProject=selected();
 if(working||!modalProject?.approved)return;
 if(pIsArchive(modalProject))return state("chatStatus","هذا مشروع أرشيفي؛ مقاطعه باقية للعرض والدمج فقط.");
 if(modalProject.plan?.videoProvider!=="modal")return;
 working=true;stopping=false;renderProgress();
 const io={approvalMode:'film',maxScenes:modalProject.plan.slots.length,maxSceneIndex:modalProject.plan.slots.length,chatApproval,
  stopping:()=>stopping,asset:getData,clip:putData,save:()=>{persist();renderProgress();},
  log:message=>{state("progressText",message);window.ProductionNetwork?.phase(message);},merge:mergeClips};
 try{
  window.ProductionNetwork?.open(modalProject,getData);window.ProductionNetwork?.phase('جارٍ حفظ الخطة وتجهيز المحرك.');
  await saveServerDraft();
  if(chatApproval)await window.FilmChatStart.ensure(modalProject,chatApproval,io);
  const outcome=await window.ModalDirector.run(modalProject,io);
  if(outcome?.cancelled){modalProject.approved=false;persist();window.ProductionNetwork?.close();render();state('planStatus','أُلغيت الموافقة؛ لم يبدأ توليد.');}
 }catch(e){pushLog(err(e));state("chatStatus",err(e));
  if(!modalProject.plan.slots.some(s=>s.jobId||s.status==='ambiguous')){modalProject.approved=false;persist();render();state("planStatus",err(e));window.ProductionNetwork?.phase("توقف التنفيذ: "+err(e));}
 }finally{working=false;renderProgress();}
}
async function mergeClips(){
 const p=selected();if(!p?.plan?.slots.every(s=>s.status==="done"))return pushLog("الدمج يحتاج اكتمال جميع المشاهد");
 if(working&&stopping)return;
 try{
  let files=[];
  for(let i=0;i<p.plan.slots.length;i++){const b=await getData(p.id+"-clip-"+i+(p.plan.slots[i].audioVariant==='clean'?'-clean':''));if(!b)throw Error("المشهد "+(i+1)+" غير محفوظ");files.push(b)}
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
  $("resultBox").hidden=false;window.ProductionNetwork?.result(previewUrl);pushLog("✅ فيلم موحّد جاهز MP4 بالصوت، بدون كلفة توليد جديدة");
 }catch(e){pushLog("فشل الدمج المحلي: "+err(e)+". احتفظ بالمقاطع المحفوظة ولا تعيد التوليد.")}
}
$("startProduction").onclick=runProduction;
$("pauseProduction").onclick=()=>{stopping=true;pushLog("طلب الإيقاف — سيتم بعد انتهاء المشهد الجاري")};
$("mergeProduction").onclick=mergeClips;
window.addEventListener("pagehide",()=>{stopping=true});
try{const saved=JSON.parse(localStorage.getItem(STORAGE)||"null");if(saved&&Array.isArray(saved.projects)){projects=saved.projects;active=saved.active}}catch{}
if(!selected())newStory();else render();

async function saveServerDraft(){
 const p=selected();if(!p)return;
 const snapshot=window.FilmChatStart?window.FilmChatStart.serverSnapshot(p):JSON.parse(JSON.stringify(p));
 serverWrites=serverWrites.catch(()=>{}).then(async()=>{
  await window.EngineAPI.session();await window.EngineAPI.request("projects/save",{snapshot});
 });
 try{await serverWrites;state("chatStatus","تم حفظ القصة والمحادثة بالخادم. الصور تُرفع مع طلب LTX، والمقاطع المحلية تبقى محفوظة على الجهاز.");}
 catch(e){state("chatStatus","تعذر الحفظ بالخادم؛ نسختك المحلية محفوظة. "+err(e));throw e;}
}
$("saveServer").onclick=async()=>{try{await saveServerDraft();serverSyncEnabled=true;}catch{serverSyncEnabled=false;}};
$("restoreModal").onclick=async()=>{
 if(working)return;
 try{
  await window.EngineAPI.session();const stored=await window.EngineAPI.request("projects"),remote=await window.EngineAPI.request("state");
  for(const r of stored){
   if(projects.some(p=>p.id===r.id))continue;
   const p={...r.snapshot,assets:[],messages:r.snapshot.messages||[]};
   const refs=await window.EngineAPI.request("projects/"+p.id+"/references");
   for(const ref of refs){
    const response=await fetch(window.EngineAPI.base+"/api/engine/projects/"+p.id+"/references/"+ref.id,{credentials:"include",redirect:"error"});
    if(!response.ok)throw Error("تعذر استرجاع مرجع محفوظ");const blob=await response.blob();
    const data=await new Promise((ok,no)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result);reader.onerror=no;reader.readAsDataURL(blob);});
    await putData(ref.assetId,data);p.assets.push({id:ref.assetId,name:ref.name});
   }
   if(p.videoProvider==='modal'&&p.plan?.slots){
    const scenes=await window.EngineAPI.request("projects/"+p.id+"/scenes");
    for(const slot of p.plan.slots){const saved=scenes.find(s=>s.sceneId==="scene-"+slot.index),job=saved?{id:saved.jobId}:remote.jobs.find(j=>j.projectId===p.id&&j.sceneId==="scene-"+slot.index);if(job){slot.jobId=job.id;slot.status="submitted";}}
   }
   projects.push(p);
  }
  persist();render();state("chatStatus","تم استرجاع المشاريع والمحادثات دون استبدال أي مشروع محلي أو إعادة توليد مشهد ناجح.");
 }catch(e){state("chatStatus",err(e));}
};

window.addEventListener("creative-library-loaded",()=>renderPlan());

$("showProductionNetwork").onclick=()=>{const p=selected();if(p?.plan)window.ProductionNetwork?.open(p,getData);};
