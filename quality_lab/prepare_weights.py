"""One approved CPU-only preparation of the two pinned quality files."""
import argparse
import json
import sys
import time
import uuid
from pathlib import Path


def prepare_remote(specs, revision, mounted_volume):
    import hashlib
    import json
    import os
    import time
    import urllib.request
    import urllib.parse
    from pathlib import Path
    start=time.monotonic()
    root=Path('/models/ltx25')/revision
    marker=root/'READY.json'
    if not marker.is_file() or json.loads(marker.read_text()).get('revision')!=revision:
        raise RuntimeError('EXISTING_BASE_READY_REQUIRED')
    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl):
            parsed=urllib.parse.urlsplit(newurl)
            host=parsed.hostname or ''
            if parsed.scheme!='https' or not (host=='huggingface.co' or host.endswith(('.huggingface.co','.hf.co','.xethub.hf.co'))):
                raise RuntimeError('UNEXPECTED_DOWNLOAD_REDIRECT')
            redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
            if host!=urllib.parse.urlsplit(req.full_url).hostname:
                redirected.remove_header('Authorization')
            return redirected
    opener=urllib.request.build_opener(SafeRedirect())
    results=[]
    for spec in specs:
        path=root/spec['relative_path']
        if path.exists():
            if path.stat().st_size!=spec['size']:
                raise RuntimeError('EXISTING_FILE_SIZE_MISMATCH_NO_OVERWRITE')
            digest=hashlib.sha256()
            with path.open('rb') as f:
                for block in iter(lambda:f.read(8*1024**2),b''):digest.update(block)
            if digest.hexdigest()!=spec['sha256']:
                raise RuntimeError('EXISTING_FILE_HASH_MISMATCH_NO_OVERWRITE')
            results.append({'file':spec['relative_path'],'size':spec['size'],'status':'already_verified'})
            continue
        path.parent.mkdir(parents=True,exist_ok=True)
        temp=path.with_name(path.name+'.quality-part')
        if temp.exists():raise RuntimeError('PRIOR_PARTIAL_REQUIRES_INSPECTION_NO_RETRY')
        token=os.environ.get('HF_TOKEN')
        if not token:raise RuntimeError('HF_TOKEN_MISSING')
        url=f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{spec['source_file']}"
        request=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
        digest=hashlib.sha256();count=0;reported=0
        stage='download'
        try:
            with opener.open(request,timeout=60) as response,temp.open('xb') as f:
                for block in iter(lambda:response.read(8*1024**2),b''):
                    count+=len(block)
                    if count>spec['size']:raise RuntimeError('DOWNLOAD_SIZE_EXCEEDED')
                    f.write(block);digest.update(block)
                    if count-reported>=64*1024**2:
                        print(json.dumps({'phase':'transfer','file':spec['relative_path'],'bytes':count,'total':spec['size']}),flush=True)
                        reported=count
            if count!=spec['size'] or digest.hexdigest()!=spec['sha256']:
                raise RuntimeError('DOWNLOADED_FILE_INTEGRITY_FAILED')
            stage='persist'
            temp.rename(path)
            print(json.dumps({'phase':'verified','file':spec['relative_path'],'bytes':count,'sha256':digest.hexdigest()}),flush=True)
            # Commit verified additions only; the original READY is untouched.
            # Use the exact hydrated mount, not a fresh name lookup in the worker.
            mounted_volume.commit()
        except Exception as exc:
            code=getattr(exc,'code',None)
            safe_code=f'_HTTP{code}' if isinstance(code,int) else ''
            raise RuntimeError(f'QUALITY_PREPARATION_FAILED_STAGE_{stage}_{type(exc).__name__}{safe_code}') from None
        results.append({'file':spec['relative_path'],'size':count,'sha256':digest.hexdigest(),'status':'verified'})
    return {'status':'completed','files':results,'seconds':time.monotonic()-start,'gpu_used':False,'base_ready_unchanged':True}


def main():
    for stream in (sys.stdout,sys.stderr):
        if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf-8')
    # Controller-only manifests are not dependencies of the CPU worker module.
    # Modal imports this module before calling prepare_remote in its minimal image.
    from quality_lab.plan import ROOT, BASE, EXTRA
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approve-prepare-only',action='store_true')
    parser.add_argument('--workspace',required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    args=parser.parse_args()
    if not args.approve_prepare_only:raise RuntimeError('Explicit CPU preparation approval required')
    sys.path.insert(0,str(ROOT.parent/'engine'))
    from modal_bridge import client,sync_metadata
    creds={'mode':'local_profile','expectedWorkspace':args.workspace}
    c,_=client(creds)
    status=sync_metadata(creds,include_billing=False)
    if status.get('runningTasks')!=0:raise RuntimeError('ACTIVE_OR_UNKNOWN_TASKS')
    import modal
    job=str(uuid.uuid4());app=modal.App('iff-engine-'+job)
    volume=modal.Volume.from_name('modal-ltx25-test-models',create_if_missing=False,client=c,environment_name='main')
    secret=modal.Secret.from_name('ltx25-hf-read',required_keys=['HF_TOKEN'],environment_name='main')
    remote=app.function(image=modal.Image.debian_slim(python_version='3.12'),cpu=(1,1),memory=(4096,4096),
        timeout=600,startup_timeout=120,retries=0,max_containers=1,min_containers=0,
        scaledown_window=2,volumes={'/models':volume},secrets=[secret])(prepare_remote)
    args.output_dir.mkdir(parents=True,exist_ok=False)
    receipt={'job_id':job,'status':'starting','cloud_stopped':False}
    def save():
        temp=args.output_dir/'receipt.tmp'
        temp.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        temp.replace(args.output_dir/'receipt.json')
    save();started=time.time()
    try:
        with modal.enable_output(),app.run(client=c):
            receipt.update(app_id=app.app_id,status='running');save()
            receipt.update(result=remote.remote(EXTRA,BASE['model_revision'],volume),status='completed')
    except BaseException:
        receipt['status']='failed_no_retry'
        raise
    finally:
        receipt['elapsed_seconds']=time.time()-started
        if app.app_id:
            try:
                cleanup=sync_metadata(creds,app.app_id,job,True,started_at=started)
                receipt.update(cleanup=cleanup,cloud_stopped=cleanup['cloud_stopped'])
            except Exception:receipt['cleanup_error']='CLOUD_STATE_UNKNOWN_NO_NEW_JOB'
        save()
    print(json.dumps(receipt,indent=2))


if __name__=='__main__':main()
