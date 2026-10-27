import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEngineAPI} from './engine/api.mjs';
import {masterKey} from './engine/keyring.mjs';

const SITE=path.join(path.dirname(fileURLToPath(import.meta.url)),"site");
const HOST=process.env.HOST||"127.0.0.1";
const PORT=Number(process.env.PORT||3000);
const UPSTREAM="https://openrouter.ai/api/v1";
const VIDEO="heygen/heygen-video-1";
const CHAT="openai/gpt-4.1-nano";
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
function reply(res,status,bytes,type="application/json"){
 res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
 res.end(bytes);
}
async function readBody(req){
 let chunks=[],length=0;
 for await(const chunk of req){length+=chunk.length;if(length>2500000)throw Error("Request too large");chunks.push(chunk)}
 return Buffer.concat(chunks);
}
const engineAPI=createEngineAPI({key:masterKey(process.env.ENGINE_DATA_DIR||'.engine-data')});
const requestHandler=async(req,res)=>{
 if(await engineAPI.handler(req,res))return;
 const url=new URL(req.url,"http://localhost");
 // A minimal BYO-key OpenAI proxy. Deploy behind HTTPS with origin allowlisting.
 if(url.pathname==="/api/director/chat"){
  const origin=req.headers.origin||"";
  const allowed=(process.env.ALLOWED_ORIGINS||"https://basmali12.github.io").split(",").map(x=>x.trim());
  if(origin&&!allowed.includes(origin)){reply(res,403,'{"error":"Origin not allowed"}');return}
  res.setHeader("Access-Control-Allow-Origin",origin||"null");
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  if(req.method==="OPTIONS"){reply(res,204,"");return}
  if(req.method!=="POST"){reply(res,405,'{"error":"Method not allowed"}');return}
  const auth=req.headers.authorization||"";
  if(!/^Bearer sk-[A-Za-z0-9_-]{12,}$/.test(auth)){reply(res,401,'{"error":"OpenAI key required"}');return}
  try{
   const body=await readBody(req);
   const data=JSON.parse(body.toString());
   if(data.model!=="gpt-4.1-mini"||!Array.isArray(data.messages)||data.messages.length>24||body.length>160000){
    reply(res,400,'{"error":"Invalid director request"}');return
   }
   const upstream=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},
    body:JSON.stringify({model:"gpt-4.1-mini",messages:data.messages,max_tokens:Math.min(4000,Math.max(100,Number(data.max_tokens)||1000)),...(data.response_format?{response_format:{type:"json_object"}}:{})}),
    signal:AbortSignal.timeout(60000)
   });
   const bytes=Buffer.from(await upstream.arrayBuffer());
   reply(res,upstream.status,bytes,upstream.headers.get("content-type")||"application/json");
  }catch(e){reply(res,502,JSON.stringify({error:String(e.message).slice(0,220)}))}
  return;
 }
 if(!url.pathname.startsWith("/api/v1/")){
  const filename={"/":"index.html","/index.html":"index.html","/styles.css":"styles.css","/app.js":"app.js","/film.html":"film.html","/film.js":"film.js","/film.css":"film.css","/director.html":"director.html","/director.js":"director.js","/director.css":"director.css","/stitcher.js":"stitcher.js","/engines.html":"engines.html","/engines.js":"engines.js","/engines.css":"engines.css","/engine-client.js":"engine-client.js","/engine-endpoint.js":"engine-endpoint.js","/modal-director.js":"modal-director.js"}[url.pathname];
  if(!filename){reply(res,404,'{"error":"Not found"}');return}
  if(filename==='engines.html'){
   res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data: blob:; media-src 'self' https: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  }
  try{let bytes=await fs.readFile(path.join(SITE,filename));reply(res,200,bytes,mime[path.extname(filename)])}
  catch(e){reply(res,500,'{"error":"Missing site file"}')}
  return;
 }
 const auth=req.headers.authorization||"";
 if(!/^Bearer sk-or-v1-[A-Za-z0-9_-]{10,}$/.test(auth)){reply(res,401,'{"error":"Missing valid OpenRouter API key"}');return}
 const suffix=url.pathname.slice(7);
 if(!(/^\/key$|^\/chat\/completions$|^\/videos$|^\/videos\/models$|^\/videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(suffix))){
  reply(res,404,'{"error":"Unsupported API route"}');return;
 }
 try{
  const body=req.method==="POST"?await readBody(req):null;
  if(body&&suffix==="/videos"){
   const j=JSON.parse(body.toString());
   if(j.model!==VIDEO||![5,8,10,15].includes(Number(j.duration))||!["480p","768p"].includes(j.resolution)){
    reply(res,400,'{"error":"This studio only generates HeyGen Video clips using supported settings"}');return
   }
  }
  if(body&&suffix==="/chat/completions"){
   const j=JSON.parse(body.toString());
   if(j.model!==CHAT){reply(res,400,'{"error":"Unsupported text model"}');return}
  }
  const headers={Authorization:auth};
  if(body)headers["Content-Type"]="application/json";
  const upstream=await fetch(UPSTREAM+suffix+url.search,{method:req.method,headers,body,redirect:"error",signal:AbortSignal.timeout(50000)});
  const output=Buffer.from(await upstream.arrayBuffer());
  reply(res,upstream.status,output,upstream.headers.get("content-type")||"application/json");
 }catch(e){reply(res,502,JSON.stringify({error:String(e.message).slice(0,220)}))}
};
const tls=process.env.ENGINE_TLS_CERT&&process.env.ENGINE_TLS_KEY;
const server=tls?https.createServer({cert:await fs.readFile(process.env.ENGINE_TLS_CERT),key:await fs.readFile(process.env.ENGINE_TLS_KEY)},requestHandler):http.createServer(requestHandler);
server.listen(PORT,HOST,()=>console.log("Iraqi Film Forge "+(tls?'https':'http')+"://"+HOST+":"+PORT));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{server.close();await engineAPI.close();});
