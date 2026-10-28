"""Explicitly paid deployment; read-only mounts; durable child-call reservations."""
import time
import contextvars
import re
import modal
from transfer_contract import FINGERPRINT, MANIFEST, VERIFY_TIMEOUT, STARTUP, verifier_names


def deploy_destination_verifier(client, volume, create_volume=True):
    from destination_verifier_app import create_verifier_app
    app, _, state = create_verifier_app(volume, create_volume=create_volume)
    app.deploy(name=app.name, client=client, environment_name='main')
    # Hydrate the otherwise lazy control registry during the approved deployment.
    name, state_name = verifier_names(volume)
    state = modal.Dict.from_name(state_name, create_if_missing=True, client=client, environment_name='main')
    fn = modal.Function.from_name(name, 'verify_models', client=client, environment_name='main')
    fn.hydrate()
    deployment = {'fingerprint':FINGERPRINT, 'appId':app.app_id, 'functionId':fn.object_id}
    state.put('deployment', deployment)
    return deployment


def ensure_destination_verifier(client, volume, create_volume=True):
    name, state_name = verifier_names(volume)
    try:
        state = modal.Dict.from_name(state_name, create_if_missing=False, client=client, environment_name='main')
        deployment = state.get('deployment')
        fn = modal.Function.from_name(name, 'verify_models', client=client, environment_name='main'); fn.hydrate()
        if deployment and deployment.get('fingerprint') == FINGERPRINT and deployment.get('functionId') == fn.object_id:
            return deployment
    except modal.exception.NotFoundError:
        pass
    return deploy_destination_verifier(client, volume, create_volume=create_volume)


def verify_destination(client, source_state, job, volume, phase, emit, check):
    name, state_name = verifier_names(volume)
    state = modal.Dict.from_name(state_name, create_if_missing=False, client=client, environment_name='main')
    key = job+':'+phase
    deployment = state.get('deployment')
    if not deployment or deployment.get('fingerprint') != FINGERPRINT:
        raise RuntimeError('DESTINATION_VERIFIER_NOT_READY')
    claim = {'fingerprint':FINGERPRINT, 'jobId':job, 'phase':phase}
    check()
    if not state.put('claim:'+key, claim, skip_if_exists=True):
        raise RuntimeError('DUPLICATE_VERIFICATION_NO_RETRY')
    # Persist the claim before sending: no implicit retry after an ambiguous spawn.
    child = {'phase':phase, 'appId':deployment['appId'], 'callId':None,'startedAt':time.time()}
    # Each phase has its own key; monitoring cannot overwrite a newly added
    # child when it reconciles the previous phase concurrently.
    source_state.put('child:'+key, child)
    check()
    fn = modal.Function.from_name(name, 'verify_models', client=client, environment_name='main')
    try:
        # The other workspace must not inherit the source container's input ID
        # or attempt context. Authentication still uses the destination client.
        call = contextvars.Context().run(fn.spawn,{**claim, 'paidApproved':True})
    except BaseException as error:
        name=type(error).__name__
        child['dispatchErrorClass']=name if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}',name) else 'UnknownError'
        child['dispatchFailedAt']=time.time()
        source_state.put('child:'+key,child)
        raise  # Preserve ambiguity; never send another call automatically.
    child['callId'] = call.object_id
    source_state.put('child:'+key, child)
    last_sequence = 0
    deadline = time.monotonic()+VERIFY_TIMEOUT+STARTUP+30
    try:
        while time.monotonic() < deadline:
            check()
            progress = state.get('progress:'+key, {})
            for event in progress.get('events', []):
                if event['sequence'] > last_sequence:
                    last_sequence = event['sequence']
                    emit(**{k:v for k,v in event.items() if k not in ('sequence','time')})
            try:
                result = call.get(timeout=0)
                if result.get('error'): raise RuntimeError(result['error'])
                if (result.get('jobId'),result.get('phase'),result.get('fingerprint')) != (job,phase,FINGERPRINT):
                    raise RuntimeError('VERIFIER_RECEIPT_SCOPE_MISMATCH')
                child['finishedAt']=time.time()
                source_state.put('child:'+key,child)
                return result
            except (TimeoutError, modal.exception.TimeoutError):
                time.sleep(2)
        raise RuntimeError('DESTINATION_VERIFIER_TIMEOUT')
    except BaseException:
        state.put('cancel:'+job, True)
        call.cancel(terminate_containers=True)
        raise
