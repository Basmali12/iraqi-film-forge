"""Deploy only with separate owner approval. CPU worker in the TRUSTED workspace."""
import os
if os.environ.get('IFF_DEFINE_TRANSFER_WORKER')!='YES':raise RuntimeError('TRANSFER_WORKER_DEFINITION_NOT_APPROVED')
import io
import json
import re
import time
import modal
from transfer_contract import *

app=modal.App(APP_NAME)
source=modal.Volume.from_name(SOURCE_VOLUME,create_if_missing=False).with_mount_options(read_only=True)
state=modal.Dict.from_name(DICT_NAME,create_if_missing=True)
image=(modal.Image.debian_slim(python_version='3.12').pip_install('modal==1.6.2').env({'IFF_DEFINE_TRANSFER_WORKER':'YES'})
       .add_local_file(ROOT/'cloud_transfer_core.py','/root/cloud_transfer_core.py')
       .add_local_file(ROOT/'transfer_verified_copy.py','/root/transfer_verified_copy.py')
       .add_local_file(ROOT/'transfer_contract.py','/root/transfer_contract.py')
       .add_local_file(ROOT/'runtime/source-manifest.json','/root/runtime/source-manifest.json'))


@app.function(image=image,cpu=(CPU,CPU),memory=(RAM_MIB,RAM_MIB),timeout=TIMEOUT,startup_timeout=STARTUP,
              retries=0,max_containers=1,min_containers=0,buffer_containers=0,scaledown_window=2,
              volumes={'/source':source})
def copy_models(request):
    from cloud_transfer_core import copy_probe
    from transfer_verified_copy import copy_with_destination_verification
    from modal.exception import NotFoundError
    job=request.get('jobId','');workspace=request.get('destinationWorkspace','');volume=request.get('volume','')
    if not re.fullmatch(r'[a-f0-9-]{36}',job) or request.get('paidApproved') is not True:raise RuntimeError('TRANSFER_APPROVAL_REQUIRED')
    if workspace==SOURCE_WORKSPACE or not workspace or not re.fullmatch(r'iff-ltx25-[a-f0-9]{8}',volume):raise RuntimeError('INVALID_TRANSFER_DESTINATION')
    if request.get('fingerprint')!=FINGERPRINT:raise RuntimeError('WORKER_VERSION_CHANGED')
    claim=state.get('dispatch:'+job)
    if not claim or claim.get('workspace')!=workspace or claim.get('volume')!=volume or claim.get('files')!=request.get('files') or claim.get('mode')!=request.get('mode') or state.get('active')!=job:raise RuntimeError('TRANSFER_CLAIM_MISMATCH')
    if not state.put('execution:'+job,True,skip_if_exists=True):raise RuntimeError('DUPLICATE_TRANSFER_NO_RETRY')
    events=[];sequence=0;last=0;verified=[]
    def emit(**event):
        nonlocal sequence,last
        now=time.monotonic()
        if event.get('kind')=='progress' and now-last<1:return
        last=now;sequence+=1;event.update(sequence=sequence,time=time.time())
        events.append(event)
        if event.get('kind')=='file_verified' and event['file'] not in verified:verified.append(event['file'])
        state.put('progress:'+job,{'status':'running','events':events[-80:],'sequence':sequence,'verifiedFiles':verified})
    checked_at=[0.0]
    def check():
        now=time.monotonic()
        if now-checked_at[0]>=1:
            checked_at[0]=now
            if state.get('cancel:'+job,False):raise RuntimeError('TRANSFER_CANCELLED')
    try:
        emit(kind='phase_start',phase='connection')
        c=modal.Client.from_credentials(os.environ['IFF_DEST_TOKEN_ID'],os.environ['IFF_DEST_TOKEN_SECRET'])
        current=modal.Workspace.from_context(client=c);current.hydrate()
        if current.name!=workspace:raise RuntimeError('DESTINATION_WORKSPACE_MISMATCH')
        emit(kind='phase_end',phase='connection')
        class Target:
            def __init__(self):
                self.volume=None;self.entries=set()
                try:
                    candidate=modal.Volume.from_name(volume,client=c,create_if_missing=False,environment_name='main');candidate.hydrate()
                    self.volume=candidate
                    self.entries={e.path.lstrip('/') for e in candidate.listdir(PREFIX,recursive=True)}
                except NotFoundError:pass
            def exists(self,name):return (PREFIX+'/'+name).lstrip('/') in self.entries
            def ensure(self):
                check()
                if self.volume is None:
                    self.volume=modal.Volume.from_name(volume,client=c,create_if_missing=True,environment_name='main');self.volume.hydrate()
            def read(self,name):return self.volume.read_file(PREFIX+'/'+name)
            def upload(self,name,path):
                check()
                with self.volume.batch_upload(force=True) as batch:batch.put_file(path,PREFIX+'/'+name)
            def upload_bytes(self,name,content):self.upload(name,io.BytesIO(content))
        if request.get('mode')=='probe':
            emit(kind='phase_start',phase='probe');result=copy_probe('/source'+PREFIX,Target(),next(iter(MANIFEST['files'])),job)
            emit(kind='phase_end',phase='probe')
        else:
            if not claim.get('hostOrchestrated') or not request.get('hostOrchestrated'):
                raise RuntimeError('HOST_CONTROL_PLANE_REQUIRED')
            before=state.get('orchestrator:'+job+':receipt:before')
            if not before or (before.get('jobId'),before.get('phase'),before.get('fingerprint'))!=(job,'before',FINGERPRINT):
                raise RuntimeError('VERIFIER_RECEIPT_SCOPE_MISMATCH')
            # Source worker only hashes/uploads. HostHatch invokes the destination
            # verifier separately, after this CPU call has returned.
            verify=lambda phase:before
            result=copy_with_destination_verification(MANIFEST,'/source'+PREFIX,Target(),
                request['files'],verify,emit,check,upload_only=True)
    except BaseException as error:
        code=str(error) if isinstance(error,(ValueError,RuntimeError)) and re.fullmatch(r'[A-Z_]{4,80}',str(error)) else 'CLOUD_TRANSFER_FAILED'
        emit(kind='phase_error',phase='cloud_transfer',error_type=code)
        result={'status':'failed','ready':False,'gpuUsed':False,'error':code}
        if getattr(error,'corrupt_files',None):
            result.update(requiresNewPlan=True,corruptFiles=[n for n in error.corrupt_files if n in MANIFEST['files']])
    state.put('progress:'+job,{'status':result['status'],'events':events[-80:],'sequence':sequence,'verifiedFiles':verified,'result':result})
    return result
