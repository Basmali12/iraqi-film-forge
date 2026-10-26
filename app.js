"use strict";
const $ = id => document.getElementById(id);
const VIDEO_MODEL="heygen/heygen-video-1";
const CHAT_MODEL="openai/gpt-4.1-nano";
const BASE="https://openrouter.ai/api/v1";
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
 let rate=resolution==="480p"?0.01:0.018;
 if(!confirm("إنشاء فيديو مدفوع من HeyGen Video فقط. "+duration+" ثانية بدقة "+resolution+
   ". السعر المرجعي يبدأ من $"+(duration*rate).toFixed(2)+"، وقد يزيد أو يتغير. موافق؟"))return;
 generating=true;$("generate").disabled=true;
 try{
  let r=await generateVideo(prompt,duration,resolution,ratio,tail);
  currentClip=r.blob;if(currentURL)URL.revokeObjectURL(currentURL);
  currentURL=URL.createObjectURL(r.blob);
  $("player").src=currentURL;$("download").href=currentURL;
  $("download").download="heygen-"+String(r.id).slice(0,17)+".mp4";
  $("result").hidden=false;status("videoStatus","تم إنشاء الفيديو ✓ "+(r.cost!=null?"الكلفة الفعلية $"+r.cost:""))
 }catch(e){status("videoStatus","خطأ: "+errorText(e)+" — افحص حالة المهمة قبل إنشاء طلب جديد")}
 finally{generating=false;$("generate").disabled=false}
};
