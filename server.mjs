import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEngineAPI} from './engine/api.mjs';
import {masterKey} from './engine/keyring.mjs';
import {createPreviewGate} from './engine/preview-access.mjs';

const SITE=path.join(path.dirname(fileURLToPath(import.meta.url)),"site");
const HOST=process.env.HOST||"127.0.0.1";
const PORT=Number(process.env.PORT||3000);
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
function reply(res,status,bytes,type="application/json"){
 res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
 res.end(bytes);
}
const engineAPI=await createEngineAPI({key:masterKey(process.env.ENGINE_DATA_DIR||'.engine-data')});
const passwordGate=process.env.ENGINE_PREVIEW_PASSWORD_GATE==='YES';
const previewGate=createPreviewGate({enabled:passwordGate,isAuthenticated:engineAPI.hasAdminSession});
const requestHandler=async(req,res)=>{
 if(await previewGate(req,res))return;
 if(await engineAPI.handler(req,res))return;
 const url=new URL(req.url,"http://localhost");
 if(url.pathname.startsWith('/api/')){reply(res,410,JSON.stringify({error:'LEGACY_PROVIDER_REMOVED',message:'Use the authenticated engine API.'}));return;}
 {
  const filename={"/arabic-dialogue.js":"arabic-dialogue.js","/primary-engine-model.js":"primary-engine-model.js","/":"index.html","/index.html":"index.html","/styles.css":"styles.css","/film.html":"film.html","/film-workbench.js":"film-workbench.js","/film-workbench.css":"film-workbench.css","/film-modal-plan.js":"film-modal-plan.js","/film-engine.js":"film-engine.js","/openai-studio.js":"openai-studio.js","/app-settings.js":"app-settings.js","/cost-approval.js":"cost-approval.js","/production-network.js":"production-network.js","/cinema-network.css":"cinema-network.css","/production.html":"production.html","/production-network.css":"production-network.css","/creative-studio.js":"creative-studio.js","/audio-studio.js":"audio-studio.js","/creative-studio.css":"creative-studio.css","/film.css":"film.css","/director.html":"director.html","/director.js":"director.js","/director.css":"director.css","/stitcher.js":"stitcher.js","/engines.html":"engines.html","/engines.js":"engines.js","/engines.css":"engines.css","/engine-client.js":"engine-client.js","/engine-endpoint.js":"engine-endpoint.js","/modal-director.js":"modal-director.js","/login.html":"login.html","/login.css":"login.css","/login.js":"login.js","/session-nav.js":"session-nav.js","/session-nav.css":"session-nav.css"}[url.pathname];
  if(!filename){reply(res,404,'{"error":"Not found"}');return}
  if(filename==='engines.html'||filename==='login.html'){
   res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data: blob:; media-src 'self' https: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  try{let bytes=await fs.readFile(path.join(SITE,filename));if(passwordGate&&filename.endsWith('.html')&&filename!=='login.html')bytes=Buffer.from(bytes.toString().replace('</head>','<link rel="stylesheet" href="/session-nav.css"><script defer src="/session-nav.js"></script></head>'));reply(res,200,bytes,mime[path.extname(filename)])}
  catch(e){reply(res,500,'{"error":"Missing site file"}')}
  return;
 }

};
const tls=process.env.ENGINE_TLS_CERT&&process.env.ENGINE_TLS_KEY;
const protectedHandler=async(req,res)=>{try{await requestHandler(req,res);}catch{if(!res.headersSent)reply(res,503,'{"error":"SERVICE_TEMPORARILY_UNAVAILABLE"}');else res.destroy();}};
const server=tls?https.createServer({cert:await fs.readFile(process.env.ENGINE_TLS_CERT),key:await fs.readFile(process.env.ENGINE_TLS_KEY)},protectedHandler):http.createServer(protectedHandler);
server.listen(PORT,HOST,()=>console.log("Iraqi Film Forge "+(tls?'https':'http')+"://"+HOST+":"+PORT));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{server.close();await engineAPI.close();});
