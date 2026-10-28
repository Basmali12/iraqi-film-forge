"""Restartable HostHatch control plane. Callbacks carry metadata, never weights.

Durable per-stage reservations prohibit redispatch after an ambiguous response.
No account credentials, SDK handles or model bytes are persisted here.
"""
import re
import time

STAGES = ('before', 'copy', 'after')


def advance(state, job, record, adapter, cancel=False, now=time.time):
    prefix = 'orchestrator:'+job+':'
    if cancel:
        state.put('cancel:'+job, True)
    stopped_by_user = state.get('cancel:'+job, False)
    final = state.get(prefix+'final')
    events = []
    pending = False
    uncertain = False
    for index, stage in enumerate(STAGES):
        slot = state.get(prefix+stage)
        if stopped_by_user or final:
            if not slot:
                continue
        elif slot is None:
            # Re-evaluate cancellation immediately before every new reservation.
            if state.get('cancel:'+job, False):
                stopped_by_user = True
                break
            if not state.put(prefix+stage, {'reservedAt':now()}, skip_if_exists=True):
                return {'cloud_stopped':False, 'state':'transition_in_progress', 'events':[]}
            slot = state.get(prefix+stage)
            try:
                # An accepted call whose response is lost MUST NOT be submitted again.
                slot.update(adapter.submit(stage), submittedAt=now())
                state.put(prefix+stage, slot)
            except Exception as error:
                cls = type(error).__name__
                slot['dispatchErrorClass'] = cls if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', cls) else 'UnknownError'
                state.put(prefix+stage, slot)
                final = {'status':'failed', 'ready':False, 'error':'TRANSFER_DISPATCH_UNCERTAIN_NO_RETRY'}
                state.put(prefix+'final', final)
                uncertain = True
                break
        if not slot:
            continue
        # Another process can observe the durable reservation before submission
        # finishes. It can observe/cancel, but can never send the call again.
        if not slot.get('callId'):
            uncertain = True
            break
        cleanup = stopped_by_user or (final or {}).get('status') in ('failed', 'needs_review')
        observation = adapter.observe(stage, slot, cancel=cleanup)
        for event in observation.get('events', []):
            events.append({**event, 'sequence':index*1000000+event.get('sequence', 0)})
        if not observation.get('terminal'):
            if now()-slot['reservedAt'] > adapter.window(stage):
                state.put('cancel:'+job, True)
                final = {'status':'failed', 'ready':False, 'error':'TRANSFER_TIMEOUT'}
                state.put(prefix+'final', final)
            pending = True
            break
        if 'finishedAt' not in slot:
            slot['finishedAt'] = now()
            state.put(prefix+stage, slot)
        result = observation.get('result') or {}
        if stopped_by_user or final:
            continue
        if result.get('error') or result.get('status') in ('failed', 'needs_review'):
            final = {**result, 'ready':False, 'status':result.get('status', 'failed')}
        elif stage == 'before' and record['mode'] == 'verify-only':
            try:
                final = adapter.verification_result(result)
            except ValueError:
                final = {'status':'failed', 'ready':False, 'error':'DESTINATION_VERIFICATION_FAILED'}
        elif stage == 'after':
            # Persist a finalization reservation too: lost acknowledgement never
            # causes automatic marker writes again on another poll/restart.
            if state.put(prefix+'finalizing', True, skip_if_exists=True):
                try:
                    final = adapter.finalize(result)
                except Exception:
                    final = {'status':'failed', 'ready':False, 'error':'FINALIZATION_FAILED_NO_RETRY'}
            else:
                pending = True
                break
        if final:
            state.put(prefix+'final', final)
            break
        # Keep the receipt, scoped by job/phase/fingerprint, for the next call.
        state.put(prefix+'receipt:'+stage, result)
    if stopped_by_user and not final:
        final = {'status':'failed', 'ready':False, 'error':'TRANSFER_CANCELLED'}
        state.put(prefix+'final', final)
    if (final or {}).get('ready') is True:
        # These milestones follow verified metadata writes/readback, never a timer.
        events.extend([{'sequence':3000001,'kind':'phase_end','phase':'engine_configuration'},
                       {'sequence':3000002,'kind':'ready','phase':'ready'}])
    source_count, destination_count = adapter.counts()
    # Zero containers does not prove an ambiguously submitted/queued call ended.
    stopped = bool(final) and not pending and not uncertain and source_count == 0 and destination_count == 0
    if stopped and state.get('active') == job:
        state.pop('active', None)
    return {'cloud_stopped':stopped, 'callFinished':bool(final),
            'source_containers':source_count, 'destination_containers':destination_count,
            'running_containers':None if None in (source_count, destination_count) else source_count+destination_count,
            'tasks':None if None in (source_count, destination_count) else source_count+destination_count,
            'result':final, 'error':(final or {}).get('error'), 'recordedCost':None,
            'gpuUsed':False, 'events':events,
            'state':'finished' if stopped else 'dispatch_unknown' if uncertain else 'running'}
