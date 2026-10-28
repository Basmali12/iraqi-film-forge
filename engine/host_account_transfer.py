"""Official explicit-client calls from HostHatch, never from another Modal input."""
import io
import modal
from transfer_contract import *
from transfer_orchestrator import advance
from transfer_verified_copy import validated_receipt, copy_with_destination_verification, finalize_verified_copy


def require_external_control():
    if not modal.is_local() or modal.current_input_id() is not None:
        raise RuntimeError('HOST_CONTROL_PLANE_REQUIRED')


class AccountTransfer:
    def __init__(self, request, record, source, state, destination):
        self.request, self.record = request, record
        self.source, self.state, self.destination = source, state, destination
        self.job, self.volume = request['jobId'], request['volume']
        self.name, state_name = verifier_names(self.volume)
        self.dest_state = modal.Dict.from_name(state_name, client=destination, create_if_missing=False, environment_name='main')

    def window(self, stage):
        return (TIMEOUT if stage == 'copy' else VERIFY_TIMEOUT)+STARTUP+30

    def submit(self, stage):
        require_external_control()
        job = self.job
        if self.state.get('cancel:'+job, False):
            raise RuntimeError('TRANSFER_CANCELLED')
        if stage == 'copy':
            before = self.state.get('orchestrator:'+job+':receipt:before')
            valid = validated_receipt(MANIFEST, before)
            approved = set(self.record['files'])
            if set(MANIFEST['files'])-valid-approved:
                raise RuntimeError('TRANSFER_REQUIRES_NEW_PLAN')
            secret = modal.Secret.from_dict({'IFF_DEST_TOKEN_ID':self.request['credentials']['tokenId'],
                                            'IFF_DEST_TOKEN_SECRET':self.request['credentials']['tokenSecret']})
            fn = modal.Function.from_name(APP_NAME, FUNCTION_NAME, client=self.source, environment_name='main').with_options(
                secrets=[secret], retries=0, max_containers=1, buffer_containers=0, scaledown_window=2, timeout=TIMEOUT)
            call = fn.spawn({'jobId':job, 'paidApproved':True, 'fingerprint':FINGERPRINT,
                'destinationWorkspace':self.record['workspace'], 'volume':self.volume,
                'files':self.record['files'], 'mode':'full', 'hostOrchestrated':True})
            return {'callId':call.object_id, 'appId':self.record['appId']}
        claim = {'jobId':job, 'phase':stage, 'fingerprint':FINGERPRINT}
        deployment = self.dest_state.get('deployment')
        if not deployment or deployment.get('fingerprint') != FINGERPRINT:
            raise RuntimeError('DESTINATION_VERIFIER_NOT_READY')
        if not self.dest_state.put('claim:'+job+':'+stage, claim, skip_if_exists=True):
            raise RuntimeError('DUPLICATE_VERIFICATION_NO_RETRY')
        call = modal.Function.from_name(self.name, 'verify_models', client=self.destination,
                                       environment_name='main').spawn({**claim, 'paidApproved':True})
        return {'callId':call.object_id, 'appId':deployment['appId']}

    def observe(self, stage, slot, cancel=False):
        is_copy = stage == 'copy'
        client = self.source if is_copy else self.destination
        registry = self.state if is_copy else self.dest_state
        key = 'progress:'+self.job+('' if is_copy else ':'+stage)
        call = modal.FunctionCall.from_id(slot['callId'], client=client)
        if cancel:
            registry.put('cancel:'+self.job, True)
            call.cancel(terminate_containers=True)
        progress = registry.get(key, {})
        try:
            result = call.get(timeout=0)
        except (modal.exception.InputCancellation, modal.exception.FunctionTimeoutError):
            result = {'status':'failed', 'error':'TRANSFER_CANCELLED' if cancel else 'TRANSFER_TIMEOUT'}
        except (TimeoutError, modal.exception.TimeoutError):
            return {'terminal':False, 'events':progress.get('events', [])}
        # Other exceptions are unknown, never evidence of termination.
        if not is_copy and not result.get('error'):
            if (result.get('jobId'), result.get('phase'), result.get('fingerprint')) != (self.job, stage, FINGERPRINT):
                result = {'status':'failed', 'error':'VERIFIER_RECEIPT_SCOPE_MISMATCH'}
        return {'terminal':True, 'result':result, 'events':progress.get('events', [])}

    def counts(self):
        from cloud_transfer_host import containers
        from modal._utils.async_utils import synchronize_api
        counts = []
        for credentials, app in ((self.request['source'], self.record['appId']),
                                 (self.request['credentials'], self.record['verifier']['appId'])):
            try:
                counts.append(synchronize_api(containers)(credentials, app))
            except Exception:
                counts.append(None)
        return tuple(counts)

    def verification_result(self, receipt):
        # This pure path never touches a source file or creates a Volume/marker.
        return copy_with_destination_verification(MANIFEST, '', None, [], lambda phase:receipt, verify_only=True)

    def finalize(self, receipt):
        require_external_control()
        def check():
            if self.state.get('cancel:'+self.job, False):
                raise RuntimeError('TRANSFER_CANCELLED')
        check()
        volume = modal.Volume.from_name(self.volume, client=self.destination, create_if_missing=False, environment_name='main')
        class Markers:
            def ensure(self):
                volume.hydrate()
            def upload_bytes(self, name, content):
                if name not in ('READY.json', 'RUNTIME.json') or len(content) > 65536:
                    raise ValueError('METADATA_ONLY')
                with volume.batch_upload(force=True) as batch:
                    batch.put_file(io.BytesIO(content), PREFIX+'/'+name)
            def read(self, name):
                if name != 'READY.json':
                    raise ValueError('METADATA_ONLY')
                return volume.read_file(PREFIX+'/'+name)
        copy_slot = self.state.get('orchestrator:'+self.job+':receipt:copy', {})
        return finalize_verified_copy(MANIFEST, Markers(), receipt, copy_slot.get('transferredBytes', 0), check=check)


def dispatch(request, source, state, destination, workspace):
    require_external_control()
    if request.get('paidApproved') is not True:
        raise RuntimeError('EXPLICIT_TRANSFER_APPROVAL_REQUIRED')
    from destination_verifier_control import ensure_destination_verifier
    job = request['jobId']
    key = 'dispatch:'+job
    existing = state.get(key)
    if existing:
        if existing.get('workspace') != workspace or existing.get('volume') != request['volume']:
            raise RuntimeError('TRANSFER_CLAIM_MISMATCH')
        return {'worker_app_id':existing['appId'], 'reused':True, 'host_orchestrated':True}
    if not state.put('active', job, skip_if_exists=True):
        raise RuntimeError('ONE_CLOUD_TRANSFER_ONLY')
    record = {'jobId':job, 'workspace':workspace, 'volume':request['volume'],
        'fingerprint':FINGERPRINT, 'mode':request['plan']['mode'],
        'files':[f['name'] for f in request['plan']['files']],
        'appId':state.get('deployment')['appId'], 'hostOrchestrated':True}
    if not state.put(key, record, skip_if_exists=True):
        raise RuntimeError('TRANSFER_DISPATCH_UNCERTAIN_NO_RETRY')
    verifier = ensure_destination_verifier(destination, request['volume'], create_volume=record['mode'] != 'verify-only')
    record['verifier'] = verifier
    state.put(key, record)
    if not state.get('cancel:'+job, False):
        # First CPU call belongs to destination; source CPU is not started yet.
        advance(state, job, record, AccountTransfer(request, record, source, state, destination))
    return {'worker_app_id':record['appId'], 'host_orchestrated':True, 'reused':False,
            'cancelled_before_spawn':bool(state.get('cancel:'+job,False))}


def status(request, record, source, state, cancel=False):
    require_external_control()
    from modal_bridge import client
    destination, workspace = client(request['credentials'])
    if workspace != record['workspace'] or record['fingerprint'] != FINGERPRINT:
        raise RuntimeError('TRANSFER_CLAIM_MISMATCH')
    if not record.get('verifier'):
        if cancel:
            state.put('cancel:'+request['jobId'], True)
        return {'cloud_stopped':False, 'state':'setup_unknown', 'events':[]}
    return advance(state, request['jobId'], record, AccountTransfer(request, record, source, state, destination), cancel=cancel)
