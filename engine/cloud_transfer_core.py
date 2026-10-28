"""CPU-only copy algorithm. No SDK, credentials, local staging, downloads or GPU."""
import hashlib
import json
from pathlib import Path


def digest(chunks,on_bytes=lambda n:None):
    hashed=hashlib.sha256();size=0
    for chunk in chunks:
        hashed.update(chunk);size+=len(chunk);on_bytes(size)
    return size,hashed.hexdigest()


def file_chunks(path):
    with Path(path).open('rb') as stream:
        while chunk:=stream.read(8*2**20):yield chunk


def copy_probe(source_root,target,name,job_id,limit=65536):
    """An explicitly approved tiny cross-account check, never a readiness marker."""
    path=Path(source_root)/name
    if not path.resolve().is_relative_to(Path(source_root).resolve()):raise ValueError('INVALID_SOURCE_PATH')
    with path.open('rb') as stream:content=stream.read(limit)
    if not content:raise ValueError('EMPTY_PROBE_SOURCE')
    probe='_probe/'+job_id+'.bin';target.ensure();target.upload_bytes(probe,content)
    if digest(target.read(probe))!=(len(content),hashlib.sha256(content).hexdigest()):raise ValueError('PROBE_SHA256_MISMATCH')
    return {'probeVerified':True,'ready':False,'gpuUsed':False,'transferredBytes':len(content),'status':'completed'}


def copy_weights(manifest,source_root,target,approved,emit=lambda **e:None,check=lambda:None):
    """Source root is a read-only CLOUD Volume mount, never HostHatch disk."""
    files=manifest['files'];approved=set(approved)
    if not approved.issubset(files):raise ValueError('UNAPPROVED_FILE')
    verified=[];needed=[]
    emit(kind='phase_start',phase='source_discovery')
    for name,expected in files.items():
        check()
        if target.exists(name):
            emit(kind='phase_start',phase='integrity',file=name)
            size,sha=digest(target.read(name),lambda n:check())
            if (size,sha)==(expected['size'],expected['sha256']):
                verified.append(name);emit(kind='file_verified',phase='integrity',file=name);continue
        needed.append(name)
    emit(kind='phase_end',phase='source_discovery')
    unexpected=[name for name in needed if name not in approved]
    if unexpected:
        return {'ready':False,'requiresNewPlan':True,'corruptFiles':unexpected,'gpuUsed':False}
    required=sum(files[n]['size'] for n in needed);done=0
    for name in needed:
        check();expected=files[name];path=Path(source_root)/name
        if not path.resolve().is_relative_to(Path(source_root).resolve()):raise ValueError('INVALID_SOURCE_PATH')
        emit(kind='phase_start',phase='transfer',file=name)
        def observed(size):
            check();emit(kind='progress',phase='transfer',file=name,transferred=done+size,required=required,unit='source_bytes_hashed')
        size,sha=digest(file_chunks(path),observed)
        if (size,sha)!=(expected['size'],expected['sha256']):raise ValueError('SOURCE_SHA256_MISMATCH')
        emit(kind='phase_start',phase='storage');target.ensure();emit(kind='phase_end',phase='storage')
        emit(kind='phase_start',phase='upload',file=name)
        target.upload(name,path)  # SDK reads the cloud mount, no temporary weight file.
        emit(kind='phase_end',phase='upload',file=name)
        check();emit(kind='phase_start',phase='integrity',file=name)
        actual=digest(target.read(name),lambda n:check())
        if actual!=(expected['size'],expected['sha256']):raise ValueError('DESTINATION_SHA256_MISMATCH')
        done+=size;verified.append(name)
        emit(kind='file_verified',phase='integrity',file=name,transferred=done,required=required)
    check();target.ensure();emit(kind='phase_start',phase='engine_configuration')
    runtime={'model_revision':manifest['model_revision'],'source_commit':manifest['source_commit'],
             'native_audio':True,'vae':'conv','gpu_choices':['RTX-PRO-6000','L40S'],
             'torch':'2.9.1+cu128','cuda':'12.8','precision':'FP8 cast / BF16 compute','offload':'cpu'}
    target.upload_bytes('RUNTIME.json',json.dumps(runtime).encode())
    marker={'revision':manifest['model_revision'],'files':files,'hashVerified':True}
    target.upload_bytes('READY.json',json.dumps(marker).encode())
    if json.loads(b''.join(target.read('READY.json'))) != marker:raise ValueError('READY_MARKER_MISMATCH')
    emit(kind='phase_end',phase='engine_configuration');emit(kind='ready',phase='ready')
    return {'ready':True,'gpuUsed':False,'transferredBytes':done,'verifiedFiles':verified,
            'inspection':{'ready':True,'revision':manifest['model_revision'],'hashVerifiedByTransfer':True,
                'files':[{'name':n,'size':v['size'],'manifestMatch':True,'hashVerifiedNow':True} for n,v in files.items()],
                'readyMarker':{'revision':manifest['model_revision'],'present':True}}}
