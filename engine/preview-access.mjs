const destinations=new Set(['/','/index.html','/director.html','/film.html','/engines.html']);
const publicFiles=new Set(['/login.html','/login.css','/login.js']);
const publicAPI=new Set(['/api/engine/login','/api/engine/health']);

export function createPreviewGate({enabled=false,isAuthenticated}) {
 return async(req,res)=>{
  if(!enabled)return false;
  const url=new URL(req.url,'http://localhost');
  if(publicAPI.has(url.pathname)||publicFiles.has(url.pathname))return false;
  if(await isAuthenticated(req))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname.startsWith('/api/')){
   res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'ADMIN_LOGIN_REQUIRED'}));
  }else{
   const target=destinations.has(url.pathname)?url.pathname:'/';
   res.writeHead(302,{Location:'/login.html?next='+encodeURIComponent(target)});res.end();
  }
  return true;
 };
}
