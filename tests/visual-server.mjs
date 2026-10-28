// Local UI TEST ONLY. No credentials, no Modal SDK, no paid execution.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {createEngineAPI} from '../engine/api.mjs';
import {hash} from '../engine/store.mjs';
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'iff-visual-fixture-'));
const api=await createEngineAPI({folder,key:randomBytes(32).toString('base64'),allowPaid:false,trustProxy:true,origin:'http://127.0.0.1:59143',provider:{async call(action){if(action==='discover')return {ready:true,files:[],capacity:'unknown',testFixture:true};throw Error('VISUAL_FIXTURE_NO_CLOUD_ACCESS');}}});
const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
api.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token),JSON.stringify({role:'admin',csrf,expires:Date.now()+3600000}));
api.store.put('account',{id:'11111111-1111-1111-1111-111111111111',workspace:'local-visual-fixture',label:'حساب اختبار الواجهة فقط',role:'backup',mode:'local_profile',volume:'no-real-volume',discovery:{ready:false}});
api.store.put('config',{id:'selection',accountId:'11111111-1111-1111-1111-111111111111',settings:{}});
api.store.put('job',{id:'22222222-2222-2222-2222-222222222222',accountId:'11111111-1111-1111-1111-111111111111',action:'prepare',status:'running',cloudStopped:false,settings:{gpu:'RTX-PRO-6000',cpu:4,ram:64,budget:1},estimate:{rate:null},startedAt:Date.now(),createdAt:Date.now(),events:[{kind:'phase_end',phase:'storage'},{kind:'progress',phase:'transfer',transferred:30*2**30,required:66.2*2**30,rate:40*2**20,unit:'source_bytes_received'}]});
http.createServer(async(req,res)=>{
 if(req.url.startsWith('/api/engine/')){
  req.headers.cookie='iff_engine='+token;req.headers['x-forwarded-proto']='https';
  if(!['/api/engine/state','/api/engine/session','/api/engine/selection','/api/engine/quote','/api/engine/draft'].includes(req.url)){res.writeHead(423,{'Content-Type':'application/json'});res.end('{"error":"VISUAL_TEST_NO_CLOUD_ACTIONS"}');return;}
  await api.handler(req,res);return;
 }
 const relative=req.url.split('?')[0].replace(/^\//,'')||'engines.html';
 if(!/^[a-z-]+\.(html|css|js)$/.test(relative)){res.writeHead(404);res.end();return;}
 try{let content=await fs.readFile(path.join('site',relative));if(relative==='engines.html')content=Buffer.from(content.toString().replace('<body>','<body><p class="warning" role="note">اختبار واجهة محلي ببيانات محاكية — ليس اتصالاً بحساب Modal. لا توجد عمليات سحابية أو صلاحية تشغيل.</p>'));res.setHeader('Content-Type',relative.endsWith('.css')?'text/css':relative.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(content);}catch{res.writeHead(404);res.end();}
}).listen(59143,'127.0.0.1',()=>console.log('UI TEST ONLY: http://127.0.0.1:59143/engines.html — all cloud operations blocked.'));
