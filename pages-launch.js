/* Pages is an access link. Authentication and all provider calls remain same-origin on HostHatch. */
(function(){
 'use strict';
 const routes={'index.html':'film.html','film.html':'film.html','director.html':'film.html','engines.html':'engines.html','production.html':'production.html'};
 const page=location.pathname.split('/').pop()||'index.html';
 const target=new URL(routes[page]||'film.html','https://167.104.162.4/');
 const project=new URLSearchParams(location.search).get('project');
 if(project&&/^[a-zA-Z0-9_-]{1,100}$/.test(project))target.searchParams.set('project',project);
 const link=document.getElementById('openStudio');if(link)link.href=target.href;
 // Do not read credentials, cookies, localStorage or IndexedDB on the Pages origin.
 location.replace(target.href);
})();
