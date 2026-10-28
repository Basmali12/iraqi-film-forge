import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const AUDIO_CLEANUP_VERSION='deepfilter-0.5.6-cpu-v1';
const LIMIT=160*1024*1024;
async function command(binary,args,timeout=120000){const env={CUDA_VISIBLE_DEVICES:'',NVIDIA_VISIBLE_DEVICES:'void',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key];return exec(binary,args,{timeout,maxBuffer:8*1024*1024,windowsHide:true,env});}
export async function audioCapability(env=process.env){
 const binary=env.ENGINE_AUDIO_CLEANUP_BIN,expected=env.ENGINE_AUDIO_CLEANUP_SHA256;
 if(!binary||!path.isAbsolute(binary)||!/^[a-f0-9]{64}$/.test(expected||''))return {ready:false,reason:'DEEPFILTER_NOT_CONFIGURED',gpu:false};
 try{
  const info=await fs.stat(binary);if(!info.isFile()||info.size>80*1024*1024||(process.platform!=='win32'&&(info.uid!==0||(info.mode&0o022)))||sha(await fs.readFile(binary))!==expected)throw Error('hash');
  await command(binary,['--version'],5000);await command(env.ENGINE_FFMPEG_BIN||'ffmpeg',['-version'],5000);await command(env.ENGINE_FFPROBE_BIN||'ffprobe',['-version'],5000);
  return {ready:true,version:AUDIO_CLEANUP_VERSION,gpu:false,method:'CPU speech denoising; native voices retained; not dialect or speaker repair'};
 }catch{return {ready:false,reason:'AUDIO_DEPENDENCY_OR_HASH_CHECK_FAILED',gpu:false};}
}
async function probe(file,env){const r=await command(env.ENGINE_FFPROBE_BIN||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],15000);return JSON.parse(r.stdout);}
async function videoPackets(file,env){const r=await command(env.ENGINE_FFPROBE_BIN||'ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=data_hash','-show_data_hash','sha256','-of','json',file],20000);return sha(JSON.parse(r.stdout).packets.map(p=>p.data_hash).join('\n'));}
export async function cleanNativeAudio({source,folder,sourceSHA256,attenuationDb=6,env=process.env,onPhase=(_phase)=>{}}){
 if(![3,6,12].includes(attenuationDb))throw Error('INVALID_AUDIO_STRENGTH');
 if(!(await audioCapability(env)).ready)throw Error('AUDIO_CLEANUP_UNAVAILABLE');
 const info=await fs.stat(source);if(info.size>LIMIT||sha(await fs.readFile(source))!==sourceSHA256)throw Error('AUDIO_SOURCE_HASH_MISMATCH');
 const original=await probe(source,env),duration=Number(original.format.duration),video=original.streams.find(s=>s.codec_type==='video');
 if(!video||!original.streams.some(s=>s.codec_type==='audio')||!Number.isFinite(duration)||duration<=0||duration>600)throw Error('INVALID_AUDIO_SOURCE');
 await fs.mkdir(folder,{recursive:true,mode:0o700});const temporary=await fs.mkdtemp(path.join(folder,'processing-'));
 try{
  const input=path.join(temporary,'native.wav'),filtered=path.join(temporary,'filtered');await fs.mkdir(filtered);
  await onPhase('extract_native_audio');await command(env.ENGINE_FFMPEG_BIN||'ffmpeg',['-nostdin','-v','error','-y','-i',source,'-vn','-ar','48000','-c:a','pcm_s16le',input]);
  await onPhase('cpu_denoise');await command(env.ENGINE_AUDIO_CLEANUP_BIN,['-D','-a',String(attenuationDb),'-o',filtered,input],600000);
  const waves=(await fs.readdir(filtered)).filter(name=>name.endsWith('.wav'));if(waves.length!==1)throw Error('AUDIO_OUTPUT_MISSING');
  const output=path.join(temporary,'clean.mp4');await onPhase('mux_without_video_reencode');
  await command(env.ENGINE_FFMPEG_BIN||'ffmpeg',['-nostdin','-v','error','-y','-i',source,'-i',path.join(filtered,waves[0]),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart',output]);
  await onPhase('verify_output');const checked=await probe(output,env),checkedVideo=checked.streams.find(s=>s.codec_type==='video');
  const originalAudio=original.streams.find(s=>s.codec_type==='audio'),checkedAudio=checked.streams.find(s=>s.codec_type==='audio');
  if(!checkedVideo||!checkedAudio||checkedAudio.channels!==originalAudio.channels||Number(checkedAudio.sample_rate)!==48000||checkedVideo.width!==video.width||checkedVideo.height!==video.height||Math.abs(Number(checked.format.duration)-duration)>.1||await videoPackets(source,env)!==await videoPackets(output,env))throw Error('AUDIO_OUTPUT_VALIDATION_FAILED');
  if(sha(await fs.readFile(source))!==sourceSHA256)throw Error('AUDIO_SOURCE_CHANGED');
  const final=path.join(folder,'clean.mp4');await fs.rename(output,final);
  return {path:final,sha256:sha(await fs.readFile(final)),originalSHA256:sourceSHA256,videoBitstreamUnchanged:true,nativeVoicesRetained:true,qualityReviewed:false,duration,attenuationDb,version:AUDIO_CLEANUP_VERSION};
 }finally{if(path.resolve(temporary).startsWith(path.resolve(folder)+path.sep))await fs.rm(temporary,{recursive:true,force:true});}
}
export class AudioCleanupQueue{
 constructor(store,{env=process.env,runner=cleanNativeAudio}={}){this.store=store;this.env=env;this.runner=runner;this.waiting=[];this.active=false;this.requests=Promise.resolve();}
 async initialize(){for(const record of await this.store.all('audio-cleanup'))if(['queued','running'].includes(record.status)){record.status='recovery_required';record.error='AUDIO_RESTART_REQUIRES_EXPLICIT_RETRY';await this.store.put('audio-cleanup',record);}}
 request(job,options={}){const task=this.requests.then(()=>this.reserve(job,options));this.requests=task.then(()=>{},()=>{});return task;}
 async reserve(job,{attenuationDb=6,retry=false}={}){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(job?.id||'')||!/^[a-f0-9]{64}$/.test(job?.result?.sha256||''))throw Error('INVALID_AUDIO_SOURCE_JOB');
  if(![3,6,12].includes(attenuationDb))throw Error('INVALID_AUDIO_STRENGTH');
  const id=sha(job.id+':'+job.result.sha256+':'+AUDIO_CLEANUP_VERSION+':'+attenuationDb),old=await this.store.get('audio-cleanup',id);
  if(old&&(!retry||!['failed','recovery_required'].includes(old.status)))return old;
  const record={id,jobId:job.id,status:'queued',createdAt:Date.now(),attenuationDb,attempts:(old?.attempts||0)+1,sourceSHA256:job.result.sha256,events:[]};
  // Reserve durably before enqueue; serial API requests reuse the same identity.
  if(this.waiting.length>=32)throw Error('AUDIO_QUEUE_FULL');let reserved=false;
  await this.store.transaction(async()=>{const current=await this.store.get('audio-cleanup',id);if(current&&['queued','running','completed'].includes(current.status))return;await this.store.put('audio-cleanup',record);reserved=true;});
  if(reserved){this.waiting.push(record);if(!this.active)this.done=this.drain().catch(()=>{});}return await this.store.get('audio-cleanup',id);
 }
 async drain(){if(this.active)return;this.active=true;
  try{while(this.waiting.length){const r=this.waiting.shift();this.currentId=r.id;
   try{r.status='running';r.startedAt=Date.now();await this.store.put('audio-cleanup',r);
    const source=path.join(this.store.folder,'artifacts',r.jobId,'video.mp4'),folder=path.join(this.store.folder,'audio-cleanups',r.id);
    const result=await this.runner({source,folder,sourceSHA256:r.sourceSHA256,attenuationDb:r.attenuationDb,env:this.env,onPhase:async phase=>{r.events.push({phase,at:Date.now()});await this.store.put('audio-cleanup',r);}});
    r.result=result;r.status='completed';
   }catch{r.status='failed';r.error='AUDIO_CLEANUP_FAILED_ORIGINAL_UNCHANGED';}
   r.finishedAt=Date.now();await this.store.put('audio-cleanup',r);
  }}finally{this.currentId=null;this.active=false;}
 }
}
export function publicCleanup(record){if(!record)return null;const {path:privatePath,...result}=record.result||{};return {...record,result:record.result?result:undefined};}
