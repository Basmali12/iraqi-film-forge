import {randomBytes,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store,id,hash,passwordOK} from './store.mjs';
import {settings,estimate,quality,GPUS,manifest} from './config.mjs';
import {ModalProvider} from './provider.mjs';
const SAFE=/^[a-zA-Z0-9_-]{1,100}$/;
const publicAccount=a=>{const {credentials,hf,...safe}=a;return {...safe,hasHF:!!hf};};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req) {let size=0,parts=[];for await(const p of req){size+=p.length;if(size>8000000)throw Error('BODY_TOO_LARGE');parts.push(p);}return JSON.parse(Buffer.concat(parts).toString()||'{}');}
function imageBytes(data) {
 if(typeof data!=='string'||data.length>5500000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data))throw Error('INVALID_REFERENCE_IMAGE');
 const bytes=Buffer.from(data.split(',')[1],'base64');if(bytes.length<16||bytes.length>4000000)throw Error('INVALID_REFERENCE_IMAGE');
 if(!(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')))throw Error('INVALID_IMAGE_SIGNATURE');return bytes;
}
export function createEngineAPI({folder=process.env.ENGINE_DATA_DIR||'.engine-data',key=process.env.ENGINE_MASTER_KEY,provider=new ModalProvider(),allowPaid=process.env.ENGINE_ALLOW_PAID_ACTIONS==='YES',origin=process.env.ENGINE_ORIGIN||'https://localhost:3443',trustProxy=process.env.ENGINE_TRUST_PROXY==='loopback',cookieSameSite=process.env.ENGINE_COOKIE_SAME_SITE==='none'?'None':'Strict',store=key?new Store(folder,key):null}={}) {
 const allowedOrigins=new Set((process.env.ENGINE_ALLOWED_ORIGINS||origin).split(',').map(s=>s.trim()));
 const attempts=new Map(),controllers=new Map(),cancellations=new Map(),activeTasks=new Set();
 if(store)for(const j of store.all('job'))if(['queued','running','stopping','ready'].includes(j.status)){j.status='recovery_required';j.error='SERVER_RESTART_RECONCILE_BEFORE_RETRY';store.put('job',j);}
 function credentials(a) {return a.mode==='local_profile'?{mode:'local_profile',expectedWorkspace:a.workspace}: {...store.open(a.credentials,a.id),expectedWorkspace:a.workspace};}
 function spending() {
  const groups=new Map(),month=new Date().toISOString().slice(0,7);
  for(const j of store.all('job'))if(j.action!=='prepare'&&new Date(j.createdAt).toISOString().startsWith(month)){
   const group=j.appId||j.attachedEngineId||j.id,prior=groups.get(group)||0;
   const recorded=j.cleanup?.recordedCost?.usd??j.result?.recordedCost?.usd;
   const value=recorded!==undefined?Number(recorded):['queued','running','ready','stopping','uncertain','recovery_required'].includes(j.status)&&!j.cloudStopped?j.estimate.resourceWindowUSD:(j.estimatedUSD??j.estimate.resourceWindowUSD);
   groups.set(group,Math.max(prior,value));
  }
  return {month,estimatedOrReservedUSD:[...groups.values()].reduce((a,b)=>a+b,0),limitUSD:store.get('config','budget')?.limitUSD??null,note:'Mixed recorded/estimated/reserved compute ledger, not Modal invoice; excludes unknown traffic, storage and hosting fees.'};
 }
 async function recoverArtifact(j) {
  try {
   const folder=path.resolve(store.folder,'artifacts',j.id),receipt=JSON.parse(await fs.readFile(path.join(folder,'audit.json'),'utf8')),video=await fs.readFile(path.join(folder,'video.mp4'));
   if(!receipt.videoVerified||hash(video)!==receipt.sha256||!receipt.metadata?.ffprobe?.streams?.some(s=>s.codec_type==='audio'))return false;
   const v=receipt.metadata.ffprobe.streams.find(s=>s.codec_type==='video');if(v.width!==576||v.height!==1024)return false;
   j.result={...receipt,...j.cleanup};j.status='completed';j.error=null;
   const scene=store.get('scene',j.sceneKey);if(scene){scene.status='completed';scene.sha256=receipt.sha256;scene.artifact='/api/engine/jobs/'+j.id+'/video';store.put('scene',scene);}return true;
  }catch{return false;}
 }
 function account(aid) {const a=store.get('account',aid);if(!a)throw Error('ACCOUNT_NOT_FOUND');return a;}
 const secure=req=>!!req.socket.encrypted||(trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&req.headers['x-forwarded-proto']==='https');
 async function discover(a) {const result=await provider.call('discover',{credentials:credentials(a),volume:a.volume});if(a.corruptFiles?.length){result.ready=false;result.requiresIntegrityRepair=a.corruptFiles;}a.discovery={...result,checkedAt:Date.now()};store.put('account',a);store.audit('account_inspected',a.id);return result;}
 function event(job,data) {
  const latest=store.get('job',job.id);
  const safe={};for(const field of ['kind','phase','seconds','completed','total','unit','transferred','required','file','app_id','running_containers','cloud_stopped','state','time','rate','eta','status','error_type','device','allocated_vram_bytes','reserved_vram_bytes'])if(Object.hasOwn(data,field))safe[field]=data[field];
  job.events.push({...safe,receivedAt:Date.now()});if(job.events.length>2000)job.events.shift();if(data.app_id)job.appId=data.app_id;
  if(data.kind==='ready'&&!latest?.stopRequestedAt)job.status='ready';
  if(data.kind==='phase_start'&&job.status==='ready')job.status='running';
  if(data.cloud_stopped===true)job.cloudStopped=true;
  if(data.kind==='file_verified'&&data.file){job.verifiedFiles=[...new Set([...(job.verifiedFiles||[]),data.file])];}
  if(latest?.stopRequestedAt){job.stopRequestedAt=latest.stopRequestedAt;if(!job.cloudStopped)job.status='stopping';}
  job.updatedAt=Date.now();store.put('job',job);
 }
 async function run(job,a,source) {
  job.status='running';job.startedAt=Date.now();store.put('job',job);const cancel=new AbortController();cancellations.set(job.id,cancel);
  try {
   const payload={credentials:credentials(a),source:source?credentials(source):null,sourceVolume:source?.volume,volume:a.volume,settings:job.settings,plan:job.plan,jobId:job.id,prompt:job.prompt,previousFrame:job.previousFrame,hfCredentials:job.plan?.source==='official'?store.open(a.hf,a.id+':hf'):undefined,paidApproved:true,artifactDir:path.resolve(store.folder,'artifacts',job.id),stagingDir:path.resolve(store.folder,'transfer-cache',a.id)};
   if(job.action==='start') {
    const control=provider.session(payload,e=>event(job,e));controllers.set(job.id,control);
    job.result=await control.done;controllers.delete(job.id);
   } else if(job.attachedEngineId) {
    const control=controllers.get(job.attachedEngineId);if(!control)throw Error('ENGINE_SESSION_EXPIRED');job.result=await control.generate(payload,e=>event(job,e));
   } else job.result=await provider.call(job.action==='prepare'?'transfer':'generate',payload,e=>event(job,e),(job.action==='prepare'?86400:job.settings.timeout+job.settings.startup+240)*1000,cancel.signal);
   job.status=job.action==='start'?'stopped':'completed';job.completedAt=Date.now();job.cloudStopped=job.result.cloud_stopped===true;
   if(job.action==='prepare'){a.discovery=job.result.inspection?{...job.result.inspection,checkedAt:Date.now(),hashVerifiedByTransfer:true}:null;if(job.result.requiresNewPlan){a.corruptFiles=job.result.corruptFiles;job.status='needs_review';job.error='INTEGRITY_CHANGED_SCOPE_APPROVE_NEW_PLAN';}else if(job.result.ready)a.corruptFiles=[];store.put('account',a);}
   if(job.action==='generate'){
    if(!job.result.videoVerified)throw Error('MP4_NOT_VERIFIED');
    const scene=store.get('scene',job.sceneKey);scene.status='completed';scene.jobId=job.id;scene.artifact='/api/engine/jobs/'+job.id+'/video';scene.sha256=job.result.sha256;store.put('scene',scene);
   }
  } catch {
   // A local persistence/transport failure is NOT proof that cloud generation failed.
   job.status=job.result?.videoVerified?'completed':'uncertain';job.error=job.result?.videoVerified?'GENERATION_SUCCEEDED_LOCAL_RECORDING_NEEDS_RECONCILIATION':'OPERATION_STATE_UNCERTAIN_DO_NOT_RESUBMIT';
   if(job.action==='prepare'){job.status='failed';job.cloudStopped=true;}
   else try {job.cleanup=await provider.call('stop',{credentials:credentials(a),appId:job.appId||null,jobId:job.attachedEngineId||job.id});job.cloudStopped=job.cleanup.cloud_stopped===true;if(job.cleanup.app_id)job.appId=job.cleanup.app_id;}catch{job.cloudStopped=false;}
   if(job.action==='generate'&&!job.result?.videoVerified&&job.cloudStopped&&job.events.some(e=>e.kind==='phase_error')){
    job.status='failed';job.error='GPU_REPORTED_FAILURE_CLOUD_STOPPED_NO_AUTOMATIC_RETRY';
    const scene=store.get('scene',job.sceneKey);if(scene?.jobId===job.id){scene.status='failed';store.put('scene',scene);}
   }
  } finally {cancellations.delete(job.id);job.updatedAt=Date.now();job.finishedAt=Date.now();if(job.cloudStopped)job.stoppedAt=Date.now();job.elapsedSeconds=(Date.now()-job.startedAt)/1000;job.estimatedUSD=job.action==='prepare'?null:job.elapsedSeconds*job.estimate.rate;store.put('job',job);store.audit('operation_finished',job.id);}
 }
 async function handler(req,res) {
  const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/engine/'))return false;
  try {
   const requestOrigin=req.headers.origin;
   if(requestOrigin&&!allowedOrigins.has(requestOrigin)){json(res,403,{error:'ORIGIN_DENIED'});return true;}
   if(requestOrigin){res.setHeader('Access-Control-Allow-Origin',requestOrigin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');}
   if(url.pathname==='/api/engine/health'&&req.method==='GET'){json(res,200,{service:'iraqi-film-forge-engine-v1',configured:!!store?.get('admin','administrator'),secure:secure(req)});return true;}
   if(!store){json(res,503,{error:'BACKEND_NOT_CONFIGURED',message:'الخادم يحتاج مفتاح تشفير ومسؤولاً؛ لا يمكن استقبال توكنات حالياً.'});return true;}
   if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Content-Type, X-CSRF-Token');res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE');res.writeHead(204);res.end();return true;}
   const route=url.pathname.slice('/api/engine/'.length);
   if(route==='login'&&req.method==='POST') {
    if(!secure(req)){json(res,426,{error:'HTTPS_REQUIRED'});return true;}
    const ip=req.socket.remoteAddress,now=Date.now(),prior=attempts.get(ip)||{n:0,until:now+60000};if(prior.until<now){prior.n=0;prior.until=now+60000;}prior.n++;attempts.set(ip,prior);if(prior.n>10){json(res,429,{error:'LOGIN_RATE_LIMIT'});return true;}
    const b=await body(req),admin=store.get('admin','administrator');
    if(!admin||b.username!==admin.username||typeof b.password!=='string'||b.password.length>500||!passwordOK(b.password,admin.password)){json(res,401,{error:'INVALID_LOGIN'});return true;}
    const token=randomBytes(32).toString('hex'),session={csrf:randomBytes(24).toString('hex'),role:admin.role,expires:now+8*3600000};store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(token),JSON.stringify(session));store.audit('admin_login','administrator');
    res.setHeader('Set-Cookie',`iff_engine=${token}; HttpOnly; Secure; SameSite=${cookieSameSite}; Path=/api/engine; Max-Age=28800`);json(res,200,{csrf:session.csrf,role:session.role});return true;
   }
   const token=(req.headers.cookie||'').match(/(?:^|;\s*)iff_engine=([a-f0-9]{64})(?:;|$)/)?.[1];
   const row=token?store.db.prepare('SELECT data FROM sessions WHERE token=?').get(hash(token)):null;const session=row?JSON.parse(String(row.data)):null;
   if(!session||session.expires<Date.now()){json(res,401,{error:'ADMIN_LOGIN_REQUIRED'});return true;}
   if(session.role!=='admin'){json(res,403,{error:'ADMIN_ONLY'});return true;}
   if(req.method!=='GET'&&(req.headers['x-csrf-token']!==session.csrf||!secure(req))){json(res,403,{error:'HTTPS_AND_CSRF_REQUIRED'});return true;}
   if(route==='session'&&req.method==='GET'){json(res,200,{role:'admin',csrf:session.csrf,allowPaid,secure:secure(req)});return true;}
   if(route==='logout'&&req.method==='POST'){store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));res.setHeader('Set-Cookie','iff_engine=; Secure; HttpOnly; SameSite=Strict; Path=/api/engine; Max-Age=0');json(res,200,{ok:true});return true;}
   if(route==='state'&&req.method==='GET'){json(res,200,{accounts:store.all('account').map(publicAccount),jobs:store.recent('job').map(j=>{const {previousFrame,prompt,...safe}=j;return {...safe,events:j.events.slice(-80),result:j.result?{videoVerified:j.result.videoVerified,recordedCost:j.result.recordedCost,sha256:j.result.sha256,elapsedSeconds:j.result.elapsedSeconds,ready:j.result.ready,cloud_stopped:j.result.cloud_stopped}:undefined};}),selection:store.get('config','selection'),gpus:GPUS,quality,allowPaid,spending:spending(),modelBytes:Object.values(manifest.files).reduce((n,f)=>n+f.size,0)});return true;}
   if(route==='budget'&&req.method==='POST'){const b=await body(req);if(b.limitUSD!==null&&(!Number.isFinite(b.limitUSD)||b.limitUSD<=0||b.limitUSD>10000))throw Error('INVALID_MONTHLY_LIMIT');store.put('config',{id:'budget',limitUSD:b.limitUSD});store.audit('budget_updated','application');json(res,200,spending());return true;}
   if(route==='projects'&&req.method==='GET'){json(res,200,store.all('project'));return true;}
   const sceneRoute=route.match(/^projects\/([\w-]{1,100})\/scenes$/);if(sceneRoute&&req.method==='GET'){json(res,200,store.all('scene').filter(s=>s.projectId===sceneRoute[1]));return true;}
   const referenceRoute=route.match(/^projects\/([\w-]{1,100})\/references(?:\/([a-f0-9]{64}))?$/);
   if(referenceRoute&&req.method==='GET'){
    if(!referenceRoute[2]){json(res,200,store.all('reference').filter(r=>r.projectId===referenceRoute[1]).map(({path,...r})=>r));return true;}
    const reference=store.get('reference',referenceRoute[2]);if(!reference||reference.projectId!==referenceRoute[1])throw Error('REFERENCE_NOT_FOUND');
    res.writeHead(200,{'Content-Type':reference.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(await fs.readFile(reference.path));return true;
   }
   if(route==='accounts'&&req.method==='POST') {
    const b=await body(req);if(typeof b.tokenId!=='string'||!/^ak-[\w-]{8,200}$/.test(b.tokenId)||typeof b.tokenSecret!=='string'||!/^as-[\w-]{8,300}$/.test(b.tokenSecret))throw Error('INVALID_TOKEN_FORMAT');
    const info=await provider.call('verify',{credentials:{tokenId:b.tokenId,tokenSecret:b.tokenSecret}});
    if(store.all('account').some(a=>a.workspace===info.workspace)){json(res,409,{error:'ACCOUNT_ALREADY_LINKED'});return true;}
    const aid=id(),isPrimary=info.workspace==='basm1998ali',a={id:aid,workspace:info.workspace,label:String(b.label||info.workspace).slice(0,100),mode:'token',role:isPrimary?'primary':'backup',volume:isPrimary?'modal-ltx25-test-models':'iff-ltx25-'+aid.slice(0,8),createdAt:Date.now(),credentials:store.seal({tokenId:b.tokenId,tokenSecret:b.tokenSecret},aid)};
    store.put('account',a);store.audit('account_linked',aid);json(res,201,publicAccount(a));return true;
   }
   if(route==='primary'&&req.method==='POST') {
    const info=await provider.call('verify',{credentials:{mode:'local_profile',expectedWorkspace:'basm1998ali'}});
    const existing=store.all('account').find(a=>a.workspace===info.workspace);if(existing){json(res,200,publicAccount(existing));return true;}
    const a={id:id(),workspace:info.workspace,label:'Modal الأساسي',mode:'local_profile',role:'primary',volume:'modal-ltx25-test-models',createdAt:Date.now()};store.put('account',a);store.audit('primary_linked',a.id);json(res,201,publicAccount(a));return true;
   }
   const am=route.match(/^accounts\/([a-f0-9-]+)(?:\/(check|discover|hf))?$/);
   if(am){const a=account(am[1]);
    if(req.method==='DELETE'&&!am[2]){if(store.all('job').some(j=>j.accountId===a.id&&['queued','running','ready','uncertain','recovery_required','stopping','completed'].includes(j.status)&&j.cloudStopped!==true))throw Error('STOP_AND_RECONCILE_JOBS_FIRST');store.delete('account',a.id);if(store.get('config','selection')?.accountId===a.id)store.delete('config','selection');store.audit('account_unlinked',a.id);json(res,200,{unlinked:true,remoteResourcesDeleted:false,providerTokenRevoked:false});return true;}
    if(req.method==='DELETE'&&am[2]==='hf'){delete a.hf;store.put('account',a);store.audit('hf_removed',a.id);json(res,200,{deleted:true,providerTokenRevoked:false});return true;}
    if(req.method==='POST'&&am[2]==='hf'){const b=await body(req);if(!/^hf_[A-Za-z0-9]{16,200}$/.test(b.token||''))throw Error('INVALID_HF_TOKEN');a.hf=store.seal({HF_TOKEN:b.token},a.id+':hf');store.put('account',a);store.audit('hf_saved',a.id);json(res,200,{saved:true,exportedToModal:false});return true;}
    if(req.method==='POST'&&['check','discover'].includes(am[2])){json(res,200,await discover(a));return true;}
   }
   if(route==='selection'&&req.method==='POST'){const b=await body(req),a=account(b.accountId),s=settings(b.settings);const check=await discover(a);const selection={id:'selection',accountId:a.id,settings:s,checkedAt:Date.now(),weightsReady:check.ready,capacity:'unknown_until_allocation'};store.put('config',selection);json(res,200,selection);return true;}
   if(route==='quote'&&req.method==='POST') {
    const b=await body(req),a=account(b.accountId),s=settings(b.settings);if(!['prepare','start','generate'].includes(b.action))throw Error('INVALID_ACTION');
    if(b.action==='prepare'&&(a.role==='primary'||a.workspace==='basm1998ali'))throw Error('PRIMARY_STORAGE_IS_READ_ONLY');
    const inspection=await discover(a);let plan=null,sourceId=null;
    if(b.action==='prepare') {
     let sourceFiles,sourceVolume=null;
     if(b.source==='official'){
      if(!a.hf)throw Error('HF_TOKEN_REQUIRED');if(b.licenseAccepted!==true)throw Error('MODEL_LICENSE_ACCEPTANCE_REQUIRED');
      const access=await provider.call('official_plan',{hfCredentials:store.open(a.hf,a.id+':hf'),cacheDir:path.resolve(store.folder,'metadata-cache')});sourceFiles=access.files;
     }else{const source=store.all('account').find(x=>x.role==='primary');if(!source||source.id===a.id)throw Error('PRIMARY_REQUIRES_AUTHORIZATION');const primary=await discover(source);if(!primary.ready)throw Error('SOURCE_NOT_READY');sourceId=source.id;sourceFiles=primary.files;sourceVolume=source.volume;}
     plan={source:b.source==='official'?'official':'volume',files:sourceFiles.filter(f=>a.corruptFiles?.includes(f.name)||!inspection.files.some(d=>d.name===f.name&&d.size===f.size&&d.manifestMatch)),requiredBytes:0,sourceVolume,destinationVolume:a.volume,modelRepo:manifest.model_repo,modelRevision:manifest.model_revision,licenseAccepted:b.licenseAccepted===true,licenseURL:'https://huggingface.co/Lightricks/LTX-2.5/tree/'+manifest.model_revision,
      transport:b.source==='official'?'official huggingface_hub → private resumable staging → Volume.batch_upload':'official Volume.read_file → private server staging → Volume.batch_upload',resume:b.source==='official'?'HF client resumes partial downloads when supported; completed destination files skipped':'completed files; incomplete files restart (SDK has no ranged write)',storageUSDPerMonth:Object.values(manifest.files).reduce((n,f)=>n+f.size,0)/2**30*.09,storageNote:'Undiscounted list rate; excludes free allowances, account-specific billing and continued storage after this task.',integrityReadBytes:Object.values(manifest.files).reduce((n,f)=>n+f.size,0),networkCostUSD:null,buildCostUSD:0};plan.requiredBytes=plan.files.reduce((n,f)=>n+f.size,0);
    }
    else if(!inspection.ready)throw Error('WEIGHTS_NOT_READY');
    if(b.action!=='prepare'&&(typeof b.prompt!=='string'||b.prompt.trim().length<20||b.prompt.length>12000))throw Error('PROMPT_REQUIRED');
    const est=b.action==='prepare'?{rate:null,resourceWindowUSD:null,expectedSeconds:null,recordedUSD:null,note:'SDK transfer uses local server CPU, no cloud GPU/container. Storage, traffic and server disk costs remain account/hosting dependent; quoted separately in plan.'}:estimate(s);if(b.action!=='prepare'&&est.resourceWindowUSD>s.budget)throw Error('RESOURCE_WINDOW_EXCEEDS_JOB_BUDGET');
    const ledger=spending();if(b.action!=='prepare'&&ledger.limitUSD!==null&&ledger.estimatedOrReservedUSD+est.resourceWindowUSD>ledger.limitUSD)throw Error('APPLICATION_MONTHLY_LIMIT_EXCEEDED');
    const q={id:id(),action:b.action,accountId:a.id,sourceId,settings:s,estimate:est,quality,plan,prompt:b.action==='prepare'?null:b.prompt,projectId:b.projectId,sceneId:b.sceneId,previousSceneId:b.previousSceneId,createdAt:Date.now(),expiresAt:Date.now()+300000,consumed:false};
    if(b.action==='generate'&&(!SAFE.test(b.projectId||'')||!SAFE.test(b.sceneId||'')))throw Error('PROJECT_SCENE_ID_REQUIRED');
    if(b.retryOfJobId){
     const old=store.get('job',b.retryOfJobId);if(b.action!=='generate'||!old||old.status!=='failed'||!old.cloudStopped||old.result?.videoVerified||old.projectId!==b.projectId||old.sceneId!==b.sceneId)throw Error('RETRY_REQUIRES_VERIFIED_FAILURE_AND_STOP');
     const scene=store.get('scene',hash(b.projectId+':'+b.sceneId));if(scene?.jobId!==old.id||scene.status!=='failed')throw Error('SCENE_NEWER_ATTEMPT_EXISTS_RESUME');
     let artifactExists=false;try{await fs.access(path.resolve(store.folder,'artifacts',old.id,'video.mp4'));artifactExists=true;}catch{}if(artifactExists)throw Error('EXISTING_VIDEO_REQUIRES_LOCAL_RECONCILIATION');
     q.retryOfJobId=old.id;q.initialFramePath=old.previousFrame||null;q.previousSceneId=old.previousSceneId;
    }
    if(b.initialFrame){
     if(typeof b.initialFrame!=='string'||b.initialFrame.length>5500000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.initialFrame))throw Error('INVALID_REFERENCE_IMAGE');
     const content=Buffer.from(b.initialFrame.split(',')[1],'base64');if(content.length>4000000||content.length<16)throw Error('REFERENCE_IMAGE_TOO_LARGE');
     const isImage=content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||(content[0]===255&&content[1]===216&&content[2]===255)||(content.toString('ascii',0,4)==='RIFF'&&content.toString('ascii',8,12)==='WEBP');if(!isImage)throw Error('INVALID_IMAGE_SIGNATURE');
     const refs=path.resolve(store.folder,'references');await fs.mkdir(refs,{recursive:true,mode:0o700});q.initialFramePath=path.join(refs,q.id+'.image');await fs.writeFile(q.initialFramePath,content,{mode:0o600,flag:'wx'});
    }
    if(b.action==='generate'&&b.projectSnapshot){const p=b.projectSnapshot;if(p.id!==b.projectId||JSON.stringify(p).length>1500000)throw Error('INVALID_PROJECT_SNAPSHOT');const old=store.get('project',p.id);if(old&&old.snapshot.plan.preparedAt!==p.plan?.preparedAt&&store.all('scene').some(s=>s.projectId===p.id))throw Error('PROJECT_PLAN_HAS_JOBS_CREATE_NEW_PROJECT');store.put('project',{id:b.projectId,snapshot:p,updatedAt:Date.now()});}
    if(b.references!==undefined){
     if(b.action!=='generate'||!Array.isArray(b.references)||b.references.length>8)throw Error('INVALID_PROJECT_REFERENCES');
     const refs=path.resolve(store.folder,'references');await fs.mkdir(refs,{recursive:true,mode:0o700});
     for(const ref of b.references){if(!SAFE.test(ref.assetId||''))throw Error('INVALID_REFERENCE_ID');const bytes=imageBytes(ref.data),rid=hash(b.projectId+':'+ref.assetId),digest=hash(bytes),target=path.join(refs,rid+'-'+digest+'.image'),old=store.get('reference',rid);
      if(old&&old.sha256!==digest)throw Error('REFERENCE_IMMUTABLE_USE_NEW_ASSET_ID');
      if(!old){await fs.writeFile(target,bytes,{mode:0o600});store.put('reference',{id:rid,projectId:b.projectId,assetId:ref.assetId,name:String(ref.name||'مرجع').slice(0,200),sha256:digest,path:target,mime:ref.data.slice(5,ref.data.indexOf(';'))});}
     }
    }
    store.put('quote',q);const {initialFramePath,...publicQuote}=q;json(res,200,{...publicQuote,paidEnabled:allowPaid,requiresExplicitApproval:true,capacity:'unknown; GPU allocation can fail',warning:'البناء والنقل والتخزين قد تزيد التكلفة. الحد داخل التطبيق ليس سقف فاتورة مضموناً. لا توجد إعادة محاولة تلقائية.'});return true;
   }
   if(route==='execute'&&req.method==='POST') {
    const b=await body(req),q=store.get('quote',b.quoteId);if(!allowPaid){json(res,423,{error:'PAID_ACTIONS_DISABLED_ON_SERVER'});return true;}
    if(!q||q.expiresAt<Date.now()||b.confirmation!=='أوافق على التكلفة')throw Error('FRESH_EXPLICIT_COST_APPROVAL_REQUIRED');
    const prior=store.db.prepare('SELECT job FROM intents WHERE key=?').get(q.id);if(prior){json(res,200,store.get('job',prior.job));return true;}
    const a=account(q.accountId),busy=store.all('job').filter(j=>['queued','running','ready','stopping','uncertain','recovery_required','completed'].includes(j.status)&&j.cloudStopped!==true);
    const prepared=q.action==='generate'&&busy.length===1&&busy[0].action==='start'&&busy[0].status==='ready'&&busy[0].accountId===a.id&&busy[0].prompt===q.prompt&&JSON.stringify(busy[0].settings)===JSON.stringify(q.settings)&&controllers.has(busy[0].id)?busy[0]:null;
    if(busy.length&&!prepared)throw Error('ONE_ACTIVE_OR_UNCERTAIN_JOB_ONLY');
    let sceneKey=null,previousFrame=q.initialFramePath||null;
    if(q.action==='generate'){
     sceneKey=hash(q.projectId+':'+q.sceneId);const scene=store.get('scene',sceneKey);if(scene&&!(q.retryOfJobId===scene.jobId&&scene.status==='failed')){json(res,409,{error:'SCENE_EXISTS_RESUME_EXISTING_JOB',jobId:scene.jobId,status:scene.status});return true;}
     if(q.previousSceneId){const previous=store.get('scene',hash(q.projectId+':'+q.previousSceneId));if(!previous||previous.status!=='completed')throw Error('PREVIOUS_SCENE_NOT_COMPLETE');previousFrame=path.resolve(store.folder,'artifacts',previous.jobId,'last-frame.png');let frame;try{frame=await fs.stat(previousFrame);}catch{throw Error('LAST_FRAME_NEEDS_LOCAL_RECOVERY_NO_REGENERATION');}if(frame.size<32)throw Error('LAST_FRAME_NEEDS_LOCAL_RECOVERY_NO_REGENERATION');}
    }
    if(prepared&&previousFrame)throw Error('PREPARED_ENGINE_HAS_NO_CONTINUATION_FRAME_USE_ON_DEMAND');
    const j={id:id(),quoteId:q.id,accountId:a.id,workspace:a.workspace,action:q.action,settings:q.settings,estimate:q.estimate,plan:q.plan,prompt:q.prompt,sourceId:q.sourceId,projectId:q.projectId,sceneId:q.sceneId,previousSceneId:q.previousSceneId,retryOfJobId:q.retryOfJobId,sceneKey,previousFrame,attachedEngineId:prepared?.id,appId:prepared?.appId,status:'queued',createdAt:Date.now(),events:[],cloudStopped:false};
    store.db.exec('BEGIN IMMEDIATE');try{
     const current=store.all('job').filter(x=>['queued','running','ready','stopping','uncertain','recovery_required','completed'].includes(x.status)&&!x.cloudStopped);
     if(current.length&&!(prepared&&current.length===1&&current[0].id===prepared.id&&current[0].status==='ready'))throw Error('ONE_ACTIVE_OR_UNCERTAIN_JOB_ONLY');
     const priorScene=sceneKey?store.get('scene',sceneKey):null;
     if(priorScene){const old=store.get('job',priorScene.jobId);if(q.retryOfJobId!==priorScene.jobId||priorScene.status!=='failed'||old?.status!=='failed'||!old.cloudStopped||old.result?.videoVerified)throw Error('SCENE_ALREADY_SUBMITTED');}
     const ledger=spending();if(j.action!=='prepare'&&ledger.limitUSD!==null&&ledger.estimatedOrReservedUSD+j.estimate.resourceWindowUSD>ledger.limitUSD)throw Error('APPLICATION_MONTHLY_LIMIT_EXCEEDED');
     store.db.prepare('INSERT INTO intents VALUES(?,?)').run(q.id,j.id);store.put('job',j);q.consumed=true;store.put('quote',q);if(sceneKey)store.put('scene',{id:sceneKey,projectId:q.projectId,sceneId:q.sceneId,status:'submitted',jobId:j.id,history:priorScene?[...(priorScene.history||[]),priorScene.jobId]:[]});store.audit('operation_approved',j.id);store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
    const task=run(j,a,q.sourceId?account(q.sourceId):null).catch(()=>console.error('ENGINE_LOCAL_RECORDING_FAILED: reconcile existing job; no automatic retry.',j.id));activeTasks.add(task);void task.finally(()=>activeTasks.delete(task));json(res,202,{id:j.id,status:'queued'});return true;
   }
   const jm=route.match(/^jobs\/([a-f0-9-]+)(?:\/(stop|reconcile|video))?$/);
   if(jm){const j=store.get('job',jm[1]);if(!j)throw Error('JOB_NOT_FOUND');const a=store.get('account',j.accountId)||store.all('account').find(a=>a.workspace===j.workspace);
    if(req.method==='GET'&&jm[2]==='video'){if(j.status!=='completed'||!j.result?.videoVerified)throw Error('VIDEO_NOT_READY');const video=await fs.readFile(path.resolve(store.folder,'artifacts',j.id,'video.mp4'));res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(video);return true;}
    if(req.method==='POST'&&jm[2]==='stop'){const b=await body(req);if(!b.confirmCancel)throw Error('CANCEL_CONFIRMATION_REQUIRED');if(j.status==='completed'&&j.cloudStopped){json(res,200,j);return true;}j.status='stopping';j.stopRequestedAt=Date.now();store.put('job',j);controllers.get(j.attachedEngineId||j.id)?.stop();cancellations.get(j.id)?.abort();if(j.action!=='prepare'){if(!a)throw Error('ACCOUNT_RELINK_REQUIRED_FOR_CLOUD_CHECK');const cleanup=await provider.call('stop',{credentials:credentials(a),appId:j.appId||null,jobId:j.attachedEngineId||j.id,startedAt:j.startedAt?j.startedAt/1000:undefined});Object.assign(j,store.get('job',j.id));cleanup.recordedCost=cleanup.recordedCost??j.cleanup?.recordedCost??j.result?.recordedCost??null;j.cleanup=cleanup;j.cloudStopped=cleanup.cloud_stopped===true;if(cleanup.app_id)j.appId=cleanup.app_id;if(j.cloudStopped)j.stoppedAt=Date.now();j.status=j.action==='generate'&&j.result?.videoVerified?'completed':j.cloudStopped?'stopped':'uncertain';store.put('job',j);}store.audit('stop_requested',j.id);json(res,200,j);return true;}
    if(req.method==='POST'&&jm[2]==='reconcile'){if(!a)throw Error('ACCOUNT_RELINK_REQUIRED_FOR_CLOUD_CHECK');const cleanup=await provider.call('inspect',{credentials:credentials(a),appId:j.appId||null,jobId:j.attachedEngineId||j.id,startedAt:j.startedAt?j.startedAt/1000:undefined});Object.assign(j,store.get('job',j.id));cleanup.recordedCost=cleanup.recordedCost??j.cleanup?.recordedCost??j.result?.recordedCost??null;j.cleanup=cleanup;j.cloudStopped=cleanup.cloud_stopped===true;if(j.cloudStopped)j.stoppedAt=Date.now();if(j.cleanup.app_id)j.appId=j.cleanup.app_id;if(j.cloudStopped&&j.status!=='completed'){if(!await recoverArtifact(j))j.status='stopped';}store.put('job',j);json(res,200,j);return true;}
    if(req.method==='GET'&&!jm[2]){const {previousFrame,...safe}=j;json(res,200,safe);return true;}
   }
   json(res,404,{error:'ENGINE_ROUTE_NOT_FOUND'});
  }catch(e){const code=/^[A-Z][A-Z0-9_]{3,100}$/.test(e.message)?e.message:'ENGINE_REQUEST_FAILED';json(res,400,{error:code,message:'تعذر إتمام العملية. لم تُطبع بيانات اعتماد. افحص الصلاحيات والحالة قبل إعادة أي طلب مدفوع.'});}
  return true;
 }
 return {handler,store,close:async()=>{
  for(const c of controllers.values())c.stop();for(const c of cancellations.values())c.abort();
  if(activeTasks.size){
   const stops=store.all('job').filter(j=>!j.cloudStopped&&['running','ready','stopping'].includes(j.status)&&j.action!=='prepare').map(j=>{const a=store.get('account',j.accountId);return provider.call('stop',{credentials:credentials(a),appId:j.appId||null,jobId:j.attachedEngineId||j.id,startedAt:j.startedAt?j.startedAt/1000:undefined}).catch(()=>{});});
   await Promise.race([Promise.allSettled([...activeTasks,...stops]),new Promise(r=>setTimeout(r,30000))]);
  }
  store?.close();
 }};
}
