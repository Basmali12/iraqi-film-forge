"""Global source function + lazy factory; deployment occurs only after approval.

No serialized nested functions: HostHatch/Windows Python versions can differ
from the image's Python 3.12 without shipping incompatible bytecode.
"""
import os
import re
import time
import modal
from transfer_contract import (ROOT, MANIFEST, PREFIX, FINGERPRINT, CPU, RAM_MIB,
                               STARTUP, VERIFY_TIMEOUT, verifier_names)

def _verify_models(request):
    volume_name=os.environ.get("IFF_VERIFY_VOLUME", "")
    _,state_name=verifier_names(volume_name)
    from destination_integrity import verify_mounted_files
    job = request.get('jobId', '')
    phase = request.get('phase')
    if (not re.fullmatch(r'[a-f0-9-]{36}', job) or phase not in ('before', 'after')
            or request.get('fingerprint') != FINGERPRINT
            or request.get('paidApproved') is not True):
        raise RuntimeError('INVALID_VERIFIER_REQUEST')
    # Resolve scoped resources at runtime; no cross-Python bytecode serialization.
    # The approved deploy creates this Dict before a call can be submitted.
    state = modal.Dict.from_name(state_name, create_if_missing=False, environment_name='main')
    key = job+':'+phase
    claim = state.get('claim:'+key)
    if not claim or claim.get('fingerprint') != FINGERPRINT:
        raise RuntimeError('VERIFIER_CLAIM_REQUIRED')
    if not state.put('execution:'+key, modal.current_function_call_id(), skip_if_exists=True):
        raise RuntimeError('DUPLICATE_VERIFICATION_NO_RETRY')
    last = [0.0]; sequence = [0]; events = []
    def check():
        if state.get('cancel:'+job, False):
            raise RuntimeError('TRANSFER_CANCELLED')
    def emit(**event):
        timestamp = time.monotonic()
        if event.get('kind') == 'progress' and timestamp-last[0] < 1:
            return
        last[0] = timestamp; sequence[0] += 1
        event.update(sequence=sequence[0], time=time.time())
        events.append(event)
        state.put('progress:'+key, {'events':events[-80:]})
    try:
        check()
        mounted = modal.Volume.from_name(volume_name, create_if_missing=False, environment_name='main')
        mounted.reload()  # New SDK uploads must be visible before opening files.
        # A Dict RPC per chunk would itself throttle hashing. Check cancellation
        # at most once/second, while the host can also terminate this call.
        checked = [0.0]
        def throttled_check():
            timestamp = time.monotonic()
            if timestamp-checked[0] >= 1:
                checked[0] = timestamp; check()
        result = verify_mounted_files('/weights'+PREFIX, MANIFEST['files'],
                                     emit=emit, check=throttled_check)
        result.update(revision=MANIFEST['model_revision'], fingerprint=FINGERPRINT,
                      jobId=job, phase=phase)
    except BaseException as error:
        code = str(error) if str(error) == 'TRANSFER_CANCELLED' else 'DESTINATION_VERIFICATION_FAILED'
        result = {'error':code, 'verificationPassed':False, 'jobId':job, 'phase':phase}
    state.put('result:'+key, result)
    return result


def create_verifier_app(volume_name, create_volume=True):
    app_name,state_name=verifier_names(volume_name)
    app=modal.App(app_name)
    volume=modal.Volume.from_name(volume_name,create_if_missing=create_volume)
    image=(modal.Image.debian_slim(python_version='3.12').pip_install('modal==1.6.2')
        .add_local_file(ROOT/'destination_integrity.py','/root/destination_integrity.py')
        .add_local_file(ROOT/'destination_verifier_app.py','/root/destination_verifier_app.py')
        .add_local_file(ROOT/'transfer_contract.py','/root/transfer_contract.py')
        .add_local_file(ROOT/'runtime/source-manifest.json','/root/runtime/source-manifest.json'))
    fn=app.function(name='verify_models',image=image,env={'IFF_VERIFY_VOLUME':volume_name},
        cpu=(CPU,CPU),memory=(RAM_MIB,RAM_MIB),timeout=VERIFY_TIMEOUT,startup_timeout=STARTUP,
        retries=0,max_containers=1,min_containers=0,buffer_containers=0,scaledown_window=2,
        volumes={'/weights':volume.with_mount_options(read_only=True)})(_verify_models)
    return app,fn,state_name
