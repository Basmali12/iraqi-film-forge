import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ROOT} from './config.mjs';
const repo=path.dirname(ROOT),sha=b=>createHash('sha256').update(b).digest('hex');
const POLICY='text-detection-and-local-repair-v1';
export async function replaceWithRetry(source,target){for(let n=0;;n++){try{return await fs.rename(source,target);}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||n===3)throw e;await new Promise(r=>setTimeout(r,50*2**n));}}}
export class TextQuality {
 constructor(folder,{python=process.env.ENGINE_TEXT_QC_PYTHON}={}){
  this.folder=folder;this.python=python||path.join(repo,'.venv-text',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  this.queue=Promise.resolve();this.readyUntil=0;
 }
 command(args,onEvent=(_event)=>{},timeout=900000){return new Promise((resolve,reject)=>{
  if(!path.isAbsolute(this.python)||!existsSync(this.python))return reject(Error('TEXT_QC_NOT_CONFIGURED'));
  const env={CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:'void',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
  for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG','ENGINE_TEXT_DETECTOR_MODEL','ENGINE_TEXT_INPAINT_MODEL'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(this.python,['-X','utf8','-m','engine.video_text',...args],{cwd:repo,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  const stop=()=>{if(!child.pid||child.exitCode!==null)return;if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.on('error',()=>child.kill());}else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill();}}};
  const timer=setTimeout(()=>{stop();reject(Error('TEXT_QC_TIMEOUT_ORIGINAL_PRESERVED'));},timeout);timer.unref();
  let buffer='',last=null;const observed=[];
  child.stdout.setEncoding('utf8');child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>1000000){stop();return reject(Error('TEXT_QC_OUTPUT_LIMIT'));}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const value=JSON.parse(line);last=value;if(value.phase&&Number.isFinite(value.frames))observed.push(Promise.resolve(onEvent({kind:'progress',phase:value.phase,completed:value.frames,total:value.total,unit:'frames'})));}catch{}}});
  child.once('error',()=>{clearTimeout(timer);reject(Error('TEXT_QC_NOT_CONFIGURED'));});
  child.once('close',async code=>{clearTimeout(timer);try{await Promise.all(observed);code?reject(Error('TEXT_QC_FAILED_ORIGINAL_PRESERVED')):resolve(last);}catch{reject(Error('TEXT_QC_EVENT_RECORDING_FAILED'));}});
 });}
 async available(){
  if(this.readyUntil>Date.now())return {ready:true};
  const result=await this.command(['--capability'],()=>{},20000);
  if(!result?.ready||result.gpu!==false)throw Error('TEXT_QC_NOT_CONFIGURED');
  this.readyUntil=Date.now()+60000;return result;
 }
 process(job,result,onEvent=(_event)=>{}){
  const task=this.queue.then(()=>this.run(job,result,onEvent));this.queue=task.catch(()=>{});return task;
 }
 async run(job,result,onEvent){
  const folder=path.join(this.folder,'artifacts',job.id),source=path.join(folder,'video.mp4');
  const output=path.join(folder,'text-clean-candidate.mp4'),report=path.join(folder,'text-quality.json');
  if(result.textQuality?.status==='passed')return result;
  await this.available();await onEvent({kind:'phase_start',phase:'text_detection'});
  // Existing output requires recovery/inspection, never an automatic rerender.
  await this.command(['--source',source,'--output',output,'--report',report],onEvent);
  await onEvent({kind:'phase_end',phase:'text_detection'});
  await onEvent({kind:'phase_start',phase:'text_verification'});
  const quality=JSON.parse(await fs.readFile(report,'utf8'));
  if(quality.status!=='passed'){
   await onEvent({kind:'phase_error',phase:'text_verification',error_type:'GENERATION_SUCCEEDED_TEXT_REVIEW_REQUIRED'});
   return {...result,textQuality:{...quality,policy:POLICY},generationSucceeded:true};
  }
  const original=await fs.readFile(source),clean=await fs.readFile(output);
  if(sha(original)!==result.sha256||quality.source_sha256!==result.sha256||sha(clean)!==quality.output_sha256||quality.native_audio_bitstream_unchanged!==true)
   throw Error('TEXT_QC_INTEGRITY_FAILED');
  // Preserve raw media/audit before installing the accepted presentation copy.
  await fs.copyFile(source,path.join(folder,'raw-ltx.mp4'),fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(folder,'audit.json'),path.join(folder,'raw-ltx-audit.json'),fs.constants.COPYFILE_EXCL);
  const accepted={...result,sha256:quality.output_sha256,generationSucceeded:true,
                 textQuality:{...quality,policy:POLICY},rawSHA256:result.sha256};
  // Continuation must use the accepted cleaned last frame, not embedded captions.
  const ffmpeg=process.env.ENGINE_FFMPEG_BIN||'ffmpeg';
  const frame=path.join(folder,'text-clean-last-frame.png');
  await new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-nostdin','-v','error','-y','-sseof','-0.05','-i',output,'-frames:v','1',frame],{stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('close',code=>code?reject(Error('TEXT_QC_LAST_FRAME_FAILED')):resolve());});
  // Commit acceptance last. A local write failure must never produce an audit
  // claiming the quality gate succeeded before the continuation frame exists.
  await replaceWithRetry(output,source);await replaceWithRetry(frame,path.join(folder,'last-frame.png'));
  const receipt=path.join(folder,'audit-text-accepted.tmp');await fs.writeFile(receipt,JSON.stringify(accepted));await replaceWithRetry(receipt,path.join(folder,'audit.json'));
  await onEvent({kind:'phase_end',phase:'text_verification'});
  return accepted;
 }
}
