import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, id, hash, passwordOK } from './store.mjs';
import {openStore} from './open-store.mjs';
import { settings, fixedEngineSettings, estimate, runtimeLimits, quality, qualityFor, sameEngineSettings, GPUS, manifest } from './config.mjs';
import { ModalProvider } from './provider.mjs';
import {prepareBrief} from './prompt-planner.mjs';
import {applyGenerationRules,FIXED_RULES_VERSION} from './generation-rules.mjs';
import ArabicDialogue from './arabic-dialogue.cjs';
import {emptyLibrary,validateLibrary,compileScene} from './creative-library.mjs';
import {AudioCleanupQueue,audioCapability,publicCleanup} from './audio-cleanup.mjs';
import {OpenAIDirector} from './openai-director.mjs';
import {TextQuality} from './text-quality.mjs';
import {cloudTransferPlan,cloudRequest,observeCloudTransfer} from './cloud-transfer.mjs';
const SAFE = /^[a-zA-Z0-9_-]{1,100}$/;
const publicAccount = a => { const { credentials, hf, ...safe } = a; return { ...safe, hasHF: !!hf, billing:{creditBalanceUSD:null,creditRenewalAt:null,subscriptionExpiresAt:null,availability:'not_exposed_by_supported_modal_sdk',source:'https://modal.com/docs/guide/billing'} }; };
function publicEvents(job){
    const events=job.events.filter(e=>e.kind!=='resource_status');
    const phases=['application_setup','gpu_dispatch_to_first_event','runtime_imports','pipeline_setup','transformer_build'];
    const milestones=job.action==='start'?phases.map(phase=>events.find(e=>e.phase===phase&&['app_created','phase_end'].includes(e.kind))).filter(Boolean):[];
    return [...new Set([...milestones,...events.slice(-80)])];
}
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
async function body(req) { let size = 0, parts = []; for await (const p of req) {
    size += p.length;
    if (size > 8000000)
        throw Error('BODY_TOO_LARGE');
    parts.push(p);
} return JSON.parse(Buffer.concat(parts).toString() || '{}'); }
function imageBytes(data) {
    if (typeof data !== 'string' || data.length > 5500000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data))
        throw Error('INVALID_REFERENCE_IMAGE');
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    if (bytes.length < 16 || bytes.length > 4000000)
        throw Error('INVALID_REFERENCE_IMAGE');
    if (!(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')))
        throw Error('INVALID_IMAGE_SIGNATURE');
    return bytes;
}
export async function createEngineAPI({ folder = process.env.ENGINE_DATA_DIR || '.engine-data', key = process.env.ENGINE_MASTER_KEY, provider = new ModalProvider(), allowPaid = process.env.ENGINE_ALLOW_PAID_ACTIONS === 'YES', origin = process.env.ENGINE_ORIGIN || 'https://localhost:3443', trustProxy = process.env.ENGINE_TRUST_PROXY === 'loopback', cookieSameSite = process.env.ENGINE_COOKIE_SAME_SITE === 'none' ? 'None' : 'Strict', store = undefined, primaryOnly=process.env.ENGINE_PRIMARY_ONLY==='YES',cloudTransferApp=process.env.ENGINE_CLOUD_TRANSFER_APP||'',textFetch=fetch,textQuality=undefined } = {}) {
    if(store===undefined)store=await openStore(folder,key);
    textQuality??=new TextQuality(folder);
    // Retire the old encrypted provider keys without removing job receipts/media.
    if(store){for(const name of ['openrouter-video','openrouter-chat'])await store.delete('config',name);for(const record of await store.all('router-video-request'))if(record.credentials){delete record.credentials;await store.put('router-video-request',record);}}
    const audioQueue=store?new AudioCleanupQueue(store):null;await audioQueue?.initialize();
    if(store)await store.put('config',{id:'audio-cleanup',enabled:true,attenuationDb:6});
    const textDirector=store?new OpenAIDirector(store,{fetcher:textFetch}):null;await textDirector?.initialize();
    if(store){const selected=await store.get('config','selection');const active=(await store.all('job')).some(j=>['queued','running','ready','stopping','uncertain','recovery_required'].includes(j.status)&&!j.cloudStopped);if(selected&&!active){selected.settings=fixedEngineSettings(selected.settings||{});await store.put('config',selected);}}
    const allowedOrigins = new Set((process.env.ENGINE_ALLOWED_ORIGINS || origin).split(',').map(s => s.trim()));
    const attempts = new Map(), controllers = new Map(), cancellations = new Map(), activeTasks = new Set();
    const cancelledApps=new Set();
    const cloudMonitors=new Set();
    const isCloud=j=>j?.action==='prepare'&&j.plan?.transport==='modal-cpu-cloud';
    const requirePrimary=a=>{if(primaryOnly&&(a.workspace!=='basm1998ali'||a.role!=='primary'))throw Error('PRIMARY_ACCOUNT_IS_FIXED');};
    if (store)
        for (const j of (await store.all('job')))
            if (['queued', 'running', 'stopping', 'ready'].includes(j.status)) {
                j.status = 'recovery_required';
                j.error = 'SERVER_RESTART_RECONCILE_BEFORE_RETRY';
                (await store.put('job', j));
            }
    function credentials(a) { return a.mode === 'local_profile' ? { mode: 'local_profile', expectedWorkspace: a.workspace } : { ...store.open(a.credentials, a.id), expectedWorkspace: a.workspace }; }
    async function spending() {
        const groups = new Map(), month = new Date().toISOString().slice(0, 7);
        for (const j of (await store.all('job')))
            if ((j.action !== 'prepare'||isCloud(j)) && new Date(j.createdAt).toISOString().startsWith(month)) {
                const group = j.appId || j.attachedEngineId || j.id, prior = groups.get(group) || 0;
                const recorded = j.cleanup?.recordedCost?.usd ?? j.result?.recordedCost?.usd;
                const elapsedUSD=Math.max(0,(Date.now()-(j.startedAt||j.createdAt))/1000)*(j.estimate?.rate||0);
                const value = recorded !== undefined ? Number(recorded) : ['queued', 'running', 'ready', 'stopping', 'uncertain', 'recovery_required'].includes(j.status) && !j.cloudStopped ? (j.estimate?.resourceWindowUSD??elapsedUSD) : (j.estimatedUSD ?? j.estimate?.resourceWindowUSD ?? elapsedUSD);
                groups.set(group, Math.max(prior, value));
            }
        return { month, estimatedOrReservedUSD: [...groups.values()].reduce((a, b) => a + b, 0), limitUSD: (await store.get('config', 'budget'))?.limitUSD ?? null, note: 'Mixed recorded/estimated/reserved compute ledger, not Modal invoice; excludes unknown traffic, storage and hosting fees.' };
    }
    async function recoverArtifact(j) {
        try {
            const folder = path.resolve(store.folder, 'artifacts', j.id), receipt = JSON.parse(await fs.readFile(path.join(folder, 'audit.json'), 'utf8')), video = await fs.readFile(path.join(folder, 'video.mp4'));
            if(receipt.audit?.pipeline==='DFRPipeline'&&receipt.textQuality?.status!=='passed')return false;
            if (!receipt.videoVerified || hash(video) !== receipt.sha256 || !receipt.metadata?.ffprobe?.streams?.some(s => s.codec_type === 'audio'))
                return false;
            const v = receipt.metadata.ffprobe.streams.find(s => s.codec_type === 'video');
            const expected=j.quality||{width:j.settings?.orientation==='landscape'?1024:576,height:j.settings?.orientation==='landscape'?576:1024};
            if (v.width !== expected.width || v.height !== expected.height)
                return false;
            j.result = { ...receipt, ...j.cleanup };
            j.status = 'completed';
            j.error = null;
            const scene = (await store.get('scene', j.sceneKey));
            if (scene) {
                scene.status = 'completed';
                scene.sha256 = receipt.sha256;
                scene.artifact = '/api/engine/jobs/' + j.id + '/video';
                (await store.put('scene', scene));
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async function account(aid) { const a = (await store.get('account', aid)); if (!a)
        throw Error('ACCOUNT_NOT_FOUND'); return a; }
    const secure = req => !!req.socket.encrypted || (trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https');
    async function discover(a) { const result = await provider.call('discover', { credentials: credentials(a), volume: a.volume });
        result.productionQuality=await provider.call('quality_discover',{credentials:credentials(a),volume:a.volume});
        if (a.corruptFiles?.length) {
        result.ready = false;
        result.requiresIntegrityRepair = a.corruptFiles;
    } a.discovery = { ...result, checkedAt: Date.now() }; (await store.put('account', a)); (await store.audit('account_inspected', a.id)); return result; }
    async function event(job, data) {
        if(isCloud(job)&&data.sequence&&data.sequence<=(job.transferSequence||0))return;
        if(isCloud(job)&&data.sequence)job.transferSequence=data.sequence;
        const latest = (await store.get('job', job.id));
        const safe = {};
        for (const field of ['kind', 'phase', 'seconds', 'completed', 'total', 'global_completed','global_total','unit', 'transferred', 'required', 'file', 'app_id', 'ready_until', 'running_containers', 'cloud_stopped', 'state', 'time', 'rate', 'eta', 'status', 'error_type', 'device', 'allocated_vram_bytes', 'reserved_vram_bytes','sequence','call_id','worker_app_id'])
            if (Object.hasOwn(data, field))
                safe[field] = data[field];
        job.events.push({ ...safe, receivedAt: Date.now() });
        if(data.call_id)job.cloudCallId=data.call_id;
        if(data.worker_app_id)job.workerAppId=data.worker_app_id;
        if (job.events.length > 2000)
            job.events.shift();
        if (data.app_id)
            job.appId = data.app_id;
        if(data.ready_until)job.readyUntil=data.ready_until;
        if (data.kind === 'ready' && !latest?.stopRequestedAt)
            job.status = 'ready';
        if (data.kind === 'phase_start' && job.status === 'ready')
            job.status = 'running';
        if (data.cloud_stopped === true)
            job.cloudStopped = true;
        if (data.kind === 'file_verified' && data.file) {
            job.verifiedFiles = [...new Set([...(job.verifiedFiles || []), data.file])];
        }
        if (latest?.stopRequestedAt) {
            job.stopRequestedAt = latest.stopRequestedAt;
            if (!job.cloudStopped)
                job.status = 'stopping';
        }
        job.updatedAt = Date.now();
        (await store.put('job', job));
        if(latest?.stopRequestedAt&&data.kind==='app_created'&&data.app_id&&!cancelledApps.has(data.app_id)){
            cancelledApps.add(data.app_id);controllers.get(job.attachedEngineId||job.id)?.stop();
            const a=await account(job.accountId);
            try{const cleanup=await provider.call('stop',{credentials:credentials(a),appId:data.app_id,jobId:job.attachedEngineId||job.id});job.cleanup=cleanup;job.cloudStopped=cleanup.cloud_stopped===true;await store.put('job',job);}catch{/* Keep uncertain until an explicit reconciliation. */}
        }
    }
    async function transferControl(job,a){
        const source=await account(job.sourceId);
        return cloudRequest(job,a,credentials(source),job.plan.workerApp,credentials(a));
    }
    async function finishCloud(job,a,result){
        if(!result.cloud_stopped)throw Error('CLOUD_TRANSFER_STOP_UNCONFIRMED');
        const latest=await store.get('job',job.id);if(latest?.stopRequestedAt)job.stopRequestedAt=latest.stopRequestedAt;
        job.result=result;job.cloudStopped=true;job.finishedAt=Date.now();job.stoppedAt=Date.now();
        if(result.verifiedFiles)job.verifiedFiles=result.verifiedFiles;
        job.elapsedSeconds=(Date.now()-(job.startedAt||job.createdAt))/1000;job.estimatedUSD=(job.elapsedSeconds+(result.destinationComputeSeconds||0))*job.estimate.rate;
        if(result.verificationOnly&&!result.requiresNewPlan){job.status='completed';job.error=null;a.lastIntegrityVerification={jobId:job.id,at:Date.now(),verifiedFiles:result.verifiedFiles||[]};}
        else if(result.probeVerified){job.status='completed';job.error=null;a.lastTransferProbe={verified:true,jobId:job.id,at:Date.now(),bytes:result.transferredBytes};}
        else if(result.requiresNewPlan){job.status='needs_review';job.error='INTEGRITY_CHANGED_SCOPE_APPROVE_NEW_PLAN';a.corruptFiles=result.corruptFiles;a.discovery={...a.discovery,ready:false};}
        else if(result.ready){job.status='completed';job.error=null;a.discovery={...result.inspection,checkedAt:Date.now(),hashVerifiedByTransfer:true};a.corruptFiles=[];}
        else{job.status=job.stopRequestedAt?'stopped':'failed';job.error=result.error||'CLOUD_TRANSFER_FAILED';a.discovery={...a.discovery,ready:false};}
        job.updatedAt=Date.now();await store.put('account',a);await store.put('job',job);
    }
    async function watchCloud(job,a){
        const result=await observeCloudTransfer({provider,request:await transferControl(job,a),onEvent:e=>event(job,e),deadline:(job.startedAt||job.createdAt)+((job.plan.compute?.totalWindowSeconds??job.plan.compute?.windowSeconds??3782)+120)*1000});
        await finishCloud(job,a,result);return result;
    }
    function resumeCloud(job){
        if(cloudMonitors.has(job.id))return;
        cloudMonitors.add(job.id);
        const task=(async()=>{try{await watchCloud(job,await account(job.accountId));}catch{job.status='uncertain';job.error='CLOUD_TRANSFER_RECONCILIATION_REQUIRED';job.cloudStopped=false;await store.put('job',job);}finally{cloudMonitors.delete(job.id);}})();
        activeTasks.add(task);void task.finally(()=>activeTasks.delete(task));
    }
    async function run(job, a, source) {
        if(isCloud(job))cloudMonitors.add(job.id);
        let events=Promise.resolve(),eventError=false;
        const queueEvent=data=>{events=events.then(()=>event(job,data)).catch(()=>{eventError=true;});};
        job.status = 'running';
        job.startedAt = Date.now();
        (await store.put('job', job));
        const cancel = new AbortController();
        cancellations.set(job.id, cancel);
        try {
            const latest=await store.get('job',job.id);
            if(latest?.stopRequestedAt){job.stopRequestedAt=latest.stopRequestedAt;job.status='stopped';job.cloudStopped=true;return;}
            const payload = { credentials: credentials(a), source: source ? credentials(source) : null, sourceVolume: source?.volume, volume: a.volume, settings: job.settings, plan: job.plan, jobId: job.id, prompt: job.prompt, previousFrame: job.previousFrame, hfCredentials: job.plan?.source === 'official' ? store.open(a.hf, a.id + ':hf') : undefined, paidApproved: true, artifactDir: path.resolve(store.folder, 'artifacts', job.id), stagingDir: path.resolve(store.folder, 'transfer-cache', a.id) };
            if(isCloud(job)){
                const receipt=await provider.call('cloud_transfer_dispatch',{...payload,workerApp:job.plan.workerApp},queueEvent,600000);
                await events;if(eventError)throw Error('EVENT_RECORDING_FAILED_RECONCILE');
                await event(job,{kind:'transfer_dispatched',phase:'connection',...receipt});
                job.result=await watchCloud(job,a);return;
            }
            if (job.action === 'start') {
                const control = provider.session(payload, queueEvent);
                controllers.set(job.id, control);
                job.result = await control.done;
                controllers.delete(job.id);
            }
            else if (job.attachedEngineId) {
                const control = controllers.get(job.attachedEngineId);
                if (!control)
                    throw Error('ENGINE_SESSION_EXPIRED');
                job.result = await control.generate(payload, queueEvent);
            }
            else
                job.result = await provider.call(job.action === 'prepare' ? 'transfer' : 'generate', payload, queueEvent, (job.action === 'prepare' ? 86400 : runtimeLimits(job.settings).timeout + runtimeLimits(job.settings).startup + 240) * 1000, cancel.signal);
            await events;
            if(eventError)throw Error('EVENT_RECORDING_FAILED_RECONCILE');
            if(job.action==='generate'&&job.result.videoVerified){
                try{job.result=await textQuality.process(job,job.result,data=>event(job,data));}
                catch{job.result={...job.result,generationSucceeded:true,textQuality:{status:'needs_review',error:'TEXT_QC_FAILED_ORIGINAL_PRESERVED'}};}
                if(job.result.textQuality?.status!=='passed'){
                    job.status='needs_review';job.error='GENERATION_SUCCEEDED_TEXT_REVIEW_REQUIRED';
                    job.cloudStopped=job.result.cloud_stopped===true;
                    const scene=await store.get('scene',job.sceneKey);if(scene){scene.status='needs_review';await store.put('scene',scene);}
                    return;
                }
            }
            job.status = job.action === 'start' ? 'stopped' : 'completed';
            job.completedAt = Date.now();
            job.cloudStopped = job.result.cloud_stopped === true;
            if (job.action === 'prepare') {
                a.discovery = job.result.inspection ? { ...job.result.inspection, checkedAt: Date.now(), hashVerifiedByTransfer: true } : null;
                if (job.result.requiresNewPlan) {
                    a.corruptFiles = job.result.corruptFiles;
                    job.status = 'needs_review';
                    job.error = 'INTEGRITY_CHANGED_SCOPE_APPROVE_NEW_PLAN';
                }
                else if (job.result.ready)
                    a.corruptFiles = [];
                (await store.put('account', a));
            }
            if (job.action === 'generate') {
                if (!job.result.videoVerified)
                    throw Error('MP4_NOT_VERIFIED');
                const scene = (await store.get('scene', job.sceneKey));
                scene.status = 'completed';
                scene.jobId = job.id;
                scene.artifact = '/api/engine/jobs/' + job.id + '/video';
                scene.sha256 = job.result.sha256;
                (await store.put('scene', scene));
            }
        }
        catch {
            await events;
            const stopped=await store.get('job',job.id);if(stopped?.stopRequestedAt)job.stopRequestedAt=stopped.stopRequestedAt;
            // A local persistence/transport failure is NOT proof that cloud generation failed.
            const heldForText=job.result?.videoVerified&&job.quality?.textQualityRequired&&job.result.textQuality?.status!=='passed';
            job.status = heldForText?'needs_review':job.result?.videoVerified ? 'completed' : 'uncertain';
            job.error = heldForText?'GENERATION_SUCCEEDED_TEXT_REVIEW_REQUIRED':job.result?.videoVerified ? 'GENERATION_SUCCEEDED_LOCAL_RECORDING_NEEDS_RECONCILIATION' : 'OPERATION_STATE_UNCERTAIN_DO_NOT_RESUBMIT';
            if (job.action === 'prepare'&&!isCloud(job)) {
                job.status = 'failed';
                job.cloudStopped = true;
            }
            else if(isCloud(job)){
                try{job.cleanup=await provider.call('cloud_transfer_stop',await transferControl(job,a));job.cloudStopped=job.cleanup.cloud_stopped===true;}catch{job.cloudStopped=false;}
                job.status=job.cloudStopped?'failed':'uncertain';job.error='CLOUD_TRANSFER_RECONCILIATION_REQUIRED';
            }
            else
                try {
                    job.cleanup = await provider.call('stop', { credentials: credentials(a), appId: job.appId || null, jobId: job.attachedEngineId || job.id });
                    job.cloudStopped = job.cleanup.cloud_stopped === true;
                    if (job.cleanup.app_id)
                        job.appId = job.cleanup.app_id;
                }
                catch {
                    job.cloudStopped = false;
                }
            if (job.action === 'generate' && !job.result?.videoVerified && job.cloudStopped && job.events.some(e => e.kind === 'phase_error')) {
                job.status = 'failed';
                job.error = 'GPU_REPORTED_FAILURE_CLOUD_STOPPED_NO_AUTOMATIC_RETRY';
                const scene = (await store.get('scene', job.sceneKey));
                if (scene?.jobId === job.id) {
                    scene.status = 'failed';
                    (await store.put('scene', scene));
                }
            }
            if(job.stopRequestedAt&&job.cloudStopped&&!job.result?.videoVerified){job.status='stopped';job.error=null;}
        }
        finally {
            if(isCloud(job))cloudMonitors.delete(job.id);
            if(job.action==='start')controllers.delete(job.id);
            if(job.action==='start'&&job.cloudStopped){
                for(const child of await store.all('job'))if(child.attachedEngineId===job.id&&child.result?.videoVerified){
                    child.cloudStopped=true;child.stoppedAt=Date.now();
                    child.cleanup=job.result||job.cleanup;await store.put('job',child);
                }
            }
            cancellations.delete(job.id);
            job.updatedAt = Date.now();
            job.finishedAt = Date.now();
            if (job.cloudStopped)
                job.stoppedAt = Date.now();
            job.elapsedSeconds = (Date.now() - job.startedAt) / 1000;
            job.estimatedUSD = job.action === 'prepare'&&!isCloud(job) ? null : job.elapsedSeconds * job.estimate.rate;
            (await store.put('job', job));
            (await store.audit('operation_finished', job.id));
        }
    }
    async function handler(req, res) {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/engine/'))
            return false;
        try {
            const requestOrigin = req.headers.origin;
            if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
                json(res, 403, { error: 'ORIGIN_DENIED' });
                return true;
            }
            if (requestOrigin) {
                res.setHeader('Access-Control-Allow-Origin', requestOrigin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Vary', 'Origin');
            }
            if (url.pathname === '/api/engine/health' && req.method === 'GET') {
                json(res, 200, { service: 'iraqi-film-forge-engine-v1', configured: !!(store && (await store.get('admin', 'administrator'))), secure: secure(req) });
                return true;
            }
            if (!store) {
                json(res, 503, { error: 'BACKEND_NOT_CONFIGURED', message: 'الخادم يحتاج مفتاح تشفير ومسؤولاً؛ لا يمكن استقبال توكنات حالياً.' });
                return true;
            }
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
                res.writeHead(204);
                res.end();
                return true;
            }
            const route = url.pathname.slice('/api/engine/'.length);
            if (route === 'login' && req.method === 'POST') {
                if (!secure(req)) {
                    json(res, 426, { error: 'HTTPS_REQUIRED' });
                    return true;
                }
                const ip = req.socket.remoteAddress, now = Date.now(), prior = attempts.get(ip) || { n: 0, until: now + 60000 };
                if (prior.until < now) {
                    prior.n = 0;
                    prior.until = now + 60000;
                }
                prior.n++;
                attempts.set(ip, prior);
                if (prior.n > 10) {
                    json(res, 429, { error: 'LOGIN_RATE_LIMIT' });
                    return true;
                }
                const b = await body(req), admin = (await store.get('admin', 'administrator'));
                if (!admin || b.username !== admin.username || typeof b.password !== 'string' || b.password.length > 500 || !passwordOK(b.password, admin.password)) {
                    json(res, 401, { error: 'INVALID_LOGIN' });
                    return true;
                }
                const token = randomBytes(32).toString('hex'), session = { csrf: randomBytes(24).toString('hex'), role: admin.role, expires: now + 8 * 3600000 };
                (await store.sessionPut(hash(token), session));
                (await store.audit('admin_login', 'administrator'));
                res.setHeader('Set-Cookie', [`iff_engine=${token}; HttpOnly; Secure; SameSite=${cookieSameSite}; Path=/; Max-Age=28800`,'iff_engine=; HttpOnly; Secure; SameSite=Strict; Path=/api/engine; Max-Age=0']);
                json(res, 200, { csrf: session.csrf, role: session.role });
                return true;
            }
            const token = (req.headers.cookie || '').match(/(?:^|;\s*)iff_engine=([a-f0-9]{64})(?:;|$)/)?.[1];
            const session = token ? (await store.sessionGet(hash(token))) : null;
            if (!session || session.expires < Date.now()) {
                json(res, 401, { error: 'ADMIN_LOGIN_REQUIRED' });
                return true;
            }
            if (session.role !== 'admin') {
                json(res, 403, { error: 'ADMIN_ONLY' });
                return true;
            }
            if (req.method !== 'GET' && (req.headers['x-csrf-token'] !== session.csrf || !secure(req))) {
                json(res, 403, { error: 'HTTPS_AND_CSRF_REQUIRED' });
                return true;
            }
            if (route === 'session' && req.method === 'GET') {
                json(res, 200, { role: 'admin', csrf: session.csrf, allowPaid, secure: secure(req) });
                return true;
            }
            if(route==='llm/config'&&req.method==='GET'){json(res,200,await textDirector.config());return true;}
            if(route==='llm/config'&&req.method==='POST'){json(res,200,await textDirector.save(await body(req)));return true;}
            if(route==='llm/config'&&req.method==='DELETE'){json(res,200,await textDirector.remove());return true;}
            if(route==='llm/calls'&&req.method==='POST'){json(res,202,await textDirector.submit(await body(req)));return true;}
            const textCall=route.match(/^llm\/calls\/([a-zA-Z0-9_-]{1,100})$/);
            if(textCall&&req.method==='GET'){json(res,200,await textDirector.get(textCall[1]));return true;}
            if(route==='projects/save'&&req.method==='POST'){
                const {snapshot:p}=await body(req);
                if(!p||!SAFE.test(p.id||'')||typeof p.name!=='string'||p.name.length>300||!Array.isArray(p.messages)||p.messages.length>500||JSON.stringify(p).length>1500000)throw Error('INVALID_PROJECT_SNAPSHOT');
                const allowed=new Set(['id','name','messages','assets','random','plan','approved','created','videoProvider','jobs','directorState']);
                if(Object.keys(p).some(k=>!allowed.has(k)))throw Error('PROJECT_FIELDS_NOT_ALLOWED');
                if(p.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>50000||Object.keys(m).some(k=>!['role','content'].includes(k))))throw Error('INVALID_CONVERSATION');
                const old=await store.get('project',p.id);
                if(old?.deletedAt)throw Error('PROJECT_ARCHIVED_RESTORE_FIRST');
                const hasJobs=(await store.all('scene')).some(s=>s.projectId===p.id);
                if(old&&hasJobs&&old.snapshot.plan?.preparedAt!==p.plan?.preparedAt)throw Error('PROJECT_PLAN_HAS_JOBS_CREATE_NEW_PROJECT');
                const forbidden=value=>value&&typeof value==='object'&&Object.entries(value).some(([k,v])=>/^(tokenId|tokenSecret|HF_TOKEN|password|credentials|apiKey|authorization)$/i.test(k)||forbidden(v));
                if(forbidden(p))throw Error('CREDENTIAL_FIELDS_NOT_ALLOWED_IN_PROJECT');
                const snapshot={...p,assets:(p.assets||[]).map(a=>({id:String(a.id).slice(0,100),name:String(a.name).slice(0,200)}))};
                await store.put('project',{id:p.id,snapshot,updatedAt:Date.now()});
                await store.audit('project_saved',p.id);json(res,200,{saved:true,id:p.id});return true;
            }
            if (route === 'logout' && req.method === 'POST') {
                (await store.sessionDelete(hash(token)));
                res.setHeader('Set-Cookie', ['iff_engine=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0','iff_engine=; Secure; HttpOnly; SameSite=Strict; Path=/api/engine; Max-Age=0']);
                json(res, 200, { ok: true });
                return true;
            }
            if (route === 'state' && req.method === 'GET') {
                for(const j of await store.all('job'))if(isCloud(j)&&!j.cloudStopped&&['running','queued','recovery_required','uncertain','stopping'].includes(j.status))resumeCloud(j);
                json(res, 200, { accounts: (await store.all('account')).map(publicAccount), jobs: (await store.recent('job')).map(j => { const { previousFrame, prompt, ...safe } = j; return { ...safe, events: publicEvents(j), result: j.result ? { videoVerified: j.result.videoVerified, generationSucceeded:j.result.generationSucceeded, textQuality:j.result.textQuality?{status:j.result.textQuality.status,seconds:j.result.textQuality.seconds}:undefined, recordedCost: j.result.recordedCost, sha256: j.result.sha256, elapsedSeconds: j.result.elapsedSeconds, ready: j.result.ready, probeVerified:j.result.probeVerified,verificationOnly:j.result.verificationOnly,gpuUsed:j.result.gpuUsed,transferredBytes:j.result.transferredBytes,cloud_stopped: j.result.cloud_stopped } : undefined }; }), selection: (await store.get('config', 'selection')), gpus: GPUS, quality, allowPaid, spending: (await spending()), modelBytes: Object.values(manifest.files).reduce((n, f) => n + f.size, 0) });
                return true;
            }
            if (route === 'budget' && req.method === 'POST') {
                const b = await body(req);
                if (b.limitUSD !== null && (!Number.isFinite(b.limitUSD) || b.limitUSD <= 0 || b.limitUSD > 10000))
                    throw Error('INVALID_MONTHLY_LIMIT');
                (await store.put('config', { id: 'budget', limitUSD: b.limitUSD }));
                (await store.audit('budget_updated', 'application'));
                json(res, 200, (await spending()));
                return true;
            }
            const conversation=route.match(/^projects\/([\w-]{1,100})\/(rename|archive|restore)$/);
            if(conversation&&req.method==='POST'){
                const p=await store.get('project',conversation[1]);if(!p)throw Error('PROJECT_NOT_FOUND');
                if((await store.all('job')).some(j=>j.projectId===p.id&&!j.cloudStopped&&['queued','running','uncertain','recovery_required','stopping'].includes(j.status)))throw Error('PROJECT_HAS_ACTIVE_JOB');
                if(conversation[2]==='rename'){const b=await body(req);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>120)throw Error('INVALID_PROJECT_NAME');p.snapshot.name=b.name.trim();}
                if(conversation[2]==='archive')p.deletedAt=Date.now();if(conversation[2]==='restore')delete p.deletedAt;
                p.updatedAt=Date.now();await store.put('project',p);await store.audit('conversation_'+conversation[2],p.id);json(res,200,{id:p.id,name:p.snapshot.name,archived:!!p.deletedAt,videosPreserved:true});return true;
            }
            if (route === 'projects' && req.method === 'GET') {
                json(res, 200, (await store.all('project')).filter(p=>!p.deletedAt));
                return true;
            }
            if(route==='projects/archived'&&req.method==='GET'){json(res,200,(await store.all('project')).filter(p=>p.deletedAt).sort((a,b)=>b.deletedAt-a.deletedAt));return true;}
            if(route==='draft'&&req.method==='GET'){json(res,200,(await store.get('config','scene-description'))||{prompt:'',orientation:'portrait'});return true;}
            if(route==='prompt/prepare'&&req.method==='POST'){json(res,200,prepareBrief(await body(req)));return true;}
            if(route==='draft'&&req.method==='POST'){
                const b=await body(req);
                if(typeof b.prompt!=='string'||b.prompt.length>12000||!['portrait','landscape'].includes(b.orientation))throw Error('INVALID_DRAFT');
                await store.put('config',{id:'scene-description',prompt:b.prompt,orientation:b.orientation,updatedAt:Date.now()});
                json(res,200,{saved:true});return true;
            }
            if(route==='creative/ingredients-plan'&&req.method==='GET'){const plan=JSON.parse(await fs.readFile(new URL('./ingredients-plan.json',import.meta.url),'utf8'));json(res,200,{...plan,estimatedStorageUSDPerMonth:plan.bytes/2**30*plan.undiscountedStorageUSDPerGiBMonth});return true;}
            if(route==='creative/library'&&req.method==='GET'){
                json(res,200,{library:(await store.get('config','creative-library'))||emptyLibrary(),capabilities:{speakerBinding:'explicit prompt contract',imageReferences:'private persistent storage',ingredients:{ready:false,reason:'Adapter and additional LoRA weights are not provisioned; saved reference images are not multi-image model conditioning'},voiceReferences:{ready:false,reason:'Native audio reference inference is not configured; voice descriptions only'}}});return true;
            }
            if(route==='creative/library'&&req.method==='POST'){
                const library=validateLibrary(await body(req));
                for(const entry of [...library.characters,...library.props])if(entry.referenceId){const ref=await store.get('reference',entry.referenceId);if(!ref||ref.projectId!=='creative-library')throw Error('REFERENCE_NOT_FOUND');}
                await store.transaction(async()=>{const old=(await store.get('config','creative-library'))||emptyLibrary();if(old.revision!==library.revision)throw Error('CREATIVE_LIBRARY_CHANGED_RELOAD');await store.put('creative-library-history',{...old,id:String(old.revision),savedAt:Date.now()});library.revision++;await store.put('config',library);await store.audit('creative_library_saved','creative-library');});
                json(res,200,{library});return true;
            }
            if(route==='creative/reference'&&req.method==='POST'){
                const b=await body(req);if(!SAFE.test(b.assetId||''))throw Error('INVALID_REFERENCE_ID');
                const bytes=imageBytes(b.data),rid=hash('creative-library:'+b.assetId),digest=hash(bytes),old=await store.get('reference',rid);
                if(old&&old.sha256!==digest)throw Error('REFERENCE_ASSET_IMMUTABLE_USE_NEW_ID');
                const folder=path.join(store.folder,'references');await fs.mkdir(folder,{recursive:true,mode:0o700});const target=path.join(folder,rid+'-'+digest+'.image');
                if(!old){await fs.writeFile(target,bytes,{mode:0o600,flag:'wx'});await store.put('reference',{id:rid,projectId:'creative-library',assetId:b.assetId,name:String(b.name||'مرجع').slice(0,100),sha256:digest,path:target,mime:b.data.slice(5,b.data.indexOf(';'))});}
                json(res,200,{id:rid,sha256:digest,conditioningActive:false});return true;
            }
            if(route==='audio/config'&&req.method==='GET'){json(res,200,{config:(await store.get('config','audio-cleanup'))||{id:'audio-cleanup',enabled:false,attenuationDb:6},capability:await audioCapability()});return true;}
            if(route==='audio/config'&&req.method==='POST'){
                const b=await body(req);if(typeof b.enabled!=='boolean'||![3,6,12].includes(b.attenuationDb))throw Error('INVALID_AUDIO_SETTINGS');
                if(b.enabled&&!(await audioCapability()).ready)throw Error('AUDIO_CLEANUP_UNAVAILABLE');
                await store.put('config',{id:'audio-cleanup',enabled:b.enabled,attenuationDb:b.attenuationDb,updatedAt:Date.now()});await store.audit('audio_cleanup_settings','native-audio-only');json(res,200,{saved:true});return true;
            }
            const audioRoute=route.match(/^jobs\/([a-f0-9-]+)\/(audio-cleanup|clean-video)$/);
            if(audioRoute){
                const j=await store.get('job',audioRoute[1]);if(!j||j.status!=='completed'||!j.result?.videoVerified)throw Error('VIDEO_NOT_READY');
                if(req.method==='POST'&&audioRoute[2]==='audio-cleanup'){
                    const b=await body(req);if(b.approvedCpuProcessing!==true)throw Error('CPU_PROCESSING_APPROVAL_REQUIRED');
                    if(!(await audioCapability()).ready)throw Error('AUDIO_CLEANUP_UNAVAILABLE');
                    const record=await audioQueue.request(j,{attenuationDb:b.attenuationDb??6,retry:b.retry===true});json(res,202,publicCleanup(record));return true;
                }
                const requestedId=url.searchParams.get('id');if(requestedId&&!/^[a-f0-9]{64}$/.test(requestedId))throw Error('INVALID_AUDIO_RECORD');
                const record=requestedId?await store.get('audio-cleanup',requestedId):(await store.all('audio-cleanup')).filter(r=>r.jobId===j.id).sort((a,b)=>b.createdAt-a.createdAt)[0];
                if(record&&record.jobId!==j.id)throw Error('INVALID_AUDIO_RECORD');
                if(req.method==='GET'&&audioRoute[2]==='audio-cleanup'){json(res,200,publicCleanup(record));return true;}
                if(req.method==='GET'&&audioRoute[2]==='clean-video'){
                    if(!record||record.status!=='completed'||!record.result?.videoBitstreamUnchanged)throw Error('CLEAN_AUDIO_NOT_READY');
                    const bytes=await fs.readFile(path.join(store.folder,'audio-cleanups',record.id,'clean.mp4'));if(hash(bytes)!==record.result.sha256)throw Error('CLEAN_AUDIO_HASH_MISMATCH');
                    res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return true;
                }
            }
            const networkRoute=route.match(/^projects\/([\w-]{1,100})\/network$/);
            if(networkRoute&&req.method==='GET'){
                const record=await store.get('project',networkRoute[1]);if(!record?.snapshot?.plan)throw Error('PROJECT_NOT_FOUND');
                const p=record.snapshot,scenes=(await store.all('scene')).filter(s=>s.projectId===networkRoute[1]),slots=[];
                if(!Array.isArray(p.plan.slots)||p.plan.slots.length>360)throw Error('INVALID_PROJECT_PLAN');
                for(const slot of p.plan.slots||[]){
                    const scene=scenes.find(s=>s.sceneId==='scene-'+slot.index),job=scene?.jobId?await store.get('job',scene.jobId):null;
                    const phase=job?.events?.filter(e=>e.phase).at(-1)?.phase||null,measured=job?.events?.filter(e=>e.phase===phase&&typeof e.completed==='number'&&typeof e.total==='number').at(-1);
                    slots.push({index:slot.index,start:slot.start,end:slot.end,status:job?job.status==='completed'&&job.result?.videoVerified?'done':job.status==='completed'?'uncertain':job.status:'pending',jobId:job?.id||null,videoURL:job?.status==='completed'&&job.result?.videoVerified?'/api/engine/jobs/'+job.id+'/video':null,phase,completed:measured?.completed??null,total:measured?.total??null});
                }
                json(res,200,{id:networkRoute[1],name:p.name,plan:{title:p.plan.title||p.name,seconds:p.plan.seconds||p.plan.duration_seconds,slots},updatedAt:Date.now(),source:'server-persisted-project-scene-job-records',cloudMutation:false});return true;
            }
            const sceneRoute = route.match(/^projects\/([\w-]{1,100})\/scenes$/);
            if (sceneRoute && req.method === 'GET') {
                json(res, 200, (await store.all('scene')).filter(s => s.projectId === sceneRoute[1]));
                return true;
            }
            const referenceRoute = route.match(/^projects\/([\w-]{1,100})\/references(?:\/([a-f0-9]{64}))?$/);
            if (referenceRoute && req.method === 'GET') {
                if (!referenceRoute[2]) {
                    json(res, 200, (await store.all('reference')).filter(r => r.projectId === referenceRoute[1]).map(({ path, ...r }) => r));
                    return true;
                }
                const reference = (await store.get('reference', referenceRoute[2]));
                if (!reference || reference.projectId !== referenceRoute[1])
                    throw Error('REFERENCE_NOT_FOUND');
                res.writeHead(200, { 'Content-Type': reference.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
                res.end(await fs.readFile(reference.path));
                return true;
            }
            if (route === 'accounts' && req.method === 'POST') {
                const b = await body(req);
                if (typeof b.tokenId !== 'string' || !/^ak-[\w-]{8,200}$/.test(b.tokenId) || typeof b.tokenSecret !== 'string' || !/^as-[\w-]{8,300}$/.test(b.tokenSecret))
                    throw Error('INVALID_TOKEN_FORMAT');
                const info = await provider.call('verify', { credentials: { tokenId: b.tokenId, tokenSecret: b.tokenSecret } });
                if ((await store.all('account')).some(a => a.workspace === info.workspace)) {
                    json(res, 409, { error: 'ACCOUNT_ALREADY_LINKED' });
                    return true;
                }
                const aid = id(), isPrimary = info.workspace === 'basm1998ali', a = { id: aid, workspace: info.workspace, label: String(b.label || info.workspace).slice(0, 100), mode: 'token', role: isPrimary ? 'primary' : 'backup', activated:isPrimary,volume: isPrimary ? 'modal-ltx25-test-models' : 'iff-ltx25-' + aid.slice(0, 8), createdAt: Date.now(), credentials: store.seal({ tokenId: b.tokenId, tokenSecret: b.tokenSecret }, aid) };
                await store.transaction(async()=>{
                    if((await store.all('account')).some(existing=>existing.workspace===info.workspace))throw Error('ACCOUNT_ALREADY_LINKED');
                    await store.put('account',a);await store.audit('account_linked',aid);
                });
                json(res, 201, publicAccount(a));
                return true;
            }
            if (route === 'primary' && req.method === 'POST') {
                const info = await provider.call('verify', { credentials: { mode: 'local_profile', expectedWorkspace: 'basm1998ali' } });
                const existing = (await store.all('account')).find(a => a.workspace === info.workspace);
                if (existing) {
                    json(res, 200, publicAccount(existing));
                    return true;
                }
                const a = { id: id(), workspace: info.workspace, label: 'Modal الأساسي', mode: 'local_profile', role: 'primary', volume: 'modal-ltx25-test-models', createdAt: Date.now() };
                (await store.put('account', a));
                (await store.audit('primary_linked', a.id));
                json(res, 201, publicAccount(a));
                return true;
            }
            const am = route.match(/^accounts\/([a-f0-9-]+)(?:\/(check|discover|hf|activate|credentials))?$/);
            if (am) {
                const a = (await account(am[1]));
                if(req.method==='POST'&&am[2]==='credentials'){
                    const b=await body(req);
                    if(!/^ak-[\w-]{8,200}$/.test(b.tokenId||'')||!/^as-[\w-]{8,300}$/.test(b.tokenSecret||''))throw Error('INVALID_TOKEN_FORMAT');
                    if((await store.all('job')).some(j=>(j.accountId===a.id||j.sourceId===a.id)&&!j.cloudStopped&&!(j.status==='completed'&&j.result?.videoVerified)))throw Error('STOP_AND_RECONCILE_JOBS_FIRST');
                    const verified=await provider.call('verify',{credentials:{tokenId:b.tokenId,tokenSecret:b.tokenSecret,expectedWorkspace:a.workspace}});
                    if(verified.workspace!==a.workspace)throw Error('ACCOUNT_TOKEN_WORKSPACE_MISMATCH');
                    a.credentials=store.seal({tokenId:b.tokenId,tokenSecret:b.tokenSecret},a.id);a.mode='token';a.credentialsUpdatedAt=Date.now();
                    await store.put('account',a);await store.audit('account_credentials_renewed',a.id);json(res,200,publicAccount(a));return true;
                }
                if(req.method==='POST'&&am[2]==='activate'){
                    const checked=await discover(a);
                    if(!checked.ready)throw Error('WEIGHTS_NOT_READY');
                    a.activated=true;await store.put('account',a);await store.audit('account_setup_confirmed',a.id);
                    json(res,200,publicAccount(a));return true;
                }
                if (req.method === 'DELETE' && !am[2]) {
                    if(primaryOnly&&a.workspace==='basm1998ali')throw Error('PRIMARY_ACCOUNT_IS_FIXED');
                    if ((await store.all('job')).some(j => (j.accountId === a.id||j.sourceId===a.id) && ['queued', 'running', 'ready', 'uncertain', 'recovery_required', 'stopping', 'completed'].includes(j.status) && j.cloudStopped !== true))
                        throw Error('STOP_AND_RECONCILE_JOBS_FIRST');
                    (await store.delete('account', a.id));
                    if ((await store.get('config', 'selection'))?.accountId === a.id)
                        (await store.delete('config', 'selection'));
                    (await store.audit('account_unlinked', a.id));
                    json(res, 200, { unlinked: true, remoteResourcesDeleted: false, providerTokenRevoked: false });
                    return true;
                }
                if (req.method === 'DELETE' && am[2] === 'hf') {
                    delete a.hf;
                    (await store.put('account', a));
                    (await store.audit('hf_removed', a.id));
                    json(res, 200, { deleted: true, providerTokenRevoked: false });
                    return true;
                }
                if (req.method === 'POST' && am[2] === 'hf') {
                    const b = await body(req);
                    if (!/^hf_[A-Za-z0-9]{16,200}$/.test(b.token || ''))
                        throw Error('INVALID_HF_TOKEN');
                    a.hf = store.seal({ HF_TOKEN: b.token }, a.id + ':hf');
                    (await store.put('account', a));
                    (await store.audit('hf_saved', a.id));
                    json(res, 200, { saved: true, exportedToModal: false });
                    return true;
                }
                if (req.method === 'POST' && ['check', 'discover'].includes(am[2])) {
                    json(res, 200, await discover(a));
                    return true;
                }
            }
            if (route === 'selection' && req.method === 'POST') {
                const b = await body(req), a = (await account(b.accountId)), s = fixedEngineSettings(b.settings);
                requirePrimary(a);
                if((await store.all('job')).some(j=>j.accountId!==a.id&&['start','generate','prepare'].includes(j.action)&&!j.cloudStopped&&!(j.status==='completed'&&j.attachedEngineId&&j.result?.videoVerified)))throw Error('STOP_ACTIVE_ENGINE_BEFORE_SWITCH');
                const check = await discover(a);
                const selection = { id: 'selection', accountId: a.id, settings: s, checkedAt: Date.now(), weightsReady: check.ready, capacity: 'unknown_until_allocation' };
                (await store.put('config', selection));
                json(res, 200, selection);
                return true;
            }
            if (route === 'quote' && req.method === 'POST') {
                const b = await body(req), a = (await account(b.accountId)), s = fixedEngineSettings(b.settings);
                requirePrimary(a);
                if (!['prepare', 'start', 'generate'].includes(b.action))
                    throw Error('INVALID_ACTION');
                if(b.action==='generate'&&b.projectId){const saved=await store.get('project',b.projectId);const p=saved?.snapshot;if(p&&((p.videoProvider&&p.videoProvider!=='modal')||(p.plan?.videoProvider&&p.plan.videoProvider!=='modal')))throw Error('ARCHIVED_PROJECT_READ_ONLY');}
                if(b.action!=='prepare'&&a.activated===false)throw Error('ACCOUNT_SETUP_CONFIRMATION_REQUIRED');
                if (b.action === 'prepare' && (a.role === 'primary' || a.workspace === 'basm1998ali'))
                    throw Error('PRIMARY_STORAGE_IS_READ_ONLY');
                const inspection = await discover(a);
                if(b.action!=='prepare'){
                    await textQuality.available();
                    const activeQuality=inspection.productionQuality;
                    if(!activeQuality.ready)throw Error('LTX_DFR_WEIGHTS_REQUIRED');
                    if(a.corruptFiles?.some(name=>activeQuality.files.some(f=>f.name===name)))throw Error('WEIGHTS_NOT_READY');
                    // A retired Conv VAE is not a dependency of the active profile.
                    inspection.ready=true;
                }
                if(b.action==='prepare'&&b.verifyOnly===true&&!inspection.files.length)throw Error('NO_SAVED_WEIGHTS_TO_VERIFY');
                let plan = null, sourceId = null;
                if (b.action === 'prepare') {
                    let sourceFiles, sourceVolume = null;
                    if (b.source === 'official') {
                        if (!a.hf)
                            throw Error('HF_TOKEN_REQUIRED');
                        if (b.licenseAccepted !== true)
                            throw Error('MODEL_LICENSE_ACCEPTANCE_REQUIRED');
                        const access = await provider.call('official_plan', { hfCredentials: store.open(a.hf, a.id + ':hf'), cacheDir: path.resolve(store.folder, 'metadata-cache') });
                        sourceFiles = access.files;
                    }
                    else {
                        const source = (await store.all('account')).find(x => x.role === 'primary');
                        if (!source || source.id === a.id)
                            throw Error('PRIMARY_REQUIRES_AUTHORIZATION');
                        const primary = await discover(source);
                        if (!primary.ready)
                            throw Error('SOURCE_NOT_READY');
                        sourceId = source.id;
                        sourceFiles = primary.files;
                        sourceVolume = source.volume;
                    }
                    plan = { source: b.source === 'official' ? 'official' : 'volume', files: sourceFiles.filter(f => a.corruptFiles?.includes(f.name) || !inspection.files.some(d => d.name === f.name && d.size === f.size && d.manifestMatch)), requiredBytes: 0, sourceVolume, destinationVolume: a.volume, modelRepo: manifest.model_repo, modelRevision: manifest.model_revision, licenseAccepted: b.licenseAccepted === true, licenseURL: 'https://huggingface.co/Lightricks/LTX-2.5/tree/' + manifest.model_revision,
                        localStagingAvailableBytes:0,localStagingRequiredBytes:0,localStagingReady:false,blockingReason:null,
                        transport: b.source === 'official' ? 'official huggingface_hub → private resumable staging → Volume.batch_upload' : 'official Volume.read_file → private server staging → Volume.batch_upload', resume: b.source === 'official' ? 'HF client resumes partial downloads when supported; completed destination files skipped' : 'completed files; incomplete files restart (SDK has no ranged write)', storageUSDPerMonth: Object.values(manifest.files).reduce((n, f) => n + f.size, 0) / 2 ** 30 * .09, storageNote: 'Undiscounted list rate; excludes free allowances, account-specific billing and continued storage after this task.', integrityReadBytes: Object.values(manifest.files).reduce((n, f) => n + f.size, 0), networkCostUSD: null, buildCostUSD: 0 };
                    plan.requiredBytes = plan.files.reduce((n, f) => n + f.size, 0);
                    const disk=await fs.statfs(store.folder);
                    plan.localStagingAvailableBytes=Number(disk.bavail)*Number(disk.bsize);
                    plan.localStagingRequiredBytes=plan.files.length?Math.max(...plan.files.map(f=>f.size))+2**30:0;
                    plan.localStagingReady=plan.localStagingAvailableBytes>=plan.localStagingRequiredBytes;
                    plan.blockingReason=plan.localStagingReady?null:'PRIVATE_STAGING_DISK_INSUFFICIENT';
                    if(b.source!=='official'&&b.transport!=='local'){
                        const source=await account(sourceId);
                        const preflight=cloudTransferApp?await provider.call('cloud_transfer_preflight',{source:credentials(source),workerApp:cloudTransferApp}):{workerReady:false,workerApp:cloudTransferApp,fingerprint:null};
                        plan=cloudTransferPlan(plan,preflight,b.verifyOnly===true?'verify-only':b.probeOnly===true?'probe':'full');
                    }
                }
                else if (!inspection.ready)
                    throw Error('WEIGHTS_NOT_READY');
                if (b.action === 'generate' && (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 12000))
                    throw Error('PROMPT_REQUIRED');
                const cloudPrepare=plan?.transport==='modal-cpu-cloud';
                const est = cloudPrepare?{...plan.compute,expectedSeconds:null,recordedUSD:null,note:'CPU worker compute estimate only. Network, storage and first deployment/image costs are separate; not a guaranteed invoice cap.'}:b.action === 'prepare' ? { rate: null, resourceWindowUSD: null, expectedSeconds: null, recordedUSD: null, note: 'SDK transfer uses local server CPU, no cloud GPU/container. Storage, traffic and server disk costs remain account/hosting dependent; quoted separately in plan.' } : estimate(s);
                if ((b.action !== 'prepare'||cloudPrepare) && s.budget>0 && (est.resourceWindowUSD===null||est.resourceWindowUSD > s.budget))
                    throw Error('RESOURCE_WINDOW_EXCEEDS_JOB_BUDGET');
                const ledger = (await spending());
                if ((b.action !== 'prepare'||cloudPrepare) && ledger.limitUSD !== null && est.resourceWindowUSD===null)
                    throw Error('APPLICATION_MONTHLY_LIMIT_REQUIRES_BOUNDED_PLAN');
                if ((b.action !== 'prepare'||cloudPrepare) && ledger.limitUSD !== null && ledger.estimatedOrReservedUSD + est.resourceWindowUSD > ledger.limitUSD)
                    throw Error('APPLICATION_MONTHLY_LIMIT_EXCEEDED');
                const q = { id: id(), action: b.action, accountId: a.id, sourceId, settings: s, estimate: est, quality:qualityFor(s), plan, prompt: b.action === 'generate' ? b.prompt : null,engineJobId:b.engineJobId, projectId: b.projectId, sceneId: b.sceneId, previousSceneId: b.previousSceneId, createdAt: Date.now(), expiresAt: Date.now() + 300000, consumed: false };
                if(b.action==='generate'){
                    q.audioContract=ArabicDialogue.checkPrompt(q.prompt,b.audioContract);
                    q.dialoguePolicyVersion=ArabicDialogue.version;
                    const compiled=compileScene((await store.get('config','creative-library'))||emptyLibrary(),b.creativeScene);
                    if(compiled){
                        if(compiled.snapshot.turns.length&&(JSON.stringify(compiled.snapshot.turns.map(t=>t.text))!==JSON.stringify(q.audioContract.lines.map(t=>t.text))||compiled.snapshot.turns.some((t,i)=>!q.audioContract.lines[i].speaker.includes(compiled.snapshot.characters.find(c=>c.id===t.speakerId).name))))throw Error('ARABIC_DIALOGUE_REQUIRED: حوار مكتبة الشخصيات يختلف عن النص المعتمد.');
                        q.prompt+='\n\n'+compiled.directions;q.creativeSnapshot=compiled.snapshot;
                    }
                    q.dialogueScriptHash=hash(JSON.stringify(q.audioContract));
                    q.prompt=applyGenerationRules(q.prompt,ArabicDialogue.compile(q.audioContract));q.generationRulesVersion=FIXED_RULES_VERSION;
                }
                if(b.engineJobId){const warm=await store.get('job',b.engineJobId);if(b.action!=='generate'||!warm||warm.action!=='start'||warm.status!=='ready'||warm.cloudStopped||warm.accountId!==a.id||warm.readyUntil<=Date.now()||!controllers.has(warm.id))throw Error('ENGINE_SESSION_EXPIRED_NO_NEW_GPU');}
                if (b.action === 'generate' && (!SAFE.test(b.projectId || '') || !SAFE.test(b.sceneId || '')))
                    throw Error('PROJECT_SCENE_ID_REQUIRED');
                if (b.retryOfJobId) {
                    const old = (await store.get('job', b.retryOfJobId));
                    if (b.action !== 'generate' || !old || old.status !== 'failed' || !old.cloudStopped || old.result?.videoVerified || old.projectId !== b.projectId || old.sceneId !== b.sceneId)
                        throw Error('RETRY_REQUIRES_VERIFIED_FAILURE_AND_STOP');
                    const scene = (await store.get('scene', hash(b.projectId + ':' + b.sceneId)));
                    if (scene?.jobId !== old.id || scene.status !== 'failed')
                        throw Error('SCENE_NEWER_ATTEMPT_EXISTS_RESUME');
                    let artifactExists = false;
                    try {
                        await fs.access(path.resolve(store.folder, 'artifacts', old.id, 'video.mp4'));
                        artifactExists = true;
                    }
                    catch { }
                    if (artifactExists)
                        throw Error('EXISTING_VIDEO_REQUIRES_LOCAL_RECONCILIATION');
                    q.retryOfJobId = old.id;
                    q.initialFramePath = old.previousFrame || null;
                    q.previousSceneId = old.previousSceneId;
                }
                if (b.initialFrame) {
                    if (typeof b.initialFrame !== 'string' || b.initialFrame.length > 5500000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.initialFrame))
                        throw Error('INVALID_REFERENCE_IMAGE');
                    const content = Buffer.from(b.initialFrame.split(',')[1], 'base64');
                    if (content.length > 4000000 || content.length < 16)
                        throw Error('REFERENCE_IMAGE_TOO_LARGE');
                    const isImage = content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (content[0] === 255 && content[1] === 216 && content[2] === 255) || (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP');
                    if (!isImage)
                        throw Error('INVALID_IMAGE_SIGNATURE');
                    const refs = path.resolve(store.folder, 'references');
                    await fs.mkdir(refs, { recursive: true, mode: 0o700 });
                    q.initialFramePath = path.join(refs, q.id + '.image');
                    await fs.writeFile(q.initialFramePath, content, { mode: 0o600, flag: 'wx' });
                }
                if (b.action === 'generate' && b.projectSnapshot) {
                    const p = b.projectSnapshot;
                    if (p.id !== b.projectId || JSON.stringify(p).length > 1500000)
                        throw Error('INVALID_PROJECT_SNAPSHOT');
                    const old = (await store.get('project', p.id));
                    if(old?.deletedAt)throw Error('PROJECT_ARCHIVED_RESTORE_FIRST');
                    if (old && old.snapshot.plan?.preparedAt !== p.plan?.preparedAt && (await store.all('scene')).some(s => s.projectId === p.id))
                        throw Error('PROJECT_PLAN_HAS_JOBS_CREATE_NEW_PROJECT');
                    (await store.put('project', { id: b.projectId, snapshot: {...old?.snapshot,...p}, updatedAt: Date.now() }));
                }
                if (b.references !== undefined) {
                    if (b.action !== 'generate' || !Array.isArray(b.references) || b.references.length > 8)
                        throw Error('INVALID_PROJECT_REFERENCES');
                    const refs = path.resolve(store.folder, 'references');
                    await fs.mkdir(refs, { recursive: true, mode: 0o700 });
                    for (const ref of b.references) {
                        if (!SAFE.test(ref.assetId || ''))
                            throw Error('INVALID_REFERENCE_ID');
                        const bytes = imageBytes(ref.data), rid = hash(b.projectId + ':' + ref.assetId), digest = hash(bytes), target = path.join(refs, rid + '-' + digest + '.image'), old = (await store.get('reference', rid));
                        if (old && old.sha256 !== digest)
                            throw Error('REFERENCE_IMMUTABLE_USE_NEW_ASSET_ID');
                        if (!old) {
                            await fs.writeFile(target, bytes, { mode: 0o600 });
                            (await store.put('reference', { id: rid, projectId: b.projectId, assetId: ref.assetId, name: String(ref.name || 'مرجع').slice(0, 200), sha256: digest, path: target, mime: ref.data.slice(5, ref.data.indexOf(';')) }));
                        }
                    }
                }
                (await store.put('quote', q));
                const { initialFramePath, ...publicQuote } = q;
                json(res, 200, { ...publicQuote, paidEnabled: allowPaid, requiresExplicitApproval: true, capacity: 'unknown; GPU allocation can fail', warning: 'البناء والنقل والتخزين قد تزيد التكلفة. الحد داخل التطبيق ليس سقف فاتورة مضموناً. لا توجد إعادة محاولة تلقائية.' });
                return true;
            }
            if (route === 'execute' && req.method === 'POST') {
                const b = await body(req), q = (await store.get('quote', b.quoteId));
                if (!allowPaid) {
                    json(res, 423, { error: 'PAID_ACTIONS_DISABLED_ON_SERVER' });
                    return true;
                }
                if (!q || q.expiresAt < Date.now() || !(b.approvedCost === true || b.confirmation === 'أوافق على التكلفة'))
                    throw Error('FRESH_EXPLICIT_COST_APPROVAL_REQUIRED');
                if(q.action==='prepare'){
                    if(q.plan.transport==='modal-cpu-cloud'){
                        if(!cloudTransferApp||cloudTransferApp!==q.plan.workerApp)throw Error('CLOUD_WORKER_NOT_DEPLOYED');
                        if(!q.plan.workerReady||!q.plan.executionReady)throw Error('CLOUD_WORKER_NOT_DEPLOYED');
                    }else{
                        const disk=await fs.statfs(store.folder),required=q.plan.files.length?Math.max(...q.plan.files.map(f=>f.size))+2**30:0;
                        if(Number(disk.bavail)*Number(disk.bsize)<required)throw Error('PRIVATE_STAGING_DISK_INSUFFICIENT');
                    }
                }
                const prior = (await store.intentGet(q.id));
                if (prior) {
                    json(res, 200, (await store.get('job', prior)));
                    return true;
                }
                if(q.action==='generate'&&(q.dialoguePolicyVersion!==ArabicDialogue.version||q.dialogueScriptHash!==hash(JSON.stringify(ArabicDialogue.validate(q.audioContract)))))throw Error('ARABIC_DIALOGUE_REQUIRED: تغيّر عقد الحوار؛ جهّز عرضاً جديداً قبل التشغيل.');
                if(q.estimate?.manualControl&&q.estimate.resourceWindowUSD===null&&(await store.get('config','budget'))?.limitUSD!=null)
                    throw Error('APPLICATION_MONTHLY_LIMIT_REQUIRES_BOUNDED_PLAN');
                const a = (await account(q.accountId)), busy = (await store.all('job')).filter(j => ['queued', 'running', 'ready', 'stopping', 'uncertain', 'recovery_required', 'completed'].includes(j.status) && j.cloudStopped !== true && !(j.status==='completed'&&j.attachedEngineId&&j.result?.videoVerified));
                if(q.action!=='prepare'&&q.quality?.contract!==quality.contract)throw Error('ENGINE_QUALITY_CHANGED_REQUOTE');
                const prepared = q.action === 'generate' && busy.length === 1 && busy[0].action === 'start' && busy[0].status === 'ready' && busy[0].accountId === a.id && (!busy[0].readyUntil||busy[0].readyUntil>Date.now()) && sameEngineSettings(busy[0].settings,q.settings) && controllers.has(busy[0].id) ? busy[0] : null;
                if(prepared&&prepared.quality?.contract!==quality.contract)throw Error('ENGINE_QUALITY_CHANGED_STOP_OLD_SESSION');
                requirePrimary(a);
                if(q.engineJobId&&prepared?.id!==q.engineJobId)throw Error('ENGINE_SESSION_EXPIRED_NO_NEW_GPU');
                if (busy.length && !prepared)
                    throw Error('ONE_ACTIVE_OR_UNCERTAIN_JOB_ONLY');
                let sceneKey = null, previousFrame = q.initialFramePath || null;
                if (q.action === 'generate') {
                    sceneKey = hash(q.projectId + ':' + q.sceneId);
                    const scene = (await store.get('scene', sceneKey));
                    if (scene && !(q.retryOfJobId === scene.jobId && scene.status === 'failed')) {
                        json(res, 409, { error: 'SCENE_EXISTS_RESUME_EXISTING_JOB', jobId: scene.jobId, status: scene.status });
                        return true;
                    }
                    if (q.previousSceneId) {
                        const previous = (await store.get('scene', hash(q.projectId + ':' + q.previousSceneId)));
                        if (!previous || previous.status !== 'completed')
                            throw Error('PREVIOUS_SCENE_NOT_COMPLETE');
                        previousFrame = path.resolve(store.folder, 'artifacts', previous.jobId, 'last-frame.png');
                        let frame;
                        try {
                            frame = await fs.stat(previousFrame);
                        }
                        catch {
                            throw Error('LAST_FRAME_NEEDS_LOCAL_RECOVERY_NO_REGENERATION');
                        }
                        if (frame.size < 32)
                            throw Error('LAST_FRAME_NEEDS_LOCAL_RECOVERY_NO_REGENERATION');
                    }
                }
                const j = { id: id(), quality:q.quality, quoteId: q.id, accountId: a.id, workspace: a.workspace, action: q.action, settings: q.settings, estimate: q.estimate, plan: q.plan, prompt: q.prompt, audioContract:q.audioContract, dialoguePolicyVersion:q.dialoguePolicyVersion, dialogueScriptHash:q.dialogueScriptHash, creativeSnapshot:q.creativeSnapshot, sourceId: q.sourceId, projectId: q.projectId, sceneId: q.sceneId, previousSceneId: q.previousSceneId, retryOfJobId: q.retryOfJobId, sceneKey, previousFrame, attachedEngineId: prepared?.id, appId: prepared?.appId, status: 'queued', createdAt: Date.now(), events: [], cloudStopped: false };
                await store.transaction(async () => {
                    const current = (await store.all('job')).filter(x => ['queued', 'running', 'ready', 'stopping', 'uncertain', 'recovery_required', 'completed'].includes(x.status) && !x.cloudStopped && !(x.status==='completed'&&x.attachedEngineId&&x.result?.videoVerified));
                    if (current.length && !(prepared && current.length === 1 && current[0].id === prepared.id && current[0].status === 'ready'))
                        throw Error('ONE_ACTIVE_OR_UNCERTAIN_JOB_ONLY');
                    const priorScene = sceneKey ? (await store.get('scene', sceneKey)) : null;
                    if (priorScene) {
                        const old = (await store.get('job', priorScene.jobId));
                        if (q.retryOfJobId !== priorScene.jobId || priorScene.status !== 'failed' || old?.status !== 'failed' || !old.cloudStopped || old.result?.videoVerified)
                            throw Error('SCENE_ALREADY_SUBMITTED');
                    }
                    const ledger = (await spending());
                    if ((j.action !== 'prepare'||isCloud(j)) && ledger.limitUSD !== null && ledger.estimatedOrReservedUSD + j.estimate.resourceWindowUSD > ledger.limitUSD)
                        throw Error('APPLICATION_MONTHLY_LIMIT_EXCEEDED');
                    (await store.intentPut(q.id, j.id));
                    (await store.put('job', j));
                    q.consumed = true;
                    (await store.put('quote', q));
                    if (sceneKey)
                        (await store.put('scene', { id: sceneKey, projectId: q.projectId, sceneId: q.sceneId, status: 'submitted', jobId: j.id, history: priorScene ? [...(priorScene.history || []), priorScene.jobId] : [] }));
                    (await store.audit('operation_approved', j.id));
                });
                const task = run(j, a, q.sourceId ? (await account(q.sourceId)) : null).catch(() => console.error('ENGINE_LOCAL_RECORDING_FAILED: reconcile existing job; no automatic retry.', j.id));
                activeTasks.add(task);
                void task.finally(() => activeTasks.delete(task));
                json(res, 202, { id: j.id, status: 'queued' });
                return true;
            }
            const jm = route.match(/^jobs\/([a-f0-9-]+)(?:\/(stop|reconcile|video|raw-video))?$/);
            if (jm) {
                const j = (await store.get('job', jm[1]));
                if (!j)
                    throw Error('JOB_NOT_FOUND');
                const a = (await store.get('account', j.accountId)) || (await store.all('account')).find(a => a.workspace === j.workspace);
                if(req.method==='GET'&&jm[2]==='raw-video'){
                    if(!j.result?.videoVerified)throw Error('VIDEO_NOT_READY');
                    const root=path.resolve(store.folder,'artifacts',j.id),raw=path.join(root,'raw-ltx.mp4');
                    const file=await fs.stat(raw).then(()=>raw,()=>path.join(root,'video.mp4'));
                    res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(await fs.readFile(file));return true;
                }
                if (req.method === 'GET' && jm[2] === 'video') {
                    if (j.status !== 'completed' || !j.result?.videoVerified)
                        throw Error('VIDEO_NOT_READY');
                    const video = await fs.readFile(path.resolve(store.folder, 'artifacts', j.id, 'video.mp4'));
                    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
                    res.end(video);
                    return true;
                }
                if (req.method === 'POST' && jm[2] === 'stop') {
                    const b = await body(req);
                    if (!b.confirmCancel)
                        throw Error('CANCEL_CONFIRMATION_REQUIRED');
                    if (j.status === 'completed' && j.cloudStopped) {
                        json(res, 200, j);
                        return true;
                    }
                    j.status = 'stopping';
                    j.stopRequestedAt = Date.now();
                    (await store.put('job', j));
                    if(isCloud(j)){
                        if(!a)throw Error('ACCOUNT_RELINK_REQUIRED_FOR_CLOUD_CHECK');
                        const check=await provider.call('cloud_transfer_stop',await transferControl(j,a));
                        j.cleanup=check;j.cloudStopped=check.cloud_stopped===true;
                        if(j.cloudStopped)await finishCloud(j,a,{...(check.result||{}),...check});else await store.put('job',j);
                        await store.audit('cloud_transfer_stop_requested',j.id);json(res,200,j);return true;
                    }
                    controllers.get(j.attachedEngineId || j.id)?.stop();
                    cancellations.get(j.id)?.abort();
                    if (j.action !== 'prepare') {
                        if (!a)
                            throw Error('ACCOUNT_RELINK_REQUIRED_FOR_CLOUD_CHECK');
                        const cleanup = await provider.call('stop', { credentials: credentials(a), appId: j.appId || null, jobId: j.attachedEngineId || j.id, startedAt: j.startedAt ? j.startedAt / 1000 : undefined });
                        Object.assign(j, (await store.get('job', j.id)));
                        cleanup.recordedCost = cleanup.recordedCost ?? j.cleanup?.recordedCost ?? j.result?.recordedCost ?? null;
                        j.cleanup = cleanup;
                        j.cloudStopped = cleanup.cloud_stopped === true;
                        if (cleanup.app_id)
                            j.appId = cleanup.app_id;
                        if (j.cloudStopped)
                            j.stoppedAt = Date.now();
                        j.status = j.action === 'generate' && j.result?.videoVerified ? 'completed' : j.cloudStopped ? 'stopped' : 'uncertain';
                        (await store.put('job', j));
                    }
                    (await store.audit('stop_requested', j.id));
                    json(res, 200, j);
                    return true;
                }
                if (req.method === 'POST' && jm[2] === 'reconcile') {
                    if (!a)
                        throw Error('ACCOUNT_RELINK_REQUIRED_FOR_CLOUD_CHECK');
                    if(isCloud(j)){
                        const check=await provider.call('cloud_transfer_status',await transferControl(j,a));
                        for(const eventData of check.events||[])await event(j,eventData);
                        j.cleanup=check;j.cloudStopped=check.cloud_stopped===true;
                        if(j.cloudStopped)await finishCloud(j,a,{...(check.result||{}),...check});else{await store.put('job',j);resumeCloud(j);}
                        json(res,200,j);return true;
                    }
                    const cleanup = await provider.call('inspect', { credentials: credentials(a), appId: j.appId || null, jobId: j.attachedEngineId || j.id, startedAt: j.startedAt ? j.startedAt / 1000 : undefined });
                    Object.assign(j, (await store.get('job', j.id)));
                    cleanup.recordedCost = cleanup.recordedCost ?? j.cleanup?.recordedCost ?? j.result?.recordedCost ?? null;
                    j.cleanup = cleanup;
                    j.cloudStopped = cleanup.cloud_stopped === true;
                    if (j.cloudStopped)
                        j.stoppedAt = Date.now();
                    if (j.cleanup.app_id)
                        j.appId = j.cleanup.app_id;
                    if (j.cloudStopped && j.status !== 'completed' && !(j.status==='needs_review'&&j.result?.generationSucceeded)) {
                        if (!await recoverArtifact(j))
                            j.status = 'stopped';
                    }
                    (await store.put('job', j));
                    json(res, 200, j);
                    return true;
                }
                if (req.method === 'GET' && !jm[2]) {
                    const { previousFrame, ...safe } = j;
                    json(res, 200, safe);
                    return true;
                }
            }
            json(res, 404, { error: 'ENGINE_ROUTE_NOT_FOUND' });
        }
        catch (e) {
            const code = e.message?.startsWith('ARABIC_DIALOGUE_REQUIRED:') ? 'ARABIC_DIALOGUE_REQUIRED' : /^[A-Z][A-Z0-9_]{3,100}$/.test(e.message) ? e.message : 'ENGINE_REQUEST_FAILED';
            json(res, 400, { error: code, message: 'تعذر إتمام العملية. لم تُطبع بيانات اعتماد. افحص الصلاحيات والحالة قبل إعادة أي طلب مدفوع.' });
        }
        return true;
    }
    // Serialize request decisions; background event persistence remains independent.
    // PostgreSQL also enforces the paid-job invariant with a transaction lock/index.
    let requests=Promise.resolve();
    const guardedHandler=(req,res)=>{
        if(!req.url.startsWith('/api/engine/'))return Promise.resolve(false);
        const current=requests.then(()=>handler(req,res));requests=current.then(()=>{},()=>{});return current;
    };
    const hasAdminSession=async req=>{
        if(!store||!secure(req)||(req.headers.origin&&!allowedOrigins.has(req.headers.origin)))return false;
        const token=(req.headers.cookie||'').match(/(?:^|;\s*)iff_engine=([a-f0-9]{64})(?:;|$)/)?.[1];
        const session=token?await store.sessionGet(hash(token)):null;
        return !!session&&session.role==='admin'&&session.expires>Date.now();
    };
    return { handler:guardedHandler, hasAdminSession, store, close: async () => {
            for (const c of controllers.values())
                c.stop();
            for (const c of cancellations.values())
                c.abort();
            if (activeTasks.size) {
                const stops = (await store.all('job')).filter(j => !j.cloudStopped && ['running', 'ready', 'stopping'].includes(j.status) && j.action !== 'prepare').map(async (j) => { const a = (await store.get('account', j.accountId)); return provider.call('stop', { credentials: credentials(a), appId: j.appId || null, jobId: j.attachedEngineId || j.id, startedAt: j.startedAt ? j.startedAt / 1000 : undefined }).catch(() => { }); });
                await Promise.race([Promise.allSettled([...activeTasks, ...stops]), new Promise(r => setTimeout(r, 30000))]);
            }
            if(audioQueue?.done)await audioQueue.done;
            if(textDirector?.pending.size)await Promise.allSettled([...textDirector.pending]);
            (await store?.close());
        } };
}
