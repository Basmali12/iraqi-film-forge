"use strict";
const $=id=>document.getElementById(id),BASE="https://openrouter.ai/api/v1";
const MODEL="heygen/heygen-video-1",CHAT="openai/gpt-4.1-nano",DBNAME="iraqi-film-forge-long-v1";
let apiKey="",project=null,running=false,halt=false,mergeBusy=false,filmUrl=null;
function report(id,message){$(id).textContent=message}
function err(e){return String(e?.message||e).slice(0,500)}
function money(x){return "$"+Number(x).toFixed(2)}
function rate(){return $("filmQuality").value==="768p"?.018:.01}
function dlFile(filename,blob){let url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}
function db(){
 return new Promise((resolve,reject)=>{let r=indexedDB.open(DBNAME,1);
 r.onupgradeneeded=()=>{let d=r.result;if(!d.objectStoreNames.contains("files"))d.createObjectStore("files")};
 r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)
 });
}
async function storageGet(k){
 let d=await db();try{return await new Promise((resolve,reject)=>{
 const r=d.transaction("files","readonly").objectStore("files").get(k);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)
 })}finally{d.close()}
}
async function storagePut(k,v){
 let d=await db();try{await new Promise((resolve,reject)=>{
 const tx=d.transaction("files","readwrite");tx.objectStore("files").put(v,k);
 tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
 })}finally{d.close()}
}
async function saveProject(){if(project)await storagePut("project",project)}
async function api(path,{method="GET",payload,blob=false}={}){
 if(!apiKey)throw Error("اربط مفتاح OpenRouter أولاً");
 let r=await fetch(BASE+path,{method,headers:{"Authorization":"Bearer "+apiKey,...(payload?{"Content-Type":"application/json"}:{})},body:payload?JSON.stringify(payload):undefined,cache:"no-store"});
 if(!r.ok){let e=await r.text();try{let j=JSON.parse(e);e=j.error?.message||j.message||e}catch{}throw Error("HTTP "+r.status+" "+e.slice(0,350))}
 return blob?r.blob():r.json();
}
function stage(name){
 let names=["planning","generation","continuation","merge","complete"];
 let idx=names.indexOf(name);
 document.querySelectorAll(".stage").forEach(e=>{
 let i=names.indexOf(e.dataset.stage);e.classList.toggle("done",i<idx);e.classList.toggle("active",i===idx)
 });
}
function refresh(){
 if(!project)return;
 $("reportPanel").hidden=false;
 $("reportTitle").textContent=project.title||"خطة الفيلم";
 $("reportSynopsis").textContent=project.synopsis||"";
 const scenes=project.scenes;
 let seconds=scenes.reduce((a,s)=>a+s.duration,0),done=scenes.filter(s=>s.status==="done").length;
 let starting=seconds*(project.rate||.01),progress=100*done/scenes.length;
 $("metricDuration").textContent=(seconds/60).toFixed(1)+" دقيقة";
 $("metricScenes").textContent=String(scenes.length);
 $("metricSeconds").textContent=seconds+" ثانية";
 $("metricPrice").textContent=money(starting)+" تقريباً";
 $("filmScenes").replaceChildren();$("filmTimeline").replaceChildren();
 for(let i=0;i<scenes.length;i++){
  let s=scenes[i],wrap=document.createElement("div"),head=document.createElement("div"),label=document.createElement("b"),meta=document.createElement("small"),area=document.createElement("textarea");
  wrap.className="fscene";head.className="head";
  label.textContent="المشهد "+(i+1)+" — "+s.duration+" ثانية";
  meta.className=s.status==="done"?"done":s.status==="failed"?"failed":"";
  meta.textContent=s.status==="done"?"✓ مكتمل":s.status==="pending"?"بالانتظار":s.status==="submitted"?"طلب مرسل":s.status==="failed"?"فشل":"جاهز";
  head.append(label,meta);area.value=s.prompt;area.rows=3;area.disabled=!!project.approved;
  area.addEventListener("change",()=>{s.prompt=area.value;saveProject().catch(e=>report("filmApprovalStatus",err(e)))});
  wrap.append(head,area);
  if(s.status==="done"){
   let b=document.createElement("button");b.className="soft";b.textContent="تنزيل هذا المشهد";
   b.onclick=async()=>{try{let file=await storageGet("clip-"+i);if(!file)throw Error("الملف غير محفوظ");dlFile("scene-"+String(i+1).padStart(3,"0")+".mp4",file)}catch(e){report("filmRuntimeStatus",err(e))}};
   wrap.append(b);
  }
  $("filmScenes").append(wrap);
  const li=document.createElement("div");li.className="timeline-item "+(s.status==="done"?"ok":s.status==="failed"?"error":s.status==="submitted"?"active":"");
  li.textContent=(i+1)+"/"+scenes.length+"  ·  "+(s.status==="done"?"✓ المشهد اكتمل":s.status==="submitted"?"◉ جاري التوليد":s.status==="failed"?"⚠ فشل الطلب":"بانتظار التوليد");
  $("filmTimeline").append(li);
 }
 $("filmPercent").textContent=Math.round(progress)+"%";
 $("filmProgress").style.width=progress+"%";
 $("filmStage").textContent=done===scenes.length?"جميع المشاهد جاهزة":"اكتمل "+done+" من "+scenes.length+" مشهداً";
 renderCharacters();
 $("filmApprovalStatus").textContent=project.approved?"تم اعتماد خطة الفيلم":"بانتظار موافقتك على الإنتاج";
 $("productionPanel").hidden=!project.approved;
 $("filmResume").disabled=running||done===scenes.length;
 $("filmPause").disabled=!running;
 $("filmMerge").disabled=running||mergeBusy||done!==scenes.length;
 if(done===scenes.length)stage($("filmFinal").hidden?"merge":"complete");
 else if(done>0)stage("continuation");
 else stage("planning");
}
$("filmConnect").onclick=async()=>{
 let k=$("filmKey").value.trim();
 if(!/^sk-or-v1-[A-Za-z0-9_-]{10,}$/.test(k))return report("filmKeyStatus","المفتاح بصيغة غير صحيحة");
 apiKey=k;$("filmConnect").disabled=true;
 try{await api("/key");$("filmKey").value="";$("filmKey").hidden=true;$("filmConnect").hidden=true;$("filmDisconnect").hidden=false;report("filmKeyStatus","✓ الاتصال ناجح. لا يتم حفظ المفتاح",true)}
 catch(e){apiKey="";report("filmKeyStatus","فشل الاتصال: "+err(e))}
 finally{$("filmConnect").disabled=false}
};
$("filmDisconnect").onclick=()=>{apiKey="";$("filmKey").hidden=false;$("filmConnect").hidden=false;$("filmDisconnect").hidden=true;report("filmKeyStatus","تم فصل المفتاح")};
async function textAI(messages,maxTokens=2000,strictJSON=false){
 const payload={model:CHAT,messages,temperature:.15,max_tokens:maxTokens};
 // Prefer OpenRouter constrained JSON; retry without this feature if a provider rejects it.
 if(strictJSON)payload.response_format={type:"json_object"};
 let r;
 try{r=await api("/chat/completions",{method:"POST",payload})}
 catch(e){
  if(!strictJSON||!/response.format|response_format|json_object|unsupported|invalid parameter|HTTP 400/i.test(err(e)))throw e;
  delete payload.response_format;
  r=await api("/chat/completions",{method:"POST",payload});
 }
 return String(r.choices?.[0]?.message?.content||"").trim();
}
function stripFences(text){
 let value=String(text||"").trim().replace(/^\uFEFF/,"");
 value=value.replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\x60{3}\s*$/,"").trim();
 const first=value.indexOf("{"),last=value.lastIndexOf("}");
 return first>=0&&last>first?value.slice(first,last+1):value;
}
function parseJSON(text){
 const clean=stripFences(text);
 try{return JSON.parse(clean)}
 catch(e){throw Error("رجع المساعد تقريراً بتنسيق غير صالح: "+e.message)}
}
async function structuredAI(messages,tokens,verify){
 let previous="",lastError=null;
 for(let attempt=0;attempt<3;attempt++){
  let input;
  if(attempt===0)input=messages;
  else input=[
   {role:"system",content:"You are a strict JSON formatter. Your entire reply must be one valid JSON object with double-quoted keys and strings, NO markdown, NO commentary, no trailing commas. Preserve the intended factual content. If original text is truncated, produce a concise complete answer satisfying the exact requested schema and scene count. Any double quotes inside strings must be escaped."},
   {role:"user",content:"Original task:\n"+messages.map(m=>m.content).join("\n").slice(0,14500)+"\n\nMalformed result to correct:\n"+previous.slice(0,18000)+"\nReturn valid JSON only."}
  ];
  previous=await textAI(input,tokens,true);
  try{
   const parsed=parseJSON(previous);
   if(!verify(parsed))throw Error("JSON صالح لكن حقوله أو عدد مشاهده غير مطابق");
   return parsed;
  }catch(e){lastError=e}
 }
 throw Error("تعذر الحصول على تقرير JSON صالح بعد المحاولات. "+err(lastError));
}
// Character engine: identity is a structured, user-approved plan, never a text-only guarantee.
const CHARACTER_TYPES=["historical_public","fictional","unknown"];
const STYLE_TYPES=["anime","realistic","3d","hybrid"];
function styleFromStory(story){
  if(/\b(anime|manga|2\.5d)\b|أنمي|انمي/i.test(story))return "anime";
  if(/\b(3d|cgi)\b|ثلاثي الأبعاد/i.test(story))return "3d";
  return "realistic";
}
function safeCharacters(raw,story){
  if(!Array.isArray(raw)||raw.length===0||raw.length>30)throw Error("المساعد لم يعطِ قائمة شخصيات صحيحة");
  const style=styleFromStory(story);
  return raw.map((c,i)=>{
    const name=String(c.display_name||c.name||"").trim().slice(0,150);
    if(!name)throw Error("شخصية بلا اسم");
    const id="CHAR_"+String(i+1).padStart(3,"0");
    const category=CHARACTER_TYPES.includes(c.category)?c.category:"unknown";
    const ages=Array.isArray(c.age_variants)?c.age_variants.slice(0,8):[];
    return {id,display_name:name,category,
      visual_description:String(c.visual_description||"").slice(0,1000),
      classification_reason:String(c.classification_reason||"").slice(0,300),
      voice_description:String(c.voice_description||"").slice(0,250),
      style_target:style,
      age_variants:ages.map(a=>({label:String(a.label||"المرحلة العمرية"),approx_age:Number(a.approx_age)||0,description:String(a.description||"").slice(0,400)})),
      reference_url:"",approved:false};
  });
}
async function analyzeCharacters(story){
  report("filmAnalyzeStatus","تحليل الشخصيات والأعمار والملامح المطلوبة…");
  const instruction="You are a historical film casting and visual continuity assistant. Extract recurring named characters, not generic crowd members. Return one JSON object {\"characters\":[{\"display_name\":\"name\",\"category\":\"historical_public|fictional|unknown\",\"classification_reason\":\"Arabic reason\",\"visual_description\":\"distinctive physical appearance / immutable traits in English\",\"voice_description\":\"voice continuity directions\",\"age_variants\":[{\"label\":\"stage\",\"approx_age\":35,\"description\":\"wardrobe, hair, face for the stage\"}]}]}. For any recognizable real historical person (e.g. Saddam Hussein) classify historical_public. Do not invent verified source photographs or claim exact face likeness; this is a text plan awaiting references. For age changes, keep stable identity features and describe changes historically cautiously. Only extract persons actually in story. Use historically appropriate wardrobes and requested art style.";
  const response=await structuredAI([{role:"system",content:instruction},{role:"user",content:story}],3200,o=>Array.isArray(o?.characters)&&o.characters.length>0);
  return safeCharacters(response.characters,story);
}
function identityBrief(character){
  const ages=character.age_variants.map(a=>a.label+" ("+a.approx_age+"): "+a.description).join("; ");
  return "["+character.id+": "+character.display_name+" | "+character.category+" | "+character.style_target+" visual style | "+character.visual_description+" | Age versions: "+ages+" | Voice: "+character.voice_description+"]. ";
}
function characterPromptForScene(scene,characters){
  const inScene=characters.filter(c=>!Array.isArray(scene.character_ids)||!scene.character_ids.length||scene.character_ids.includes(c.id));
  return "IDENTITY LOCK (continuity reference descriptions, not guarantee of likeness). "+
    inScene.map(identityBrief).join(" ")+" Keep the same character anatomy and features as approved. "+
    "Age and clothing must match the described year. Preserve original action order. "+
    scene.prompt;
}
function charactersApproved(){return !!project&&(project.characters||[]).length>0&&project.charactersApproved===true}
function renderCharacters(){
  const panel=$("characterPanel"),list=$("characterList");
  if(!project?.characters?.length){panel.hidden=true;return}
  panel.hidden=false;list.replaceChildren();
  const frozen=project.charactersApproved||project.approved;
  for(const char of project.characters){
    const card=document.createElement("div");card.className="fscene character-card";
    const heading=document.createElement("div");heading.className="head";
    const title=document.createElement("strong");title.textContent=char.display_name+" · "+(char.category==="historical_public"?"شخصية تاريخية":char.category==="fictional"?"خيالية":"غير مؤكدة");
    const tag=document.createElement("small");tag.textContent=char.style_target==="anime"?"أنمي":char.style_target==="realistic"?"واقعي":char.style_target;
    heading.append(title,tag);card.append(heading);
    const reason=document.createElement("p");reason.className="note";reason.textContent=char.classification_reason;card.append(reason);
    const details=document.createElement("label");details.textContent="الملامح الثابتة";card.append(details);
    const description=document.createElement("textarea");description.rows=3;description.value=char.visual_description;description.disabled=frozen;
    description.onchange=()=>{char.visual_description=description.value.trim();saveProject().catch(()=>{})};
    card.append(description);
    const variants=document.createElement("p");variants.className="note";
    variants.textContent="المراحل العمرية: "+(char.age_variants.map(a=>a.label+" ("+a.approx_age+")").join("، ")||"غير محددة");card.append(variants);
    const lbl=document.createElement("label");lbl.textContent="رابط صورة مرجعية مباشرة HTTPS (اختياري، صورة واحدة لكل شخصية)";card.append(lbl);
    const inp=document.createElement("input");inp.type="url";inp.placeholder="https://example.com/portrait.jpg";inp.value=char.reference_url||"";inp.disabled=frozen;
    inp.onchange=()=>{char.reference_url=inp.value.trim();saveProject().catch(()=>{})};
    card.append(inp);list.append(card);
  }
  $("approveCharacters").disabled=frozen;
  $("characterStatus").textContent=project.charactersApproved?
    "✓ تم اعتماد هوية الشخصيات. تخطيط المشاهد والقصة جاهز للمراجعة.":
    "راجع الملامح والمراحل العمرية ثم اضغط اعتماد. الصورة المرجعية تحسن الاتساق لكنها ما تضمن التطابق.";
  $("filmApprove").disabled=!charactersApproved()||!!project.approved;
}
$("approveCharacters").onclick=async()=>{
 if(!project?.characters?.length||project.charactersApproved)return;
 for(const c of project.characters){
   if(!c.visual_description.trim())return report("characterStatus","أكمل وصف ملامح "+c.display_name);
   if(c.reference_url&&!/^https:\/\/[^ ]+/i.test(c.reference_url))return report("characterStatus","رابط الصورة يجب أن يبدأ بـ https://");
 }
 if(!confirm("توافق على وصف جميع الشخصيات ومراحلها العمرية؟ النص وحده لا يضمن التطابق، وروابط الصور اختيارية."))return;
 project.charactersApproved=true;
 await saveProject();renderCharacters();refresh();$("reportPanel").scrollIntoView({behavior:"smooth"});
};
$("editCharacters").onclick=async()=>{
 if(!project||project.approved)return report("characterStatus","تم اعتماد الإنتاج؛ لسلامة الاستمرارية لا تعدل الشخصيات بعد موافقة التوليد.");
 project.charactersApproved=false;await saveProject();renderCharacters();refresh();
};

function clipDurationAt(index,total){return index===total-1?15:15}
$("analyzeFilm").onclick=async()=>{
 if(!apiKey)return report("filmAnalyzeStatus","اربط OpenRouter أولاً");
 let story=$("filmStory").value.trim();
 if(story.length<80)return report("filmAnalyzeStatus","أدخل قصة مفصلة لا تقل عن 80 حرفاً");
 if(running)return;
 if(project?.approved&&!confirm("هناك فيلم محفوظ. إنشاء خطة جديدة سيستبدل الخطة القديمة، لكنه لا يخصم رسوم فيديو. متأكد؟"))return;
 if(!confirm("المساعد النصي سيقرأ القصة ويصدر تقريراً. طلبات الدردشة قليلة التكلفة لكنها ليست مجانية بالضرورة. موافق؟"))return;
 let btn=$("analyzeFilm");btn.disabled=true;
 try{
  report("filmAnalyzeStatus","المرحلة 1/2: تحليل القصة وتقدير مدتها…");
  const scope="Choose the film duration autonomously from the entire narrative, exact requested runtime if provided, chronological event count and natural pacing. If the user explicitly says 300 seconds, choose 300. Otherwise choose a realistic duration between 30 and 600 seconds. Return target_seconds rounded to the nearest 15 seconds, with a minimum of 30. Never automatically default to 4 or 5 minutes. Explain pacing in the synopsis. Output does not begin generation.";
  const meta=await structuredAI([{role:"system",content:"You are an Iraqi film director and story analyst. Return ONLY compact valid JSON with exactly keys title (string), synopsis (Arabic string), target_seconds (integer). "+scope+" Retain the sequence of cause then reaction. Do not include unescaped quotes. No video generation."},{role:"user",content:story}],950,o=>!!o&&typeof o.title==="string"&&typeof o.synopsis==="string"&&Number.isFinite(Number(o.target_seconds)));
  const rawSeconds=Number(meta.target_seconds);
  if(!Number.isFinite(rawSeconds)||rawSeconds<30||rawSeconds>600)throw Error("الذكاء اقترح مدة خارج حدود النسخة التجريبية (30–600 ثانية). أعد التحليل بتوضيح إيقاع القصة.");
  const seconds=Math.max(30,Math.min(600,Math.round(rawSeconds/15)*15));
  const characters=await analyzeCharacters(story);
  const count=seconds/15,scenes=[];
  // Work in groups of 8 to prevent output truncation on films with 20–40 scenes.
  for(let start=0;start<count;start+=8){
   const batch=Math.min(8,count-start);
   report("filmAnalyzeStatus","المرحلة 2/2: كتابة المشاهد "+(start+1)+" إلى "+(start+batch)+" من "+count+"…");
   const system="You are an expert Iraqi cinematic storyboard writer. Include character_ids with IDs from the approved character registry.  Return ONLY JSON {\"scenes\":[{\"prompt\":\"...\",\"character_ids\":[\"CHAR_001\"]}]}. EXACTLY "+batch+" scene objects. Each scene is a 15-second cinematic HeyGen video prompt. Write technical directions in English, but exact spoken dialogue in Iraqi Arabic quotes, short enough for 15 seconds. Use the same fixed character appearance, hair, clothes, environment, voice tone across shots. Each action must occur BEFORE its reaction. This batch is part of a "+seconds+"-second film. Output numbered beats "+(start+1)+" through "+(start+batch)+" only. Keep each prompt 60–100 words.";
   const result=await structuredAI([{role:"system",content:system},{role:"user",content:"STORY:\n"+story+"\nTitle: "+(meta.title||"Iraqi film")+"\nSummary: "+(meta.synopsis||"")+"\nCHARACTER REGISTRY:\n"+characters.map(c=>identityBrief(c)).join("\n")+"\nScenes already scripted: "+scenes.map((x,i)=>(i+1)+": "+x.prompt.slice(0,180)).join("\n")}],Math.min(5200,1500+batch*280),o=>Array.isArray(o?.scenes)&&o.scenes.length===batch&&o.scenes.every(s=>typeof s.prompt==="string"&&s.prompt.length>25));
   const part=result.scenes;
   if(!Array.isArray(part)||part.length!==batch)throw Error("المساعد أنشأ "+(part?.length||0)+" بدلاً من "+batch+" مشاهد في الدفعة؛ لم يتم اعتماد الخطة");
   part.forEach((s,i)=>scenes.push({id:"S"+String(start+i+1).padStart(3,"0"),duration:clipDurationAt(start+i,count),prompt:String(s.prompt||"").trim(),character_ids:Array.isArray(s.character_ids)?s.character_ids.filter(id=>characters.some(c=>c.id===id)):[],status:"pending",jobId:null,cost:null}));
  }
  if(scenes.some(x=>x.prompt.length<25))throw Error("هناك مشهد فارغ في خطة الذكاء");
  // New project: old media keys are version-scoped to avoid accidental film mixing.
  project={version:2,characters,charactersApproved:false,title:String(meta.title||"فيلم عراقي"),synopsis:String(meta.synopsis||""),story,scenes,
   rate:rate(),resolution:$("filmQuality").value,ratio:$("filmRatio").value,approved:false,spent:0,created:Date.now()};
  await saveProject();refresh();stage("planning");
  $("characterPanel").scrollIntoView({behavior:"smooth"});
  report("filmAnalyzeStatus","✓ جاهز: "+count+" مشهداً، مدة "+(seconds/60)+" دقائق. راجع التقرير قبل الموافقة.");
 }catch(e){report("filmAnalyzeStatus","تعذر تحليل القصة: "+err(e)+" — لم يبدأ أي توليد فيديو")}
 finally{btn.disabled=false}
};
$("filmReject").onclick=()=>{$("storyPanel").scrollIntoView({behavior:"smooth"});report("filmApprovalStatus","تگدر تعدل القصة وتعيد التحليل بدون توليد")};
$("filmExportPlan").onclick=()=>{if(project)dlFile("film-report.json",new Blob([JSON.stringify({...project,apiKey:undefined},null,2)],{type:"application/json"}))};
$("filmApprove").onclick=async()=>{
 if(!project||project.approved)return;
 if(!charactersApproved())return report("filmApprovalStatus","اعتمد الشخصيات أولاً قبل موافقة التوليد");
 let seconds=project.scenes.reduce((a,s)=>a+s.duration,0);
 let approx=seconds*project.rate;
 if(!confirm("توافق على خطة من "+project.scenes.length+" مشهداً، بإجمالي "+seconds+" ثانية؟ التكلفة المرجعية تبدأ من "+money(approx)+". الأسعار ليست سقفاً مضموناً، ولا يبدأ التوليد إلا إذا ضغطت «بدء التوليد» بعدها."))return;
 project.approved=true;
 try{await saveProject();refresh();$("productionPanel").scrollIntoView({behavior:"smooth"});report("filmRuntimeStatus","تمت الموافقة. راجع التقرير ثم اضغط «بدء التوليد».")}
 catch(e){project.approved=false;report("filmApprovalStatus","فشل حفظ الموافقة؛ "+err(e))}
};
async function frameFromBlob(blob){
 const v=document.createElement("video"),url=URL.createObjectURL(blob);v.muted=true;v.playsInline=true;
 try{
  v.src=url;await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=()=>reject(Error("تعذر تحميل المشهد السابق"))});
  v.currentTime=Math.max(0,v.duration-.08);
  await new Promise((resolve,reject)=>{v.onseeked=resolve;v.onerror=()=>reject(Error("تعذر استخراج الفريم الأخير"))});
  const c=document.createElement("canvas"),scale=Math.min(1,900/Math.max(v.videoWidth,v.videoHeight));
  c.width=Math.round(v.videoWidth*scale);c.height=Math.round(v.videoHeight*scale);
  c.getContext("2d").drawImage(v,0,0,c.width,c.height);
  return c.toDataURL("image/jpeg",.82)
 }finally{v.src="";URL.revokeObjectURL(url)}
}
async function finishPending(i){
 let s=project.scenes[i],id=s.jobId;
 if(!id)throw Error("لا يوجد معرف للمهمة. لا يمكن إعادة إرسال طلب قد يكون قد خُصم");
 let encoded=encodeURIComponent(id);
 for(let tries=0;tries<130;tries++){
  if(!running)throw Error("توقفت عملية المتابعة، استأنف لاحقاً");
  const r=await api("/videos/"+encoded);
  report("filmRuntimeStatus","🎬 المشهد "+(i+1)+"/"+project.scenes.length+" — "+r.status);
  if(r.status==="completed"){
    let blob=await api("/videos/"+encoded+"/content",{blob:true});
    if(!blob.size)throw Error("الملف فارغ");
    // Persist media BEFORE advancing. No duplicate charges on resume.
    await storagePut("clip-"+i,blob);
    s.status="done";s.cost=r.usage?.cost??null;project.spent+=(s.cost??s.duration*project.rate);
    await saveProject();refresh();return
  }
  if(["failed","cancelled","expired"].includes(r.status)){
    s.status="failed";await saveProject();
    throw Error("المشهد "+(i+1)+" فشل عند المزود. لن يُعاد التوليد تلقائياً.")
  }
  await new Promise(resolve=>setTimeout(resolve,7000));
 }
 throw Error("مهمة "+id+" ما زالت قيد التنفيذ. لا تنشئ طلباً جديداً؛ استأنف المراقبة لاحقاً")
}
async function startFilm(){
 if(!project?.timelineVerified){report("filmRuntimeStatus","تم إيقاف التوليد المدفوع: مخطط القصة غير مثبت زمنياً وقد يكرر الأحداث. لا يتم إرسال طلبات فيديو جديدة.");return;}
 if(!project?.approved||!charactersApproved()||running||mergeBusy)return;
 if(!apiKey)return report("filmRuntimeStatus","اربط المفتاح أولاً");
 const done=project.scenes.filter(s=>s.status==="done").length;
 const pending=project.scenes.length-done;
 if(!pending){await mergeAll();return}
 if(!confirm("ابدأ أو استأنف إنتاج "+pending+" مشهداً عبر HeyGen؟ كل مشهد جديد يخصم رصيداً من OpenRouter، وقد تختلف الأسعار عن التقرير. سيتم حفظ المقاطع الناجحة بعد كل مشهد. موافق؟"))return;
 running=true;halt=false;refresh();
 try{
  for(let i=0;i<project.scenes.length;i++){
   if(halt){report("filmRuntimeStatus","⏸ توقف بعد آخر مشهد مكتمل. اضغط استئناف لاحقاً.");break}
   let s=project.scenes[i];
   if(s.status==="done")continue;
   if(s.status==="failed")throw Error("المشهد "+(i+1)+" فشل؛ راجعه قبل إعادة المحاولة المدفوعة");
   if(s.status==="pending"){
    const estimatedNext=s.duration*project.rate;
    const budget=project.scenes.reduce((a,x)=>a+x.duration,0)*project.rate*1.3;
    if(project.spent+estimatedNext>budget)
      throw Error("توقفنا لأن الكلفة المقدرة تجاوزت 130% من سعر التقرير. راجع الرصيد والسعر الفعلي قبل المتابعة.");
    const request={model:MODEL,prompt:characterPromptForScene(s,project.characters),duration:s.duration,resolution:project.resolution,aspect_ratio:project.ratio};
    const sceneCharacters=project.characters.filter(c=>!s.character_ids?.length||s.character_ids.includes(c.id));
    if(i>0){
      let previous=await storageGet("clip-"+(i-1));
      if(!previous)throw Error("المشهد السابق غير محفوظ. لا يمكن الاستكمال بدون الفريم");
      stage("continuation");report("filmRuntimeStatus","استخراج آخر فريم للمشهد "+i+"…");
      let img=await frameFromBlob(previous);
      request.frame_images=[{type:"image_url",image_url:{url:img},frame_type:"first_frame"}];
    }else{
      stage("generation");
      const image=sceneCharacters.find(c=>c.reference_url)?.reference_url;
      if(image)request.frame_images=[{type:"image_url",image_url:{url:image},frame_type:"first_frame"}];
    }
    report("filmRuntimeStatus","إرسال طلب المشهد "+(i+1)+" (مدفوع)...");
    // Do not retry submit on network errors: the server may already have charged.
    let response=await api("/videos",{method:"POST",payload:request});
    if(!response.id)throw Error("المزود لم يُرجع رقم المهمة؛ افحص استخدامك قبل إعادة الإرسال");
    s.jobId=response.id;s.status="submitted";await saveProject();refresh();
   }
   await finishPending(i);
  }
  if(project.scenes.every(s=>s.status==="done")&&!halt){
   report("filmRuntimeStatus","✅ اكتملت كل المشاهد، يبدأ الدمج الآن…");
   await mergeAll();
  }
 }catch(e){report("filmRuntimeStatus","⚠️ "+err(e)+" — لا نكرر أي طلب مدفوع تلقائياً")}
 finally{running=false;refresh()}
}
async function mergeAll(){
 if(mergeBusy||!project)return;
 const count=project.scenes.length;
 if(project.scenes.some(s=>s.status!=="done"))return report("filmRuntimeStatus","لم تكتمل المشاهد. الدمج الكامل يحتاج كل المقاطع.");
 mergeBusy=true;stage("merge");report("filmRuntimeStatus","تهيئة محرّك دمج الفيديو والصوت…");
 try{
  let chunks=[];
  for(let i=0;i<count;i++){
   const blob=await storageGet("clip-"+i);if(!blob)throw Error("مقطع "+(i+1)+" مفقود من الجهاز");
   chunks.push(blob);
  }
  // The on-device stitcher supports at most 12 clips and 140 MB per invocation.
  // Reduce by batches, then recursively merge intermediate pieces.
  let round=0;
  while(chunks.length>1){
   const next=[];
   for(let i=0;i<chunks.length;i+=6){
    let group=chunks.slice(i,i+6);
    if(group.length===1){next.push(group[0]);continue}
    const result=await window.IraqiFilmStitcher.merge(group,"cut",t=>report("filmRuntimeStatus","مرحلة الدمج "+(round+1)+": "+t));
    next.push(result.blob);
   }
   chunks=next;round++;
   if(round>6)throw Error("عدد مراحل الدمج غير متوقع");
  }
  const final=chunks[0];
  if(filmUrl)URL.revokeObjectURL(filmUrl);
  filmUrl=URL.createObjectURL(final);
  $("filmPlayer").src=filmUrl;$("filmDownload").href=filmUrl;$("filmFinal").hidden=false;
  stage("complete");$("filmStage").textContent="🏆 اكتمل الفيلم";
  report("filmRuntimeStatus","🏆 تم دمج الفيلم كاملاً! الملف متاح للتحميل MP4 مع الصوت. ماكو رسوم توليد إضافية للدمج.");
 }catch(e){
  report("filmRuntimeStatus","تعذر دمج الفيلم على الهاتف: "+err(e)+". مقاطع الفيديو محفوظة؛ حمّلها منفردة أو استخدم دمج Forge/FFmpeg على السيرفر. ماكو خصم جديد.");
 }finally{mergeBusy=false;refresh()}
}
$("filmResume").onclick=startFilm;
$("filmPause").onclick=()=>{halt=true;report("filmRuntimeStatus","⏸ سيتم التوقف بعد اكتمال الطلب الجاري. ما نكدر نلغي طلباً مدفوعاً انرسل بالفعل.")};
$("filmMerge").onclick=mergeAll;
$("restoreFilm").onclick=async()=>{
 try{const found=await storageGet("project");if(!found)throw Error("ماكو مشروع محفوظ بهذا المتصفح");
 project=found;$("filmStory").value=project.story||"";
 $("filmQuality").value=project.resolution||"480p";$("filmRatio").value=project.ratio||"9:16";
 refresh();report("filmAnalyzeStatus","تمت استعادة الخطة والمقاطع المسجلة ✓");
 }catch(e){report("filmAnalyzeStatus",err(e))}
};
window.addEventListener("pagehide",()=>{halt=true});
