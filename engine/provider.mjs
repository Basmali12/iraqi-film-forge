import {spawn} from 'node:child_process';
import path from 'node:path';
import {existsSync} from 'node:fs';
import os from 'node:os';
import {ROOT} from './config.mjs';
import {SessionChannel} from './session-channel.mjs';
export function providerEnvironment(input,base=process.env) {
 const env={...base};
 for(const key of Object.keys(env))if(key.startsWith('ENGINE_')||key.startsWith('PG')||(key.endsWith('_API_KEY')||['DATABASE_URL','HF_TOKEN','HUGGING_FACE_HUB_TOKEN'].includes(key)))delete env[key];
 if(input.credentials?.mode!=='local_profile'&&input.source?.mode!=='local_profile')for(const key of Object.keys(env))if(key.startsWith('MODAL_'))delete env[key];
 return env;
}
// Credentials are sent over a private pipe, never argv, stdout, HTTP responses, or logs.
export class ModalProvider {
 constructor(python=process.env.ENGINE_PYTHON) {
  const candidates=[path.join(ROOT,'../.venv-engine',process.platform==='win32'?'Scripts/python.exe':'bin/python'),...(process.platform==='win32'?[path.join(os.homedir(),'AppData/Local/Programs/Python/Python313/python.exe')]:[])];
  this.python=python||candidates.find(p=>existsSync(p))||'python';
 }
 call(action,input,onEvent=(_event)=>{},timeout=90000,signal=undefined) {
  return new Promise((resolve,reject)=>{
   const child=spawn(this.python,['-X','utf8',path.join(ROOT,'modal_bridge.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:providerEnvironment(input)});
   child.stdout.setEncoding('utf8');
   let buffer='',result,failed=false;
   const timer=setTimeout(()=>{failed=true;child.kill();reject(Error('PROVIDER_TIMEOUT_STATE_UNKNOWN'));},timeout);timer.unref();
   const abort=()=>{failed=true;child.kill();reject(Error('CANCELLED_STATE_REQUIRES_RECONCILIATION'));};signal?.addEventListener('abort',abort,{once:true});
   child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({action,...input})+'\n');
   child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>180000000){child.kill();return reject(Error('PROVIDER_OUTPUT_LIMIT'));}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const v=JSON.parse(line);if(v.type==='event')onEvent(v.data);if(v.type==='result')result=v.data;if(v.type==='error')failed=true;}catch{/* Ignore library output; never forward raw output. */}}});
   child.stderr.on('data',()=>{}); // SDK exceptions may include sensitive context; deliberately discarded.
   child.once('error',()=>{clearTimeout(timer);reject(Error('PYTHON_OR_MODAL_UNAVAILABLE'));});
   child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code||failed||result===undefined)reject(Error('MODAL_OPERATION_FAILED_CHECK_PERMISSIONS'));else resolve(result);});
  });
 }
 session(input,onEvent=(_event)=>{}) {
  const child=spawn(this.python,['-X','utf8',path.join(ROOT,'modal_bridge.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:providerEnvironment(input)});
  child.stdout.setEncoding('utf8');
  let buffer='',result,failed=false;
  const channel=new SessionChannel(line=>child.stdin.write(line),onEvent);
  const done=new Promise((resolve,reject)=>{
   child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({action:'session',...input})+'\n');
   child.stderr.on('data',()=>{});
   child.stdout.on('data',chunk=>{buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let v;try{v=JSON.parse(line);}catch{continue;}try{channel.message(v);if(v.type==='result')result=v.data;if(v.type==='error')failed=true;}catch{failed=true;channel.close();child.stdin.write('{"command":"stop"}\n');}}});
   child.once('error',()=>{channel.close();reject(Error('PYTHON_UNAVAILABLE'));});
   child.once('close',code=>{channel.close();code||failed||!result?reject(Error('SESSION_STATE_UNKNOWN')):resolve(result);});
  });
  return {done,stop:()=>child.stdin.write('{"command":"stop"}\n'),generate:(payload,onEvent)=>channel.generate(payload,onEvent)};
 }
}
