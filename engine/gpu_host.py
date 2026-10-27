"""Paid-only host. Importing modal_bridge for discovery cannot import this module."""
import asyncio
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time


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
    if s['gpu'] not in ('L40S','RTX-PRO-6000'):raise RuntimeError('GPU not allowed')
    app=modal.App(name)
    volume=modal.Volume.from_name(request['volume'],create_if_missing=False,client=c,environment_name='main').with_mount_options(read_only=True)
    image=make_image()
    remote=app.cls(image=image,gpu=s['gpu'],cpu=(s['cpu'],s['cpu']),memory=(s['ram']*1024,s['ramLimit']*1024),
                   timeout=s['timeout'],startup_timeout=s['startup'],retries=0,
                   max_containers=1,min_containers=0,buffer_containers=0,scaledown_window=15 if session else 2,
                   volumes={'/models':volume})(FilmEngine)
    result={};started=time.monotonic();commands=queue.Queue();finished=threading.Event();app_id=None
    def watch():
        # Conservative wall-clock guard also covers image preparation. Not a billing guarantee.
        gpu_rate=.000842 if s['gpu']=='RTX-PRO-6000' else .000542
        limit=min(s['timeout']+s['startup']+(15 if session else 2),s['budget']/(gpu_rate+s['cpu']*.0000131+s['ramLimit']*.00000222))
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
    image_bytes=Path(request['previousFrame']).read_bytes() if request.get('previousFrame') else None
    payload={'prompt':request['prompt'],'seed':s['seed'],'gpu':s['gpu'],'image':image_bytes}
    def operation(obj,mode,artifact_dir):
        saved=None;dispatched=time.monotonic();first=True
        emit('event',{'kind':'phase_start','phase':'gpu_dispatch_to_first_event'})
        for value in obj.operate.remote_gen(payload,mode):
            if first:
                first=False;emit('event',{'kind':'phase_end','phase':'gpu_dispatch_to_first_event','seconds':time.monotonic()-dispatched})
            if 'event' in value:emit('event',value['event'])
            elif value.get('prepared'):emit('event',{'kind':'ready','phase':'ready','app_id':app.app_id,'device':value['gpu'],'allocated_vram_bytes':value['allocated_vram_bytes'],'reserved_vram_bytes':value['reserved_vram_bytes']})
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
                    deadline=time.monotonic()+15;command={'command':'stop'}
                    while time.monotonic()<deadline:
                        try:
                            command=commands.get(timeout=min(3,max(.01,deadline-time.monotonic())));break
                        except queue.Empty:
                            state=sync_metadata(credentials,app_id,job_id,False,False)
                            emit('event',{'kind':'resource_status','phase':'ready',**state})
                            if not state['running_containers']:break
                    if command.get('command')=='generate':result=operation(obj,'generate',command['artifactDir']) or {}
                else:result=operation(obj,'generate',request['artifactDir']) or {}
    finally:
        finished.set()
        if app_id:
            try:cleanup=sync_metadata(credentials,app_id,job_id,True)
            except Exception:cleanup={'app_id':app_id,'cloud_stopped':False,'state':'cleanup_unverified'}
            emit('event',cleanup);result.update(cleanup)
    result['elapsedSeconds']=time.monotonic()-started
    return result
