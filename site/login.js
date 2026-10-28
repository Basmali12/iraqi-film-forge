'use strict';
const form=document.getElementById('loginForm'),password=document.getElementById('password'),button=document.getElementById('loginButton'),status=document.getElementById('loginStatus');
const permitted=new Set(['/','/index.html','/director.html','/film.html','/engines.html']);
form.addEventListener('submit',async event=>{
 event.preventDefault();if(button.disabled)return;
 if(location.protocol!=='https:'){status.textContent='الدخول يحتاج اتصال HTTPS موثوقاً.';return;}
 button.disabled=true;status.textContent='جارٍ التحقق…';
 try{
  const response=await fetch('/api/engine/login',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:password.value})});
  const data=await response.json();
  if(!response.ok||data.role!=='admin')throw Error(response.status===429?'انتظر دقيقة قبل المحاولة مرة ثانية.':response.status===503?'الخادم يحتاج إكمال إعداد المسؤول.':'كلمة المرور غير صحيحة أو انتهت صلاحية الطلب.');
  password.value='';const next=new URLSearchParams(location.search).get('next');location.replace(permitted.has(next)?next:'/');
 }catch(error){status.textContent=error instanceof Error?error.message:'تعذر الدخول الآن.';}
 finally{password.value='';button.disabled=false;}
});
