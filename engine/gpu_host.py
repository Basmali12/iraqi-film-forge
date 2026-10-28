"""Paid-only host. Importing modal_bridge for discovery cannot import this module."""
import asyncio
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

class IdleWindow:
    def __init__(self,seconds,now=time.monotonic):
        self.seconds,self.now=seconds,now
        self.reset()
    def reset(self):self.deadline=self.now()+self.seconds
    def remaining(self):return max(0,self.deadline-self.now())
    def expired(self):return self.remaining()<=0

def session_payload(initial,command):
    prompt=command.get('prompt')
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>12000:raise RuntimeError('Scene description required')
    if command.get('seed',initial['seed'])!=initial['seed']:raise RuntimeError('Prepared session seed cannot change')
    orientation=command.get('orientation',initial.get('orientation','portrait'))
    if orientation not in ('portrait','landscape'):raise RuntimeError('Unsupported orientation')
    return {**initial,'prompt':prompt,'orientation':orientation,
            'image':conditioning_image(command.get('previousFrame'))}


def conditioning_image(path):
    if not path:return None
    p=Path(path)
    if not 32<=p.stat().st_size<=4000000:raise RuntimeError('INVALID_CONDITIONING_IMAGE')
    value=p.read_bytes()
    if not (value.startswith(b'\x89PNG\r\n\x1a\n') or value.startswith(b'\xff\xd8\xff') or (value[:4]==b'RIFF' and value[8:12]==b'WEBP')):
        raise RuntimeError('INVALID_CONDITIONING_IMAGE')
    return value


def runtime_limits(settings):
    # Zero is an application sentinel, never a zero-second Modal timeout.
    timeout=settings.get('timeout',600) or 86400
    return timeout,settings.get('startup',180) or timeout


def watchdog_limit(settings,session=False):
    rate=(.000842 if settings['gpu']=='RTX-PRO-6000' else .000542)+settings['cpu']*.0000131+settings['ramLimit']*.00000222
    budget_seconds=settings['budget']/rate if settings['budget']>0 else None
    if session:return budget_seconds
    technical=sum(runtime_limits(settings))+2
    return min(technical,budget_seconds) if budget_seconds is not None else technical


def run(request,session=False):
    from modal_bridge import client,emit,sync_metadata
    if request.get('paidApproved') is not True:raise RuntimeError('Explicit paid approval required')
    c,workspace=client(request['credentials'])
    credentials=request['credentials']
    if credentials.get('mode')!='local_profile':
        os.environ['MODAL_TOKEN_ID']=credentials['tokenId'];os.environ['MODAL_TOKEN_SECRET']=credentials['tokenSecret']
    os.environ['LTX25_BENCHMARK_APPROVED']='YES'
    runtime=Path(__file__).parent/'runtime';sys.path.insert(0,str(runtime))
    import modal
    from benchmark_image import make_image
    from gpu_service import FilmEngine
    s=request['settings'];job_id=request['jobId'];name='iff-engine-'+job_id
    idle_seconds=int(s.get('idleSeconds',1200))
    if idle_seconds not in (15,30,60,1200):raise RuntimeError('Invalid idle guard')
    if s['gpu'] not in ('L40S','RTX-PRO-6000'):raise RuntimeError('GPU not allowed')
    app=modal.App(name)
    volume=modal.Volume.from_name(request['volume'],create_if_missing=False,client=c,environment_name='main').with_mount_options(read_only=True)
    image=make_image()
    execution_timeout,startup_timeout=runtime_limits(s)
    remote=app.cls(image=image,gpu=s['gpu'],cpu=(s['cpu'],s['cpu']),memory=(s['ram']*1024,s['ramLimit']*1024),
                   timeout=execution_timeout,startup_timeout=None if s['startup']==0 else startup_timeout,retries=0,
                   max_containers=1,min_containers=0,buffer_containers=0,scaledown_window=idle_seconds if session else 2,
                   volumes={'/models':volume})(FilmEngine)
    result={};started=time.monotonic();commands=queue.Queue();finished=threading.Event();app_id=None
    def watch():
        # Conservative wall-clock guard also covers image preparation. Not a billing guarantee.
        limit=watchdog_limit(s,session)
        if limit is None:
            finished.wait()
            return
        if not finished.wait(limit):
            try:
                current=app.app_id
                sync_metadata(credentials,current,job_id,True)
            except Exception:pass
            commands.put({'command':'stop'})
    threading.Thread(target=watch,daemon=True).start()
    def stdin_reader():
        for line in sys.stdin:
            try:commands.put(json.loads(line))
            except Exception:pass
    if session:threading.Thread(target=stdin_reader,daemon=True).start()
    image_bytes=conditioning_image(request.get('previousFrame'))
    payload={'prompt':request['prompt'],'seed':s['seed'],'gpu':s['gpu'],'image':image_bytes,'orientation':s.get('orientation','portrait')}
    def operation(obj,mode,artifact_dir,operation_payload=None):
        saved=None;dispatched=time.monotonic();first=True
        emit('event',{'kind':'phase_start','phase':'gpu_dispatch_to_first_event'})
        for value in obj.operate.remote_gen(operation_payload or payload,mode):
            if first:
                first=False;emit('event',{'kind':'phase_end','phase':'gpu_dispatch_to_first_event','seconds':time.monotonic()-dispatched})
            if 'event' in value:emit('event',value['event'])
            elif value.get('prepared'):emit('event',{'kind':'ready','phase':'ready','app_id':app.app_id,'ready_until':int((time.time()+idle_seconds)*1000),'device':value['gpu'],'allocated_vram_bytes':value['allocated_vram_bytes'],'reserved_vram_bytes':value['reserved_vram_bytes']})
            elif value.get('videoVerified'):
                folder=Path(artifact_dir);folder.mkdir(parents=True,exist_ok=True,mode=0o700)
                # Local durable artifacts do not depend on the Modal account or Volume.
                (folder/'video.mp4').write_bytes(value.pop('video'))
                frame=value.pop('frame')
                if frame:(folder/'last-frame.png').write_bytes(frame)
                (folder/'audit.json').write_text(json.dumps(value,ensure_ascii=False),encoding='utf8')
                saved=value
        return saved
    try:
        with modal.enable_output():
            with app.run(client=c,environment_name='main'):
                app_id=app.app_id;emit('event',{'kind':'app_created','phase':'application_setup','app_id':app_id,'seconds':time.monotonic()-started})
                obj=remote()
                if session:
                    operation(obj,'prepare',request['artifactDir'])
                    idle=IdleWindow(idle_seconds);seen=set()
                    while not idle.expired():
                        try:
                            command=commands.get(timeout=min(3,max(.01,idle.remaining())))
                        except queue.Empty:
                            state=sync_metadata(credentials,app_id,job_id,False,False)
                            emit('event',{'kind':'resource_status','phase':'ready',**state})
                            if not state['running_containers']:break
                            continue
                        if command.get('command')=='stop':break
                        if command.get('command')!='generate':continue
                        if idle.expired():break
                        ident=command.get('jobId')
                        if not isinstance(ident,str) or not ident:raise RuntimeError('Scene job identifier required')
                        if ident in seen:raise RuntimeError('Duplicate generation command; no retry')
                        seen.add(ident)
                        actual={**session_payload(payload,command),'require_prepared':True}
                        scene=operation(obj,'generate',command['artifactDir'],actual) or {}
                        if not scene.get('videoVerified'):raise RuntimeError('Video not verified')
                        emit('generation_result',{'job_id':ident,'result':{**scene,'app_id':app_id,'cloud_stopped':False}})
                        idle.reset()
                        emit('event',{'kind':'ready','phase':'ready','app_id':app_id,'ready_until':int((time.time()+idle_seconds)*1000)})
                else:result=operation(obj,'generate',request['artifactDir']) or {}
    finally:
        finished.set()
        if app_id:
            try:cleanup=sync_metadata(credentials,app_id,job_id,True)
            except Exception:cleanup={'app_id':app_id,'cloud_stopped':False,'state':'cleanup_unverified'}
            emit('event',cleanup);result.update(cleanup)
    result['elapsedSeconds']=time.monotonic()-started
    return result
