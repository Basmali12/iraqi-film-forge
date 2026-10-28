"""Offline contract tests; no clients, cloud mutations or real credentials."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from test_cloud_transfer import State
import cloud_transfer_host as host
import modal_bridge as bridge
import destination_verifier_control as destination


class DestinationControlTests(unittest.TestCase):
    def setUp(self):
        self.source = State(); self.dest = State(); self.job = 'fixture-job'
        self.request = {'jobId':self.job, 'volume':'iff-ltx25-12345678',
            'source':{'scope':'source'}, 'credentials':{'scope':'destination'},
            'destinationWorkspace':'backup-fixture'}
        self.source.put('active', self.job)
        self.source.put('dispatch:'+self.job, {'jobId':self.job, 'volume':self.request['volume'],
            'workspace':'backup-fixture', 'callId':'fc-parent', 'appId':'ap-parent',
            'verifier':{'appId':'ap-child'}})
        self.source.put('child:'+self.job+':before', {'phase':'before','appId':'ap-child','callId':'fc-child'})

    def test_primary_zero_cannot_hide_a_running_destination_container(self):
        counts = {'source':0, 'destination':1}
        async def containers(credentials, app): return counts[credentials['scope']]
        parent = SimpleNamespace(get=lambda **kw:{'ready':True})
        child = SimpleNamespace(get=lambda **kw:(_ for _ in ()).throw(TimeoutError()))
        with patch.object(host,'control',return_value=(None,self.source)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Dict,'from_name',return_value=self.dest),patch.object(host.modal.FunctionCall,'from_id',side_effect=lambda cid,**kw:parent if cid=='fc-parent' else child),patch.object(host,'containers',new=containers):
            result = host.status(self.request)
            self.assertFalse(result['cloud_stopped']); self.assertEqual(result['running_containers'],1)
            self.assertEqual(self.source.get('active'),self.job)
            counts['destination']=0; child.get=lambda **kw:{}
            self.assertTrue(host.status(self.request)['cloud_stopped'])
        self.assertIsNone(self.source.get('active'))

    def test_cancel_recovers_lost_child_receipt_and_cancels_both_scoped_calls(self):
        self.source.data['child:'+self.job+':before']['callId']=None
        self.dest.put('execution:'+self.job+':before','fc-child')
        cancelled=[]
        def make(cid):
            return SimpleNamespace(get=lambda **kw:{'status':'failed'},cancel=lambda **kw:cancelled.append(cid))
        async def zero(*args): return 0
        with patch.object(host,'control',return_value=(None,self.source)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Dict,'from_name',return_value=self.dest),patch.object(host.modal.FunctionCall,'from_id',side_effect=lambda cid,**kw:make(cid)),patch.object(host,'containers',new=zero):
            result=host.status(self.request,cancel=True)
        self.assertTrue(result['cloud_stopped'])
        self.assertEqual(cancelled,['fc-parent','fc-child'])
        self.assertTrue(self.dest.get('cancel:'+self.job)); self.assertTrue(self.source.get('cancel:'+self.job))

    def test_unknown_child_call_cannot_be_claimed_stopped_even_when_both_pools_zero(self):
        self.source.data['child:'+self.job+':before']['callId']=None
        async def zero(*args): return 0
        parent=SimpleNamespace(get=lambda **kw:{'ready':True})
        async def active(*args):return False
        with patch.object(host,'control',return_value=(None,self.source)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Dict,'from_name',return_value=self.dest),patch.object(host.modal.FunctionCall,'from_id',return_value=parent),patch.object(host,'containers',new=zero),patch.object(host,'app_is_stopped',new=active):
            self.assertFalse(host.status(self.request)['cloud_stopped'])

    def test_stopped_dedicated_destination_app_and_zero_tasks_resolve_unknown_child_safely(self):
        self.source.data['child:'+self.job+':before']['callId']=None
        async def zero(*args):return 0
        async def stopped(*args):return True
        parent=SimpleNamespace(get=lambda **kw:{'status':'failed','error':'CLOUD_TRANSFER_FAILED'})
        with patch.object(host,'control',return_value=(None,self.source)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Dict,'from_name',return_value=self.dest),patch.object(host.modal.FunctionCall,'from_id',return_value=parent),patch.object(host,'containers',new=zero),patch.object(host,'app_is_stopped',new=stopped):
            self.assertTrue(host.status(self.request)['cloud_stopped'])

    def test_duplicate_child_reservation_never_spawns_a_second_verification(self):
        self.dest.put('deployment',{'fingerprint':host.FINGERPRINT,'appId':'ap-child'})
        self.dest.put('claim:'+self.job+':before',{'fingerprint':host.FINGERPRINT})
        with patch.object(destination.modal.Dict,'from_name',return_value=self.dest),patch.object(destination.modal.Function,'from_name',side_effect=AssertionError('No second spawn')):
            with self.assertRaisesRegex(RuntimeError,'DUPLICATE_VERIFICATION_NO_RETRY'):
                destination.verify_destination(None,self.source,self.job,self.request['volume'],'before',lambda **e:None,lambda:None)

    def test_paid_verification_dispatch_deploys_once_without_copy_or_gpu_fallback(self):
        state=State();state.put('deployment',{'appId':'ap-parent'})
        calls=[]
        call=SimpleNamespace(object_id='fc-child',get=lambda **kw:(_ for _ in ()).throw(TimeoutError()))
        fn=SimpleNamespace(spawn=lambda req:(calls.append(req) or call))
        dest=State();dest.put('deployment',{'fingerprint':host.FINGERPRINT,'appId':'ap-child'})
        async def zero(*args):return 0
        request={'paidApproved':True,'jobId':self.job,'credentials':{},'source':{},'volume':self.request['volume'],
            'plan':{'mode':'verify-only','workerFingerprint':host.FINGERPRINT,'verificationStrategy':'destination-cpu-local','files':[]}}
        with patch.object(host,'preflight',return_value={'workerReady':True}),patch.object(host,'control',return_value=(None,state)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(destination,'ensure_destination_verifier',return_value={'appId':'ap-child'}) as deploy,patch.object(host.modal.Secret,'from_dict',side_effect=AssertionError('No source credentials injection')),patch.object(host.modal.Dict,'from_name',return_value=dest),patch.object(host.modal.Function,'from_name',return_value=fn),patch.object(host.modal.FunctionCall,'from_id',return_value=call),patch.object(host,'containers',new=zero):
            # Synthetic placeholders only, not real tokens.
            request['credentials']={'tokenId':'fixture','tokenSecret':'fixture'}
            host.dispatch(request);host.dispatch(request)
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['phase'],'before')
        self.assertNotIn('mode',calls[0]);self.assertEqual(deploy.call_count,1)
        self.assertFalse(deploy.call_args.kwargs['create_volume'])
        self.assertNotIn('tokenSecret',str(calls));self.assertNotIn('credentials',str(state.data))

    def test_cancellation_during_deployment_prevents_parent_spawn(self):
        state=State();state.put('deployment',{'appId':'ap-parent'})
        def deployed(*args,**kw):state.put('cancel:'+self.job,True);return {'appId':'ap-child'}
        request={'paidApproved':True,'jobId':self.job,'credentials':{},'source':{},'volume':self.request['volume'],
            'plan':{'mode':'full','workerFingerprint':host.FINGERPRINT,'verificationStrategy':'destination-cpu-local','files':[]}}
        with patch.object(host,'preflight',return_value={'workerReady':True}),patch.object(host,'control',return_value=(None,state)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(destination,'ensure_destination_verifier',side_effect=deployed),patch.object(host.modal.Function,'from_name',side_effect=AssertionError('Must not spawn')):
            self.assertTrue(host.dispatch(request)['cancelled_before_spawn'])

    def test_ambiguous_child_spawn_is_reserved_and_never_resubmitted(self):
        self.dest.put('deployment',{'fingerprint':host.FINGERPRINT,'appId':'ap-child'})
        attempts=[]
        def lost(request):attempts.append(request);raise ConnectionError('lost response fixture')
        fn=SimpleNamespace(spawn=lost)
        with patch.object(destination.modal.Dict,'from_name',return_value=self.dest),patch.object(destination.modal.Function,'from_name',return_value=fn):
            with self.assertRaises(ConnectionError):destination.verify_destination(None,self.source,self.job,self.request['volume'],'before',lambda **e:None,lambda:None)
            with self.assertRaisesRegex(RuntimeError,'DUPLICATE_VERIFICATION_NO_RETRY'):destination.verify_destination(None,self.source,self.job,self.request['volume'],'before',lambda **e:None,lambda:None)
        self.assertEqual(len(attempts),1)
        self.assertEqual(self.source.get('child:'+self.job+':before')['dispatchErrorClass'],'ConnectionError')

    def test_destination_dispatch_cannot_inherit_source_workspace_input_context(self):
        import modal
        from modal._runtime.execution_context import _set_current_context_ids
        self.dest.put('deployment',{'fingerprint':host.FINGERPRINT,'appId':'ap-child'})
        seen=[]
        async def spawn(request):
            seen.append((modal.current_input_id(),modal.current_function_call_id()))
            return SimpleNamespace(object_id='fc-child',get=lambda **kw:{'jobId':self.job,'phase':'before','fingerprint':host.FINGERPRINT})
        reset=_set_current_context_ids(['in-source-fixture'],['fc-source-fixture'],['attempt-source-fixture'])
        try:
            with patch.object(destination.modal.Dict,'from_name',return_value=self.dest),patch.object(destination.modal.Function,'from_name',return_value=SimpleNamespace(spawn=__import__('modal._utils.async_utils',fromlist=['synchronize_api']).synchronize_api(spawn))):
                destination.verify_destination(None,self.source,self.job,self.request['volume'],'before',lambda **e:None,lambda:None)
            self.assertEqual(seen,[(None,None)])
            self.assertEqual(modal.current_input_id(),'in-source-fixture')
        finally:reset()

    def test_destination_factory_import_and_definition_have_no_network_or_gpu(self):
        import modal
        from destination_verifier_app import create_verifier_app
        with patch.object(modal.Client,'from_env',side_effect=AssertionError('No cloud')):
            app,fn,state=create_verifier_app('iff-ltx25-12345678',create_volume=False)
            self.assertIsNone(app.app_id); self.assertIsInstance(fn,modal.Function)
            # A global source function avoids unhydrated closure handles and
            # cross-version Python bytecode serialization at deployment.
            self.assertIsNone(fn._get_source_info().raw_f.__closure__)
            self.assertEqual(fn._get_source_info().raw_f.__module__,'destination_verifier_app')
        text=(Path(__file__).resolve().parents[1]/'engine/destination_verifier_app.py').read_text(encoding='utf-8')
        self.assertIn('read_only=True',text);self.assertNotIn('gpu=',text)
        self.assertNotIn('TOKEN_SECRET',text);self.assertIn('min_containers=0',text)

if __name__ == '__main__': unittest.main()
