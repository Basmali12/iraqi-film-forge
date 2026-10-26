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
