"""Control-plane only: authenticated SDK metadata, dispatch once, observe/cancel.
No image definitions, mounts, file downloads or local staging on HostHatch.
"""
import asyncio
import time
import modal
from transfer_contract import *


def control(request):
    from modal_bridge import client
    c,workspace=client(request['source'])
    if workspace!=SOURCE_WORKSPACE:raise RuntimeError('TRUSTED_TRANSFER_WORKSPACE_REQUIRED')
    if request.get('workerApp')!=APP_NAME:raise RuntimeError('TRANSFER_WORKER_NOT_CONFIGURED')
    return c,modal.Dict.from_name(DICT_NAME,create_if_missing=False,client=c,environment_name='main')


def preflight(request):
    try:
        c,state=control(request)
        deployment=state.get('deployment')
        fn=modal.Function.from_name(APP_NAME,FUNCTION_NAME,client=c,environment_name='main');fn.hydrate()
        ready=bool(deployment and deployment.get('fingerprint')==FINGERPRINT and deployment.get('functionId')==fn.object_id and deployment.get('appId'))
        return {'workerReady':ready,'fingerprint':FINGERPRINT,'workerApp':APP_NAME,'cpu':CPU,'ramMiB':RAM_MIB,'timeout':TIMEOUT,'gpuUsed':False,'reason':None if ready else 'CLOUD_WORKER_VERSION_MISMATCH'}
    except Exception:
        return {'workerReady':False,'fingerprint':FINGERPRINT,'workerApp':APP_NAME,'gpuUsed':False,'reason':'CLOUD_WORKER_NOT_DEPLOYED'}


def dispatch(request):
    from modal_bridge import client
    if request.get('paidApproved') is not True:raise RuntimeError('EXPLICIT_TRANSFER_APPROVAL_REQUIRED')
    checked=preflight(request)
    if not checked['workerReady']:raise RuntimeError('CLOUD_WORKER_NOT_DEPLOYED')
    if request['plan'].get('workerFingerprint')!=FINGERPRINT:raise RuntimeError('WORKER_VERSION_CHANGED')
    mode=request['plan'].get('mode','full')
    if mode not in ('probe','full','verify-only'):raise RuntimeError('INVALID_TRANSFER_MODE')
    if mode!='probe' and request['plan'].get('verificationStrategy')!='destination-cpu-local':
        raise RuntimeError('DESTINATION_VERIFIER_COST_APPROVAL_REQUIRED')
    destination,workspace=client(request['credentials'])
    if workspace==SOURCE_WORKSPACE:raise RuntimeError('PRIMARY_STORAGE_IS_READ_ONLY')
    c,state=control(request);job=request['jobId'];key='dispatch:'+job
    if mode != 'probe':
        from host_account_transfer import dispatch as dispatch_accounts
        return dispatch_accounts(request,c,state,destination,workspace)
    existing=state.get(key)
    if existing:
        if existing.get('workspace')!=workspace or existing.get('volume')!=request['volume']:raise RuntimeError('TRANSFER_CLAIM_MISMATCH')
        if not existing.get('callId'):raise RuntimeError('TRANSFER_DISPATCH_UNCERTAIN_NO_RETRY')
        return {'call_id':existing['callId'],'worker_app_id':existing['appId'],'reused':True}
    if not state.put('active',job,skip_if_exists=True):raise RuntimeError('ONE_CLOUD_TRANSFER_ONLY')
    record={'jobId':job,'workspace':workspace,'volume':request['volume'],'fingerprint':FINGERPRINT,
            'files':[f['name'] for f in request['plan']['files']],'mode':mode, 'appId':state.get('deployment')['appId']}
    # Durable reservation precedes spawn. An ambiguous spawn is never automatically retried.
    if not state.put(key,record,skip_if_exists=True):raise RuntimeError('TRANSFER_DISPATCH_UNCERTAIN_NO_RETRY')
    if mode!='probe':
        from destination_verifier_control import ensure_destination_verifier
        from modal_bridge import emit
        emit('event',{'kind':'phase_start','phase':'destination_verifier_setup'})
        record['verifier']=ensure_destination_verifier(destination,request['volume'],create_volume=mode!='verify-only')
        state.put(key,record)
        emit('event',{'kind':'phase_end','phase':'destination_verifier_setup'})
    if state.get('cancel:'+job,False):
        record['cancelledBeforeSpawn']=True;state.put(key,record)
        return {'worker_app_id':record['appId'],'cancelled_before_spawn':True}
    secret=modal.Secret.from_dict({'IFF_DEST_TOKEN_ID':request['credentials']['tokenId'],'IFF_DEST_TOKEN_SECRET':request['credentials']['tokenSecret']})
    timeout=120 if mode=='probe' else 1200 if mode=='verify-only' else TIMEOUT
    fn=modal.Function.from_name(APP_NAME,FUNCTION_NAME,client=c,environment_name='main').with_options(secrets=[secret],retries=0,max_containers=1,buffer_containers=0,scaledown_window=2,timeout=timeout)
    call=fn.spawn({'jobId':job,'paidApproved':True,'fingerprint':FINGERPRINT,'destinationWorkspace':workspace,'volume':request['volume'],'files':record['files'],'mode':record['mode']})
    record['callId']=call.object_id;state.put(key,record)
    return {'call_id':call.object_id,'worker_app_id':record['appId'],'reused':False}


async def containers(credentials,app_id):
    from modal.client import _Client
    from modal_proto import api_pb2
    c=await _Client.from_env() if credentials.get('mode')=='local_profile' else await _Client.from_credentials(credentials['tokenId'],credentials['tokenSecret'])
    # Isolated SDK1.6.2 compatibility boundary; never stop the shared worker App.
    result=await c._stub.TaskList(api_pb2.TaskListRequest(environment_name='main',app_id=app_id))
    return len(result.tasks)


async def app_is_stopped(credentials,app_id):
    from modal.client import _Client
    from modal_proto import api_pb2
    c=await _Client.from_credentials(credentials['tokenId'],credentials['tokenSecret'])
    info=await c._stub.AppGetInfo(api_pb2.AppGetInfoRequest(app_id=app_id))
    return info.info.lifecycle.app_state==api_pb2.APP_STATE_STOPPED


def status(request,cancel=False):
    c,state=control(request);job=request['jobId'];record=state.get('dispatch:'+job)
    if not record or record.get('jobId')!=job or record.get('volume')!=request['volume'] or record.get('workspace')!=request.get('destinationWorkspace'):
        return {'cloud_stopped':False,'state':'dispatch_unknown','events':[]}
    if record.get('hostOrchestrated'):
        from host_account_transfer import status as account_status
        return account_status(request,record,c,state,cancel=cancel)
    if cancel:state.put('cancel:'+job,True)
    if not record.get('callId') and not record.get('cancelledBeforeSpawn'):
        return {'cloud_stopped':False,'state':'dispatch_unknown','events':[]}
    call=modal.FunctionCall.from_id(record['callId'],client=c) if record.get('callId') else None
    if cancel:
        if call:
            try:call.cancel(terminate_containers=True)
            except Exception:pass  # Still inspect/cancel destination calls below.
    progress=state.get('progress:'+job,{})
    result=None;terminal=False;failure=None
    try:
        result=call.get(timeout=0) if call else {'ready':False,'status':'failed','error':'TRANSFER_CANCELLED'};terminal=True
    except (modal.exception.InputCancellation,modal.exception.FunctionTimeoutError) as error:
        terminal=True;failure='TRANSFER_CANCELLED' if isinstance(error,modal.exception.InputCancellation) else 'TRANSFER_TIMEOUT'
    except RuntimeError as error:
        if str(error) in {'TRANSFER_APPROVAL_REQUIRED','INVALID_TRANSFER_DESTINATION','WORKER_VERSION_CHANGED','TRANSFER_CLAIM_MISMATCH','DUPLICATE_TRANSFER_NO_RETRY'}:
            terminal=True;failure=str(error)
    except Exception:pass  # Network/expired outputs are unknown, never evidence of termination.
    count=None
    if terminal:
        from modal._utils.async_utils import synchronize_api
        try:count=synchronize_api(containers)(request['source'],record['appId'])
        except Exception:pass
    # Child CPU calls belong to the destination workspace and must be accounted
    # for separately. A zero count in the primary workspace is insufficient.
    record=state.get('dispatch:'+job)
    child_count=0;children_terminal=True;children=[]
    if record.get('verifier'):
        child_count=None;children_terminal=False
        try:
            from modal_bridge import client
            dc,destination_workspace=client(request['credentials'])
            if destination_workspace!=record['workspace']:raise RuntimeError('TRANSFER_CLAIM_MISMATCH')
            _,state_name=verifier_names(record['volume'])
            ds=modal.Dict.from_name(state_name,client=dc,create_if_missing=False,environment_name='main')
            cleanup=cancel or bool(failure) or (terminal and (result or {}).get('status') in ('failed','needs_review'))
            if cleanup:ds.put('cancel:'+job,True)
            children_terminal=True
            children=[child for phase in ('before','after') if (child:=state.get('child:'+job+':'+phase))]
            for child in children:
                cid=child.get('callId') or ds.get('execution:'+job+':'+child['phase'])
                if not cid:
                    # An operator may stop this dedicated destination App to
                    # cancel an ambiguously accepted child. Its STOPPED lifecycle
                    # plus the zero-task check below prevents a queued late start.
                    from modal._utils.async_utils import synchronize_api
                    if not synchronize_api(app_is_stopped)(request['credentials'],record['verifier']['appId']):
                        children_terminal=False
                    continue
                child_call=modal.FunctionCall.from_id(cid,client=dc)
                if cleanup:child_call.cancel(terminate_containers=True)
                try:
                    child_call.get(timeout=0)
                    child.setdefault('finishedAt',time.time())
                except (modal.exception.InputCancellation,modal.exception.FunctionTimeoutError):child.setdefault('finishedAt',time.time())
                except Exception:children_terminal=False
                if cid:
                    child['callId']=cid
                    state.put('child:'+job+':'+child['phase'],child)
            from modal._utils.async_utils import synchronize_api
            child_count=synchronize_api(containers)(request['credentials'],record['verifier']['appId'])
        except Exception:pass
    stopped=terminal and count==0 and children_terminal and child_count==0
    if stopped and state.get('active')==job:state.pop('active',None)
    total_count=count+child_count if count is not None and child_count is not None else None
    return {'cloud_stopped':stopped,'callFinished':terminal,'running_containers':total_count,'tasks':total_count,
            'source_containers':count,'destination_containers':child_count,
            'call_id':record.get('callId'),'worker_app_id':record['appId'],'events':progress.get('events',[]),
            'verifiedFiles':(result or {}).get('verifiedFiles',progress.get('verifiedFiles',[])),'result':result,'error':failure,'recordedCost':None,
            'destinationComputeSeconds':sum(max(0,(ch.get('finishedAt') or time.time())-ch['startedAt']) for ch in children if ch.get('startedAt')),
            'state':'finished' if stopped else 'running' if not terminal else 'awaiting_scaledown'}


def run(request):
    from modal_bridge import emit
    action=request['action']
    if action=='cloud_transfer_preflight':return preflight(request)
    if action=='cloud_transfer_dispatch':return dispatch(request)
    if action in ('cloud_transfer_status','cloud_transfer_stop'):return status(request,action.endswith('_stop'))
    raise RuntimeError('UNSUPPORTED_CLOUD_TRANSFER_ACTION')
