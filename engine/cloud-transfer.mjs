// Metadata-only control plane; no model bytes, staging directories, or GPU calls.
export const CLOUD_TRANSFER={cpu:2,ramGiB:4,timeoutSeconds:3600,startupSeconds:180,idleSeconds:2};
export function cloudTransferPlan(plan,preflight,mode='full'){
 const rate=2*.0000131+4*.00000222,timeoutSeconds=mode==='probe'?120:mode==='verify-only'?1200:3600,windowSeconds=timeoutSeconds+180+2;
 const calls=mode==='probe'?0:mode==='verify-only'?1:2,destinationWindowSeconds=782,sourceWindowSeconds=mode==='verify-only'?0:windowSeconds;
 const requiredBytes=mode==='probe'?65536:mode==='verify-only'?0:plan.requiredBytes,integrityReadBytes=mode==='probe'?65536:plan.integrityReadBytes;
 return {...plan,requiredBytes,integrityReadBytes,files:mode==='full'?plan.files:[],transport:'modal-cpu-cloud',usesHostDisk:false,workerReady:preflight.workerReady===true,
  workerFingerprint:preflight.fingerprint,workerApp:preflight.workerApp,
  executionReady:preflight.workerReady===true,blockingReason:preflight.workerReady?null:'CLOUD_WORKER_NOT_DEPLOYED',
  localStagingRequiredBytes:0,localStagingAvailableBytes:null,localStagingReady:true,
  mode,probeBytes:mode==='probe'?65536:0,verificationStrategy:'destination-cpu-local',destinationVerifierMayDeploy:calls>0,
  orchestration:'host-account-clients',sourceCpuCalls:mode==='verify-only'?0:1,
  compute:{...CLOUD_TRANSFER,timeoutSeconds,rate,windowSeconds,sourceWindowSeconds,totalWindowSeconds:sourceWindowSeconds+calls*destinationWindowSeconds,resourceWindowUSD:rate*(sourceWindowSeconds+calls*destinationWindowSeconds),destination:{calls,cpu:2,ramGiB:4,timeoutSeconds:600,startupSeconds:180,windowSeconds:destinationWindowSeconds,resourceWindowUSD:rate*calls*destinationWindowSeconds}},
  billingWorkspace:'basm1998ali + destination CPU verification',gpuUsed:false,buildCostUSD:null,networkCostUSD:null,
  networkListReferenceUSD:requiredBytes/2**30*.04,
  resume:'Completed files are hash-checked and skipped. An incomplete SDK upload restarts only that file after a fresh approved plan.',
  storageNote:'Persistent across months and GPU shutdown. Included storage/egress allowance is not verified; no monthly weight-copy schedule.'};
}
export function cloudRequest(job,a,source,workerApp,credentials){
 return {jobId:job.id,source,credentials,workerApp,volume:a.volume,destinationWorkspace:a.workspace};
}
export async function observeCloudTransfer({provider,request,onEvent,deadline,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 let sequence=0,last;
 while(now()<deadline){
  last=await provider.call('cloud_transfer_status',request);
  for(const event of last.events||[])if(event.sequence>sequence){sequence=event.sequence;await onEvent(event);}
  if(last.cloud_stopped===true){return {...(last.result||{}),...last,events:undefined,gpuUsed:false};}
  await sleep(3000);
 }
 // A timeout never means the remote CPU call stopped. Cancel only this recorded job.
 last=await provider.call('cloud_transfer_stop',request);
 if(!last.cloud_stopped)throw Error('CLOUD_TRANSFER_STOP_UNCONFIRMED');
 return {...(last.result||{}),...last,status:'failed',ready:false,error:'TRANSFER_TIMEOUT',gpuUsed:false};
}
