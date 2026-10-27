"""Isolated Modal SDK 1.6.2 adapter. JSON-lines IPC; never emit raw SDK errors.
Read-only operations never instantiate an Image/App or create a Volume.
"""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT/'runtime/source-manifest.json').read_text())
PREFIX = '/ltx25/'+MANIFEST['model_revision']


def emit(kind, data):
    print(json.dumps({'type': kind, 'data': data}, ensure_ascii=False), flush=True)


def client(credentials):
    import modal
    if modal.__version__ != '1.6.2':
        raise RuntimeError('Pinned Modal SDK required')
    if credentials.get('mode') == 'local_profile':
        result = modal.Client.from_env()
    else:
        result = modal.Client.from_credentials(credentials['tokenId'], credentials['tokenSecret'])
    workspace = modal.Workspace.from_context(client=result)
    workspace.hydrate()
    if credentials.get('expectedWorkspace') and workspace.name != credentials['expectedWorkspace']:
        raise RuntimeError('Workspace mismatch')
    return result, workspace.name


async def metadata(credentials, app_id=None, job_id=None, stop=False,include_billing=True,started_at=None):
    # Listing / scoped cancellation are not public high-level APIs in SDK 1.6.2.
    # Keep this version-pinned compatibility boundary isolated here.
    from modal.client import _Client
    from modal_proto import api_pb2 as api
    c = (await _Client.from_env() if credentials.get('mode') == 'local_profile'
         else await _Client.from_credentials(credentials['tokenId'], credentials['tokenSecret']))
    apps = None if app_id else await asyncio.wait_for(c._stub.AppList(api.AppListRequest(environment_name='main')), 20)
    if job_id and not app_id:
        owned=[a for a in apps.apps if a.description=='iff-engine-'+job_id]
        if len(owned)!=1:
            return {'cloud_stopped':False,'running_containers':None,'tasks':None,'state':'not_found_or_not_unique_unknown'}
        app_id=owned[0].app_id
    if app_id:
        # AppList can omit older/stopped Apps. Verify known IDs directly rather
        # than confusing an omitted App with a successful or failed stop.
        response=await asyncio.wait_for(c._stub.AppGetInfo(api.AppGetInfoRequest(app_id=app_id)),20)
        app=response.info
        if app.app_id!=app_id or app.description!='iff-engine-'+job_id or app.environment_name!='main':
            raise RuntimeError('Refuse cancellation of unowned application')
        if stop and app.lifecycle.app_state != api.APP_STATE_STOPPED:
            await asyncio.wait_for(c._stub.AppStop(api.AppStopRequest(app_id=app_id, source=api.APP_STOP_SOURCE_CLI)),20)
        for _ in range(8 if stop else 1):
            response=await asyncio.wait_for(c._stub.AppGetInfo(api.AppGetInfoRequest(app_id=app_id)),20)
            app=response.info
            tasks = await asyncio.wait_for(c._stub.TaskList(api.TaskListRequest(environment_name='main',app_id=app_id)),20)
            stopped = app.lifecycle.app_state == api.APP_STATE_STOPPED and not tasks.tasks
            if stopped or not stop:
                break
            await asyncio.sleep(1)
        billing = None
        try:
            if not include_billing:raise RuntimeError('Skip billing on heartbeat')
            from datetime import datetime, timezone, timedelta
            from modal._workspace import _Workspace
            from decimal import Decimal
            end = datetime.now(timezone.utc).replace(minute=0,second=0,microsecond=0)+timedelta(hours=1)
            start=datetime.fromtimestamp(started_at,timezone.utc).replace(minute=0,second=0,microsecond=0) if started_at else end-timedelta(days=1)
            rows = await asyncio.wait_for(_Workspace.from_context(client=c).billing.report(start=start,end=end,resolution='h'),15)
            rows = [r for r in rows if r.object_id == app_id]
            if rows:
                billing = {'usd':str(sum((r.cost for r in rows),Decimal(0))),'source':'Modal billing report','provisional':True}
        except Exception:
            pass  # unavailable is null, never a fabricated zero.
        return {'app_id':app_id,'running_containers':len(tasks.tasks),'tasks':len(tasks.tasks),'cloud_stopped':stopped,'recordedCost':billing}
    volumes = await asyncio.wait_for(c._stub.VolumeList(api.VolumeListRequest(environment_name='main')),20)
    relevant=[]
    for app in apps.apps:
        item={'id':app.app_id,'name':app.description,'containers':app.n_running_tasks,'state':app.state}
        if any(word in app.description.lower() for word in ('ltx','iff-engine')):
            try:
                layout=await asyncio.wait_for(c._stub.AppGetLayout(api.AppGetLayoutRequest(app_id=app.app_id)),10)
                item['functions']=list(layout.app_layout.function_ids.keys());item['classes']=list(layout.app_layout.class_ids.keys())
            except Exception:item['functions']=None
        relevant.append(item)
    task_count=None
    try:
        listed_tasks=await asyncio.wait_for(c._stub.TaskList(api.TaskListRequest(environment_name='main')),15)
        task_count=len(listed_tasks.tasks)
    except Exception:pass
    return {'apps':relevant,'runningTasks':task_count,
            'volumes':[{'name':v.label,'id':v.volume_id} for v in volumes.items]}


def discover(request):
    import modal
    c, workspace = client(request['credentials'])
    result = sync_metadata(request['credentials'])
    result.update(workspace=workspace,environment='main',files=[],ready=False,capacity='unknown_until_paid_allocation',sdk=modal.__version__,revision=MANIFEST['model_revision'],sourceCommit=MANIFEST['source_commit'],dependencies='engine/runtime/requirements-remote.lock',configurationSource='pinned locally verified benchmark; remote dependency image not introspected',freeStorageQuotaBytes=None)
    volume_name = request['volume']
    if volume_name not in [v['name'] for v in result['volumes']]:
        return result
    volume = modal.Volume.from_name(volume_name,create_if_missing=False,client=c,environment_name='main')
    try:
        entries = {e.path.lstrip('/'):e for e in volume.listdir(PREFIX,recursive=True)}
    except Exception:
        return result
    for name, info in MANIFEST['files'].items():
        entry = entries.get((PREFIX+'/'+name).lstrip('/'))
        if entry:
            result['files'].append({'name':name,'size':entry.size,'manifestMatch':entry.size == info['size'],'expectedSHA256':info['sha256'],'hashVerifiedNow':False})
    marker = entries.get((PREFIX+'/READY.json').lstrip('/'))
    if marker and marker.size < 65536:
        saved = json.loads(b''.join(volume.read_file(PREFIX+'/READY.json')))
        result['readyMarker'] = {'revision':saved.get('revision'),'present':True}
        result['ready'] = saved.get('revision') == MANIFEST['model_revision'] and len(result['files']) == 5 and all(f['manifestMatch'] for f in result['files'])
    result['integrityNote'] = 'Names, sizes and READY revision checked. No multi-GB hash download during discovery.'
    return result


def transfer(request):
    import modal
    if not request.get('paidApproved'):
        raise RuntimeError('Approval required')
    if not isinstance(request.get('plan'),dict) or not isinstance(request['plan'].get('files'),list):
        raise RuntimeError('Explicit transfer plan required')
    connected_at=time.monotonic();emit('event',{'kind':'phase_start','phase':'connection'})
    destination_client, destination_workspace = client(request['credentials'])
    if destination_workspace == 'basm1998ali':
        raise RuntimeError('Primary storage is read-only')
    official=request.get('plan',{}).get('source')=='official'
    if official:
        if not request['plan'].get('licenseAccepted') or not request.get('hfCredentials',{}).get('HF_TOKEN'):
            raise RuntimeError('Official model access requires token and license approval')
        source=None
    else:
        source_client, _ = client(request['source'])
        source = modal.Volume.from_name(request['sourceVolume'],client=source_client,create_if_missing=False,environment_name='main')
    emit('event',{'kind':'phase_end','phase':'connection','seconds':time.monotonic()-connected_at})
    emit('event',{'kind':'phase_start','phase':'source_discovery'})
    if source:source.hydrate()
    # Reconcile AGAIN after approval: transfer only missing files.
    inspection = discover(request)
    emit('event',{'kind':'phase_end','phase':'source_discovery'})
    needed = [name for name in MANIFEST['files'] if not any(f['name']==name and f['manifestMatch'] for f in inspection['files'])]
    if inspection['files']:
        existing=modal.Volume.from_name(request['volume'],client=destination_client,create_if_missing=False,environment_name='main')
        for name,expected in MANIFEST['files'].items():
            if name in needed:continue
            emit('event',{'kind':'phase_start','phase':'integrity','file':name})
            digest=hashlib.sha256()
            for chunk in existing.read_file(PREFIX+'/'+name):digest.update(chunk)
            if digest.hexdigest()!=expected['sha256']:needed.append(name)
            else:emit('event',{'phase':'integrity','kind':'file_verified','file':name})
    required = sum(MANIFEST['files'][name]['size'] for name in needed)
    approved={f['name'] for f in request['plan']['files']}
    unexpected=[name for name in needed if name not in approved]
    if unexpected:
        return {'ready':False,'requiresNewPlan':True,'corruptFiles':unexpected,'cloud_stopped':True,'gpuUsed':False,
                'reason':'Integrity changed the transfer scope; approve a new plan before additional bytes are transferred.'}
    folder = Path(request['artifactDir']);folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    if needed and shutil.disk_usage(folder).free < max(MANIFEST['files'][n]['size'] for n in needed)+2**30:
        raise RuntimeError('Private staging disk space insufficient')
    storage_started=time.monotonic();emit('event',{'phase':'storage','kind':'phase_start'})
    destination = modal.Volume.from_name(request['volume'],client=destination_client,create_if_missing=True,environment_name='main')
    destination.hydrate()
    emit('event',{'phase':'storage','kind':'phase_end','seconds':time.monotonic()-storage_started})
    done=0;started=time.monotonic()
    for name in needed:
        expected=MANIFEST['files'][name]
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            local=Path(tmp)/'weight.part';digest=hashlib.sha256();size=0;last_progress=0
            if official:
                from huggingface_hub import hf_hub_download
                staging=Path(request['stagingDir']);staging.mkdir(parents=True,exist_ok=True,mode=0o700)
                emit('event',{'phase':'transfer','kind':'phase_start','file':name})
                # Explicit token argument does not save a global HF login. The private
                # staging directory supports client-native partial-download resume.
                local=Path(hf_hub_download(repo_id=MANIFEST['model_repo'],revision=MANIFEST['model_revision'],filename=name,token=request['hfCredentials']['HF_TOKEN'],local_dir=staging,endpoint='https://huggingface.co'))
                with local.open('rb') as stream:
                    for chunk in iter(lambda:stream.read(8*2**20),b''):digest.update(chunk);size+=len(chunk)
            else:
                with local.open('wb') as stream:
                    for chunk in source.read_file(PREFIX+'/'+name):
                        stream.write(chunk);digest.update(chunk);size+=len(chunk)
                        now=time.monotonic()
                        if now-last_progress>=.5 or size==expected['size']:
                            last_progress=now;elapsed=max(.001,now-started)
                            emit('event',{'phase':'transfer','kind':'progress','file':name,'transferred':done+size,'required':required,'unit':'source_bytes_received','rate':(done+size)/elapsed,'eta':None})
            if size!=expected['size'] or digest.hexdigest()!=expected['sha256']:
                emit('event',{'kind':'phase_error','phase':'integrity','error_type':'SOURCE_SHA256_MISMATCH','file':name})
                raise RuntimeError('Source integrity failure')
            emit('event',{'phase':'upload','kind':'phase_start','file':name})
            # SDK upload has no trustworthy byte callback or ranged write: indeterminate UI.
            with destination.batch_upload(force=True) as batch:
                batch.put_file(local,PREFIX+'/'+name)
            # Read back destination and verify SHA, not just name/size.
            digest=hashlib.sha256();checked=0
            for chunk in destination.read_file(PREFIX+'/'+name):
                digest.update(chunk);checked+=len(chunk)
            if checked!=size or digest.hexdigest()!=expected['sha256']:
                emit('event',{'kind':'phase_error','phase':'integrity','error_type':'DESTINATION_SHA256_MISMATCH','file':name})
                raise RuntimeError('Destination integrity failure')
            done+=size
            emit('event',{'phase':'integrity','kind':'file_verified','file':name,'transferred':done,'required':required})
            if official:local.unlink()  # Valid destination is now the durable copy.
    # Every destination file was either hash-checked above or after upload.
    config_started=time.monotonic();emit('event',{'phase':'engine_configuration','kind':'phase_start'})
    runtime={'model_revision':MANIFEST['model_revision'],'source_commit':MANIFEST['source_commit'],'torch':'2.9.1+cu128','cuda':'12.8','gpu_choices':['RTX-PRO-6000','L40S'],'native_audio':True,'vae':'conv','offload':'cpu','precision':'FP8 cast / BF16 compute'}
    marker={'revision':MANIFEST['model_revision'],'files':MANIFEST['files'],'preparedBy':'iraqi-film-forge','time':time.time()}
    with destination.batch_upload(force=True) as batch:
        batch.put_file(io.BytesIO(json.dumps(runtime).encode()),PREFIX+'/RUNTIME.json')
        batch.put_file(io.BytesIO(json.dumps(marker).encode()),PREFIX+'/READY.json')
    emit('event',{'phase':'engine_configuration','kind':'phase_end','seconds':time.monotonic()-config_started})
    final=discover(request)
    if not final['ready']:
        raise RuntimeError('Final readiness failed')
    return {'ready':True,'transferredBytes':done,'cloud_stopped':True,'gpuUsed':False,'elapsedSeconds':time.monotonic()-started,'recordedCost':None,'inspection':final}


def official_model_info(request):
    from huggingface_hub import hf_hub_download
    cache=Path(request['cacheDir']);cache.mkdir(parents=True,exist_ok=True,mode=0o700)
    result=[]
    for name,expected in MANIFEST['files'].items():
        info=hf_hub_download(repo_id=MANIFEST['model_repo'],revision=MANIFEST['model_revision'],filename=name,
                             token=request['hfCredentials']['HF_TOKEN'],cache_dir=cache,dry_run=True,endpoint='https://huggingface.co')
        if info.file_size!=expected['size']:raise RuntimeError('Official source size mismatch')
        result.append({'name':name,'size':info.file_size,'revision':MANIFEST['model_revision']})
    return {'files':result,'accessVerifiedBy':'official hf_hub_download(dry_run=True) metadata requests','modelDownloaded':False}


def main():
    request=json.loads(sys.stdin.readline())
    action=request['action']
    if action=='verify':
        _, workspace=client(request['credentials']);result={'workspace':workspace,'verified':True,'capacity':'unknown'}
    elif action=='discover':result=discover(request)
    elif action in ('inspect','stop'):
        client(request['credentials'])
        result=sync_metadata(request['credentials'],request['appId'],request['jobId'],action=='stop',started_at=request.get('startedAt'))
    elif action=='transfer':result=transfer(request)
    elif action=='official_plan':result=official_model_info(request)
    elif action in ('generate','session'):
        from gpu_host import run
        result=run(request,session=action=='session')
    else:raise RuntimeError('Unsupported action')
    emit('result',result)


def sync_metadata(*args,**kwargs):
    # Run internal RPCs on the SDK synchronizer's loop, not asyncio.run's separate loop.
    # This avoids the from_env singleton crossing event loops after Workspace.hydrate.
    from modal._utils.async_utils import synchronize_api
    return synchronize_api(metadata)(*args,**kwargs)


if __name__=='__main__':
    try:main()
    except BaseException:
        emit('error',{'code':'MODAL_OPERATION_FAILED'})
        sys.exit(1)
