"use strict";
const $ = id => document.getElementById(id);
const VIDEO_MODEL="heygen/heygen-video-1";
const CHAT_MODEL="openai/gpt-4.1-nano";
const BASE=(location.hostname==="localhost"||location.hostname==="127.0.0.1")?"/api/v1":"https://openrouter.ai/api/v1";
let key="",messages=[],lastReply="",currentClip=null,currentURL=null,storyboard=[],generating=false;
function status(id,message){$(id).textContent=message}
function errorText(e){return String((e&&e.message)||e).slice(0,460)}
async function api(path,options={}){
 if(!key)throw Error("أضف مفتاح OpenRouter أولاً");
 const r=await fetch(BASE+path,{
  method:options.method||"GET",headers:{"Authorization":"Bearer "+key,...(options.body?{"Content-Type":"application/json"}:{})},
  body:options.body?JSON.stringify(options.body):undefined,cache:"no-store"
 });
 if(!r.ok){
  let error=await r.text();try{let obj=JSON.parse(error);error=(obj.error&&obj.error.message)||obj.message||error}catch(e){}
  throw Error("HTTP "+r.status+" "+String(error).slice(0,250))
 }
 return options.binary?r.blob():r.json()
}
$("connect").onclick=async()=>{
 let attempt=$("key").value.trim();
 if(!/^sk-or-v1-[A-Za-z0-9_-]{10,}$/.test(attempt))return status("keyStatus","صيغة المفتاح غير صحيحة");
 key=attempt;$("connect").disabled=true;status("keyStatus","جارٍ التحقق من المفتاح");
 try{
  await api("/key");
  $("key").value="";$("key").hidden=true;$("connect").hidden=true;$("disconnect").hidden=false;
  $("generate").disabled=false;$("generate").textContent="إنشاء فيديو HeyGen";
  status("keyStatus","متصل ✓ المفتاح محفوظ مؤقتاً بذاكرة الصفحة فقط");
 }catch(e){key="";status("keyStatus","فشل الربط: "+errorText(e)+"، قد نحتاج خادم API آمن إذا كان السبب CORS")}
 finally{$("connect").disabled=false}
};
$("disconnect").onclick=()=>{
 key="";messages=[];$("key").hidden=false;$("connect").hidden=false;$("disconnect").hidden=true;
 $("generate").disabled=true;$("generate").textContent="اربط المفتاح أولاً";status("keyStatus","تم فصل المفتاح")
};
function addMessage(role,text){
 let div=document.createElement("div");div.className="bubble "+role;div.textContent=text;
 $("messages").appendChild(div);$("messages").scrollTop=$("messages").scrollHeight
}
$("send").onclick=async()=>{
 let question=$("chat").value.trim();if(!question)return;if(!key)return status("chatStatus","أضف المفتاح أولاً");
 let btn=$("send");btn.disabled=true;addMessage("user",question);status("chatStatus","جاري الرد...");
 try{
  const system="أنت مخرج سينمائي عراقي. ساعد بكتابة القصص والإعلانات العراقية باللهجة العراقية القوية. عند طلب برومبت اكتب أوصافاً دقيقة لمشهد مدته 5–15 ثانية لنموذج HeyGen Video. لا تدع أنك أنت تولد الفيديو.";
  let r=await api("/chat/completions",{method:"POST",body:{model:CHAT_MODEL,messages:[{role:"system",content:system},...messages.slice(-12),{role:"user",content:question}],max_tokens:1000,temperature:0.6}});
  lastReply=r.choices[0].message.content||"";
  messages.push({role:"user",content:question},{role:"assistant",content:lastReply});
  addMessage("assistant",lastReply);$("chat").value="";status("chatStatus","اكتمل الرد ✓")
 }catch(e){status("chatStatus",errorText(e))}finally{btn.disabled=false}
};
$("useAnswer").onclick=()=>{if(lastReply)$("prompt").value=lastReply};
function updatePrice(){
 let rate=$("resolution").value==="480p"?0.01:0.018;
 let price=Number($("duration").value)*rate;
 $("price").textContent="السعر الترويجي المرجعي يبدأ من $"+price.toFixed(2)+"، وقد يتغير"
}
$("resolution").onchange=updatePrice;$("duration").onchange=updatePrice;updatePrice();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function lastFrame(clip){
 const video=document.createElement("video"),url=URL.createObjectURL(clip);video.muted=true;video.playsInline=true;
 try{
  video.src=url;
  await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(Error("تعذر تحميل الفيديو السابق"))});
  video.currentTime=Math.max(0,video.duration-0.12);
  await new Promise((resolve,reject)=>{video.onseeked=resolve;video.onerror=()=>reject(Error("تعذر استخراج الفريم"))});
  const canvas=document.createElement("canvas"),scale=Math.min(1,1024/Math.max(video.videoWidth,video.videoHeight));
  canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
  canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
  return canvas.toDataURL("image/jpeg",0.85)
 }finally{video.src="";URL.revokeObjectURL(url)}
}
async function generateVideo(prompt,duration,resolution,aspectRatio,tail){
 let request={model:VIDEO_MODEL,prompt,duration,resolution,aspect_ratio:aspectRatio};
 if(tail){
  status("videoStatus","جاري استخراج آخر فريم للفيديو السابق...");
  const image=await lastFrame(tail);
  request.frame_images=[{type:"image_url",image_url:{url:image},frame_type:"first_frame"}]
 }
 status("videoStatus","جاري إرسال طلب HeyGen المدفوع...");
 const submitted=await api("/videos",{method:"POST",body:request});
 if(!submitted.id)throw Error("لم يصل معرف الفيديو. تحقق من رصيدك قبل إعادة الطلب.");
 let id=encodeURIComponent(submitted.id);
 for(let i=0;i<120;i++){
  await sleep(7000);
  let result=await api("/videos/"+id);
  status("videoStatus","مهمة "+submitted.id+" - الحالة: "+result.status+
   (result.usage&&result.usage.cost!=null?" - الكلفة $"+result.usage.cost:""));
  if(result.status==="completed"){
   let video=await api("/videos/"+id+"/content",{binary:true});
   if(!video.size)throw Error("مقطع الفيديو الناتج فارغ");
   return {blob:video,id:submitted.id,cost:result.usage&&result.usage.cost}
  }
  if(["failed","cancelled","expired"].includes(result.status))
   throw Error("فشلت المهمة "+submitted.id+": "+String(result.error||result.status))
 }
 throw Error("انتهت مهلة الانتظار. مهمة "+submitted.id+" قد تستمر؛ لا تكرر التوليد قبل التحقق منها.")
}
$("generate").onclick=async()=>{
 if(!key||generating)return;
 let prompt=$("prompt").value.trim(),duration=Number($("duration").value);
 let resolution=$("resolution").value,ratio=$("ratio").value,tail=$("carry").checked?currentClip:null;
 if(prompt.length<8)return status("videoStatus","البرومبت قصير");
 if($("carry").checked&&!tail)return status("videoStatus","ماكو فيديو سابق للاستكمال");
 if(!tail&&filmClips.length&&!confirm("هذا يولد فيلم جديد ويبدأ قائمة مقاطع جديدة. حمّلت نسخة الفيلم القديم؟"))return;
 let rate=resolution==="480p"?0.01:0.018;
 if(!confirm("إنشاء فيديو مدفوع من HeyGen Video فقط. "+duration+" ثانية بدقة "+resolution+
   ". السعر المرجعي يبدأ من $"+(duration*rate).toFixed(2)+"، وقد يزيد أو يتغير. موافق؟"))return;
 generating=true;$("generate").disabled=true;
 try{
  let r=await generateVideo(prompt,duration,resolution,ratio,tail);
  if(!tail)filmClips=[];
  await appendScene(r.blob,"heygen-"+String(r.id).slice(0,17)+".mp4");
  status("videoStatus","تم إنشاء المشهد ✓ "+(r.cost!=null?"الكلفة الفعلية $"+r.cost:""));
  if(filmClips.length>1)await mergeFilm();
  else status("joinStatus","المشهد الأول محفوظ. فعّل «متابعة من آخر فريم» حتى تضيف مقطعاً ثانياً.")
 }catch(e){status("videoStatus","خطأ: "+errorText(e)+" — افحص حالة المهمة قبل إنشاء طلب جديد")}
 finally{generating=false;$("generate").disabled=false}
};


/* Multi-scene film session. Media is stored in IndexedDB on the user's device; the API key is not stored. */
let filmClips=[],merging=false;
const FILM_DB="iraqi-film-forge-clips-v1";
function filmDB(){
 return new Promise((resolve,reject)=>{
  if(!("indexedDB" in window))return reject(Error("المتصفح لا يدعم حفظ المقاطع"));
  const open=indexedDB.open(FILM_DB,1);
  open.onupgradeneeded=()=>{if(!open.result.objectStoreNames.contains("clips"))open.result.createObjectStore("clips",{keyPath:"order"})};
  open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error||Error("فشل فتح التخزين"));
 });
}
async function persistFilm(){
 let db=await filmDB();
 try{
  await new Promise((resolve,reject)=>{
   const tx=db.transaction("clips","readwrite"),store=tx.objectStore("clips");
   store.clear();
   filmClips.forEach((item,i)=>store.put({order:i,blob:item.blob,duration:item.duration,name:item.name}));
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
  });
 }finally{db.close()}
}
async function restoreFilm(){
 try{
  const db=await filmDB();let records;
  try{records=await new Promise((resolve,reject)=>{
   const req=db.transaction("clips","readonly").objectStore("clips").getAll();
   req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)
  })}finally{db.close()}
  if(records&&records.length){
   records.sort((a,b)=>a.order-b.order);
   filmClips=records.filter(i=>i.blob&&i.blob.size).map(i=>({blob:i.blob,duration:i.duration,name:i.name}));
   currentClip=filmClips[filmClips.length-1].blob;
   showPreview(currentClip,"film-latest-scene.mp4");
   status("joinStatus","استعدنا "+filmClips.length+" مقطعاً من جهازك. اضغط «دمج كل المقاطع» لعرض الفيلم كاملاً");
   updateFilmInfo()
  }
 }catch(e){status("joinStatus","تعذّر استعادة المقاطع المحفوظة: "+errorText(e))}
}
function updateFilmInfo(){
 const seconds=filmClips.reduce((sum,item)=>sum+(item.duration||0),0);
 status("joinCount",filmClips.length+" مقطع | "+seconds.toFixed(1)+" ثانية تقريباً");
 $("joinBtn").disabled=merging||generating||filmClips.length<2;
}
function showPreview(blob,name){
 if(currentURL)URL.revokeObjectURL(currentURL);
 currentURL=URL.createObjectURL(blob);
 $("player").src=currentURL;$("download").href=currentURL;
 $("download").download=name||"iraqi-film.mp4";
 $("result").hidden=false;
}
async function appendScene(clip,name){
 const metadata=await window.IraqiFilmStitcher.inspect(clip);
 filmClips.push({blob:clip,duration:metadata.duration,name:name||"scene-"+filmClips.length+".mp4"});
 currentClip=clip;
 showPreview(clip,"latest-scene.mp4");
 updateFilmInfo();
 try{await persistFilm()}catch(e){
  status("joinStatus","المقاطع موجودة في الجلسة فقط. التخزين المحلي امتلأ؛ حمّل ملفاتك: "+errorText(e))
 }
}
async function mergeFilm(){
 if(merging||filmClips.length<2)return;
 merging=true;updateFilmInfo();
 const chosenMode=$("joinType").value;
 try{
  let out=await window.IraqiFilmStitcher.merge(filmClips.map(i=>i.blob),chosenMode,
    msg=>status("joinStatus",msg));
  showPreview(out.blob,"iraqi-film-"+filmClips.length+"-scenes.mp4");
  status("joinStatus","✅ ملف موحد جاهز: "+out.duration.toFixed(1)+
   " ثانية، "+out.segments+" مقاطع. تگدر تحمله MP4 بدون كلفة توليد إضافية.");
  status("videoStatus","الفيلم الكامل مدموج ✓ (المتابعة القادمة تستخدم آخر فريم من آخر مشهد، مو الفيلم الكامل)");
 }catch(e){
  status("joinStatus","ما اكدر أدمج المقاطع بهاتفك حالياً: "+errorText(e)+
    ". مقاطعك محفوظة ولم تُحذف. جرب وضع «وصل مباشر» أو الدمج على السيرفر.");
  // The preview remains available; do not claim a complete film was merged.
 }finally{merging=false;updateFilmInfo()}
}
$("joinBtn").onclick=()=>mergeFilm();
$("newFilmBtn").onclick=async()=>{
 if(!filmClips.length)return;
 if(!confirm("بدء فيلم جديد يمسح لقطات هذا الفيلم من تخزين المتصفح. حمّلت نسخة الفيلم القديم؟"))return;
 filmClips=[];currentClip=null;
 $("carry").checked=false;
 if(currentURL){URL.revokeObjectURL(currentURL);currentURL=null}
 $("player").removeAttribute("src");$("player").load();$("result").hidden=true;
 try{await persistFilm()}catch(e){}
 status("joinStatus","بدأنا فيلم جديد؛ ماكو مقاطع");
 updateFilmInfo()
};
$("importFiles").onchange=async()=>{
 const files=Array.from($("importFiles").files||[]).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
 if(!files.length)return;
 if(filmClips.length&&!confirm("تريد تبدل المقاطع الحالية بالمقاطع المحددة؟ حمّل القديمة قبل الاستبدال.")){
  $("importFiles").value="";return
 }
 try{
  status("joinStatus","قراءة الفيديوهات القديمة من الجهاز…");
  const entries=[];
  for(const file of files){
   const info=await window.IraqiFilmStitcher.inspect(file);
   entries.push({blob:file,duration:info.duration,name:file.name});
  }
  filmClips=entries;currentClip=entries[entries.length-1].blob;
  showPreview(currentClip,"latest-imported-scene.mp4");
  updateFilmInfo();
  try{await persistFilm()}catch(e){status("joinStatus","تم الاستيراد بالجلسة، لكن التخزين المحلي فشل: "+errorText(e))}
  if(filmClips.length>1)await mergeFilm();
  else status("joinStatus","تم استيراد فيديو واحد؛ تگدر تكمله من آخر فريم")
 }catch(e){status("joinStatus","فشل استيراد المقاطع: "+errorText(e))}
 finally{$("importFiles").value=""}
};
updateFilmInfo();
restoreFilm();

$("plan").onclick=async()=>{
 let story=$("story").value.trim(),count=Math.ceil(Number($("filmDuration").value)/15);
 if(!key||story.length<15)return status("planStatus","اربط المفتاح واكتب القصة أولاً");
 if(!confirm("راح نستخدم النموذج النصي لكتابة "+count+" مشهد؛ لا يوجد توليد فيديو بهذا الزر. موافق؟"))return;
 let btn=$("plan");btn.disabled=true;status("planStatus","جاري التخطيط...");
 try{
  let system="You are an expert Iraqi cinema screenwriter. Split the user story into EXACTLY "+
   count+" shots of 15 seconds. Maintain identities, clothing, locations, chronological causality and Southern Iraqi dialogue. Return only valid JSON with schema {\"scenes\":[{\"id\":\"S001\",\"prompt\":\"English cinematic visual directions with Iraqi Arabic spoken dialogue in quotes\"}]} and no markdown.";
  let r=await api("/chat/completions",{method:"POST",body:{model:CHAT_MODEL,messages:[{role:"system",content:system},{role:"user",content:story}],temperature:0.3,max_tokens:Math.min(12000,count*180+500)}});
  let raw=String(r.choices[0].message.content||"").trim().replace(/^\x60{3}(?:json)?/,"").replace(/\x60{3}$/,"").trim();
  let plan=JSON.parse(raw);if(!Array.isArray(plan.scenes)||!plan.scenes.length)throw Error("الخطة غير صالحة");
  storyboard=plan.scenes.map((s,i)=>({id:s.id||"S"+String(i+1).padStart(3,"0"),prompt:String(s.prompt||""),duration:15}));
  $("scenes").replaceChildren();
  storyboard.forEach((scene,i)=>{
   let container=document.createElement("div"),label=document.createElement("b"),
     area=document.createElement("textarea"),button=document.createElement("button");
   container.className="scene";label.textContent="المشهد "+(i+1);area.rows=3;area.value=scene.prompt;
   area.oninput=()=>scene.prompt=area.value;button.textContent="نسخ إلى مولّد الفيديو";
   button.onclick=()=>{$("prompt").value=scene.prompt;$("duration").value="15";updatePrice();scrollTo({top:0,behavior:"smooth"})};
   container.append(label,area,button);$("scenes").appendChild(container)
  });
  $("savePlan").disabled=false;status("planStatus","تم إعداد "+storyboard.length+" مشهد للمراجعة ✓")
 }catch(e){status("planStatus","فشل تجهيز القصة: "+errorText(e)+" — قسم القصة إلى أجزاء أقصر")}
 finally{btn.disabled=false}
};
$("savePlan").onclick=()=>{
 let blob=new Blob([JSON.stringify({model:VIDEO_MODEL,scenes:storyboard},null,2)],{type:"application/json"}),
 url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="storyboard.json";a.click();
 setTimeout(()=>URL.revokeObjectURL(url),5000)
};
