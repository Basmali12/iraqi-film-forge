// One controller process, sequential explicitly approved scenes; no retry queue.
export class SessionChannel {
 constructor(write,onEvent){this.write=write;this.onEvent=onEvent;this.pending=null;this.closed=false;this.seen=new Set();}
 generate(payload,onEvent){
  if(this.closed)throw Error('ENGINE_SESSION_EXPIRED');
  if(this.pending)throw Error('ONE_GENERATION_AT_A_TIME');
  if(this.seen.has(payload.jobId))throw Error('SCENE_ALREADY_SUBMITTED');
  this.seen.add(payload.jobId);
  return new Promise((resolve,reject)=>{
   this.pending={id:payload.jobId,resolve,reject,onEvent};
   try{this.write(JSON.stringify({command:'generate',jobId:payload.jobId,artifactDir:payload.artifactDir,prompt:payload.prompt,seed:payload.settings.seed,orientation:payload.settings.orientation??'portrait',previousFrame:payload.previousFrame||null})+'\n');}
   catch{this.pending=null;reject(Error('SESSION_STATE_UNKNOWN'));}
  });
 }
 message(value){
  if(value.type==='event'){this.onEvent(value.data);this.pending?.onEvent(value.data);}
  if(value.type==='generation_result'){
   if(!this.pending||value.data.job_id!==this.pending.id){this.close();throw Error('SESSION_RESULT_ID_MISMATCH');}
   const pending=this.pending;this.pending=null;pending.resolve(value.data.result);
  }
 }
 close(){this.closed=true;if(this.pending){const pending=this.pending;this.pending=null;pending.reject(Error('SESSION_STATE_UNKNOWN'));}}
}
