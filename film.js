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
 $("filmApprove").disabled=!!project.approved;
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
async function textAI(messages,maxTokens=2000){
 const r=await api("/chat/completions",{method:"POST",payload:{model:CHAT,messages,temperature:.3,max_tokens:maxTokens}});
 return String(r.choices?.[0]?.message?.content||"").replace(/^\x60{3}(?:json)?\s*/,"").replace(/\x60{3}\s*$/,"").trim();
}
function parseJSON(text){
 try{return JSON.parse(text)}catch{
 const i=text.indexOf("{"),j=text.lastIndexOf("}");if(i<0||j<=i)throw Error("المساعد لم يرجع JSON صالحاً");
 return JSON.parse(text.slice(i,j+1))
 }
}
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
  const requested=$("filmTime").value;
  const scope=requested==="auto"?
  "Choose appropriate target_seconds from [180,240,300,600] based on narrative complexity, dialogue and pacing. Prefer 240 or 300 for a coherent full story.":
  "Set target_seconds exactly to "+requested+".";
  const m=await textAI([{role:"system",content:"You are an Iraqi film director and story analyst. Return ONLY compact JSON, no markdown, with keys title, synopsis (Arabic), target_seconds (integer). "+scope+" Retain the sequence of cause then reaction. No generation."},{role:"user",content:story}],650);
  const meta=parseJSON(m);
  const permitted=[180,240,300,600];
  const seconds=Number(requested==="auto"?meta.target_seconds:requested);
  if(!permitted.includes(seconds))throw Error("مدة الفيلم غير مدعومة. اخترها يدوياً وأعد التحليل");
  const count=seconds/15,scenes=[];
  // Work in groups of 8 to prevent output truncation on films with 20–40 scenes.
  for(let start=0;start<count;start+=8){
   const batch=Math.min(8,count-start);
   report("filmAnalyzeStatus","المرحلة 2/2: كتابة المشاهد "+(start+1)+" إلى "+(start+batch)+" من "+count+"…");
   const system="You are an expert Iraqi cinematic storyboard writer. Return ONLY JSON {\"scenes\":[{\"prompt\":\"...\"}]}. EXACTLY "+batch+" scene objects. Each scene is a 15-second cinematic HeyGen video prompt. Write technical directions in English, but exact spoken dialogue in Iraqi Arabic quotes, short enough for 15 seconds. Use the same fixed character appearance, hair, clothes, environment, voice tone across shots. Each action must occur BEFORE its reaction. This batch is part of a "+seconds+"-second film. Output numbered beats "+(start+1)+" through "+(start+batch)+" only. Keep each prompt 60–100 words.";
   const t=await textAI([{role:"system",content:system},{role:"user",content:"STORY:\n"+story+"\nTitle: "+(meta.title||"Iraqi film")+"\nSummary: "+(meta.synopsis||"")+"\nScenes already scripted: "+scenes.map((x,i)=>(i+1)+": "+x.prompt.slice(0,180)).join("\n")}],Math.min(4300,1200+batch*210));
   const part=parseJSON(t).scenes;
   if(!Array.isArray(part)||part.length!==batch)throw Error("المساعد أنشأ "+(part?.length||0)+" بدلاً من "+batch+" مشاهد في الدفعة؛ لم يتم اعتماد الخطة");
   part.forEach((s,i)=>scenes.push({id:"S"+String(start+i+1).padStart(3,"0"),duration:clipDurationAt(start+i,count),prompt:String(s.prompt||"").trim(),status:"pending",jobId:null,cost:null}));
  }
  if(scenes.some(x=>x.prompt.length<25))throw Error("هناك مشهد فارغ في خطة الذكاء");
  // New project: old media keys are version-scoped to avoid accidental film mixing.
  project={version:1,title:String(meta.title||"فيلم عراقي"),synopsis:String(meta.synopsis||""),story,scenes,
   rate:rate(),resolution:$("filmQuality").value,ratio:$("filmRatio").value,approved:false,spent:0,created:Date.now()};
  await saveProject();refresh();stage("planning");
  $("reportPanel").scrollIntoView({behavior:"smooth"});
  report("filmAnalyzeStatus","✓ جاهز: "+count+" مشهداً، مدة "+(seconds/60)+" دقائق. راجع التقرير قبل الموافقة.");
 }catch(e){report("filmAnalyzeStatus","تعذر تحليل القصة: "+err(e)+" — لم يبدأ أي توليد فيديو")}
 finally{btn.disabled=false}
};
$("filmReject").onclick=()=>{$("storyPanel").scrollIntoView({behavior:"smooth"});report("filmApprovalStatus","تگدر تعدل القصة وتعيد التحليل بدون توليد")};
$("filmExportPlan").onclick=()=>{if(project)dlFile("film-report.json",new Blob([JSON.stringify({...project,apiKey:undefined},null,2)],{type:"application/json"}))};
$("filmApprove").onclick=async()=>{
 if(!project||project.approved)return;
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
 if(!project?.approved||running||mergeBusy)return;
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
    const request={model:MODEL,prompt:s.prompt,duration:s.duration,resolution:project.resolution,aspect_ratio:project.ratio};
    if(i>0){
      let previous=await storageGet("clip-"+(i-1));
      if(!previous)throw Error("المشهد السابق غير محفوظ. لا يمكن الاستكمال بدون الفريم");
      stage("continuation");report("filmRuntimeStatus","استخراج آخر فريم للمشهد "+i+"…");
      let img=await frameFromBlob(previous);
      request.frame_images=[{type:"image_url",image_url:{url:img},frame_type:"first_frame"}];
    }else stage("generation");
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
