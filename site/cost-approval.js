/* Visible in-page approval; no cloud/API request is made by this component. */
(function(root){
 'use strict';let pending=null;const box=document.createElement('dialog');box.className='app-cost-approval';box.setAttribute('aria-label','الموافقة على كلفة التوليد');const title=document.createElement('h2'),text=document.createElement('pre'),yes=document.createElement('button'),no=document.createElement('button');title.textContent='مراجعة التوليد والكلفة';yes.textContent='موافق وتوليد';no.textContent='إلغاء';yes.type=no.type='button';box.append(title,text,yes,no);document.body.append(box);
 const settle=value=>{const done=pending;pending=null;box.close();done?.(value);};yes.onclick=()=>settle(true);no.onclick=()=>settle(false);box.addEventListener('cancel',e=>{e.preventDefault();settle(false);});box.addEventListener('close',()=>{if(pending){const done=pending;pending=null;done(false);}});
 root.FilmApproval={ask(message){if(pending)return Promise.resolve(false);text.textContent=message;box.showModal();return new Promise(resolve=>{pending=resolve;});}};
})(window);
