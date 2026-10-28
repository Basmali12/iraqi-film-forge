'use strict';
const nav=document.createElement('aside');nav.className='private-session';nav.setAttribute('aria-label','جلسة الدخول');
const logout=document.createElement('button');logout.type='button';logout.textContent='تسجيل الخروج';nav.append(logout);document.body.append(nav);
logout.addEventListener('click',async()=>{
 if(logout.disabled)return;logout.disabled=true;
 try{
  const check=await fetch('/api/engine/session',{credentials:'same-origin',redirect:'error',cache:'no-store'});
  if(check.status===401){location.replace('/login.html');return;}
  if(!check.ok)throw Error('session');const session=await check.json();
  const response=await fetch('/api/engine/logout',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'X-CSRF-Token':session.csrf}});
  if(!response.ok)throw Error('logout');location.replace('/login.html');
 }catch{logout.textContent='تعذر الخروج؛ حاول مجدداً';logout.disabled=false;}
});
