"""Offline account-boundary, restart and billing-duplication regressions."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'engine'))
from test_cloud_transfer import State
from transfer_orchestrator import advance
from host_account_transfer import require_external_control


class Adapter:
    def __init__(self):
        self.calls=[]; self.completed={}; self.cancelled=[]; self.pools=(0,0); self.markers=0
    def submit(self, stage):
        self.calls.append(stage)
        return {'callId':'fc-'+stage}
    def observe(self, stage, slot, cancel=False):
        if cancel: self.cancelled.append(stage)
        return {'terminal':stage in self.completed, 'result':self.completed.get(stage),
                'events':[{'sequence':1,'phase':stage}]}
    def window(self, stage): return 20
    def counts(self): return self.pools
    def verification_result(self, receipt):
        return {'verificationOnly':True,'ready':False,'status':'completed','verifiedFiles':['existing']}
    def finalize(self, receipt):
        self.markers+=1
        return {'ready':True,'status':'completed'}


class HostOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.state=State(); self.state.put('active','job')
        self.adapter=Adapter(); self.record={'mode':'full'}
    def tick(self, **kw):
        return advance(self.state,'job',self.record,self.adapter,**kw)
    def test_full_sequence_resumes_without_repeating_any_stage(self):
        self.tick(); self.tick()
        self.assertEqual(self.adapter.calls,['before'])
        self.adapter.completed['before']={'files':['existing']}
        self.tick(); self.tick()
        self.assertEqual(self.adapter.calls,['before','copy'])
        self.adapter.completed['copy']={'status':'awaiting_verification','transferredBytes':17}
        self.tick()
        self.assertEqual(self.adapter.calls,['before','copy','after'])
        self.assertEqual(self.adapter.markers,0)
        self.adapter.completed['after']={'files':['all-valid']}
        self.assertTrue(self.tick()['result']['ready'])
        self.assertTrue(self.tick()['cloud_stopped'])
        self.assertEqual(self.adapter.markers,1)
        self.assertIsNone(self.state.get('active'))
    def test_verify_only_does_not_start_source_copy_or_write_marker(self):
        self.record['mode']='verify-only'
        self.adapter.completed['before']={}
        result=self.tick()
        self.assertTrue(result['cloud_stopped']); self.assertFalse(result['result']['ready'])
        self.assertEqual(self.adapter.calls,['before']); self.assertEqual(self.adapter.markers,0)
    def test_lost_dispatch_ack_is_never_repeated_and_not_declared_stopped(self):
        def lost(stage): self.adapter.calls.append(stage); raise ConnectionError('synthetic')
        self.adapter.submit=lost
        self.assertFalse(self.tick()['cloud_stopped'])
        self.assertEqual(self.tick()['state'],'dispatch_unknown')
        self.assertFalse(self.tick(cancel=True)['cloud_stopped'])
        self.assertEqual(self.adapter.calls,['before'])
    def test_parallel_poll_observes_reservation_and_cannot_advance_or_resubmit(self):
        self.state.put('orchestrator:job:before',{'reservedAt':1})
        self.assertEqual(self.tick()['state'],'dispatch_unknown')
        self.assertEqual(self.adapter.calls,[])
    def test_failure_before_copy_preserves_weights_and_skips_later_calls(self):
        self.adapter.completed['before']={'error':'VERIFY_FAILED'}
        result=self.tick()
        self.assertFalse(result['result']['ready']); self.assertEqual(self.adapter.calls,['before'])
        self.assertEqual(self.adapter.markers,0)
    def test_cancel_prevents_future_stages_and_waits_for_remote_confirmation(self):
        self.tick()
        self.assertFalse(self.tick(cancel=True)['cloud_stopped'])
        self.assertEqual(self.adapter.cancelled,['before'])
        self.adapter.completed['before']={'error':'TRANSFER_CANCELLED'}
        self.assertTrue(self.tick()['cloud_stopped'])
        self.assertEqual(self.adapter.calls,['before'])
    def test_zero_source_containers_does_not_hide_destination_container(self):
        self.record['mode']='verify-only'; self.adapter.completed['before']={}
        self.adapter.pools=(0,1)
        self.assertFalse(self.tick()['cloud_stopped'])
        self.assertEqual(self.state.get('active'),'job')
        self.adapter.pools=(0,0)
        self.assertTrue(self.tick()['cloud_stopped'])
    def test_timeout_stops_chain_without_another_call(self):
        self.tick(now=lambda:0)
        self.assertEqual(self.tick(now=lambda:21)['error'],'TRANSFER_TIMEOUT')
        self.tick(now=lambda:22)
        self.assertEqual(self.adapter.cancelled,['before'])
        self.assertEqual(self.adapter.calls,['before'])
    def test_marker_failure_is_terminal_without_automatic_finalization_retry(self):
        self.adapter.completed={s:{} for s in ('before','copy','after')}
        def fail(receipt): self.adapter.markers+=1; raise OSError('fixture')
        self.adapter.finalize=fail
        self.assertEqual(self.tick()['error'],'FINALIZATION_FAILED_NO_RETRY')
        self.tick()
        self.assertEqual(self.adapter.markers,1)
    def test_cloud_worker_cannot_become_multi_account_orchestrator(self):
        with patch('modal.is_local',return_value=False):
            with self.assertRaisesRegex(RuntimeError,'HOST_CONTROL_PLANE_REQUIRED'):
                require_external_control()
    def test_import_does_not_contact_cloud(self):
        import importlib
        with patch('modal.Client.from_env',side_effect=AssertionError('No cloud')):
            importlib.reload(__import__('host_account_transfer'))

    def test_successful_status_poll_does_not_cancel_completed_calls(self):
        self.adapter.completed={s:{} for s in ('before','copy','after')}
        self.assertTrue(self.tick()['cloud_stopped'])
        self.tick()
        self.assertEqual(self.adapter.cancelled,[])

    def test_invalid_verify_only_receipt_finishes_failed_without_upload(self):
        self.record['mode']='verify-only';self.adapter.completed['before']={}
        def invalid(receipt):raise ValueError('scope mismatch fixture')
        self.adapter.verification_result=invalid
        result=self.tick()
        self.assertTrue(result['cloud_stopped'])
        self.assertEqual(result['error'],'DESTINATION_VERIFICATION_FAILED')
        self.assertEqual(self.adapter.calls,['before'])

    def test_official_clients_keep_verification_and_copy_in_their_own_accounts(self):
        from types import SimpleNamespace
        import modal
        from host_account_transfer import AccountTransfer
        from transfer_contract import MANIFEST,FINGERPRINT
        source_client=object();destination_client=object();dest=State();seen=[];requests=[]
        dest.put('deployment',{'appId':'ap-destination','fingerprint':FINGERPRINT})
        before={'revision':MANIFEST['model_revision'],'files':[
            {'name':name,'valid':False,'reason':'MISSING'} for name in MANIFEST['files']]}
        self.state.put('orchestrator:job:receipt:before',before)
        record={'workspace':'backup-fixture','files':list(MANIFEST['files']),'appId':'ap-source'}
        request={'jobId':'job','volume':'iff-ltx25-12345678',
                 'credentials':{'tokenId':'fixture-id','tokenSecret':'fixture-secret'}}
        fn=SimpleNamespace(with_options=lambda **kw:fn,
                           spawn=lambda req:(requests.append(req) or SimpleNamespace(object_id='fc-fixture')))
        def lookup(app,name,**kw):seen.append((name,kw['client']));return fn
        with patch.object(modal.Dict,'from_name',return_value=dest),patch.object(modal.Function,'from_name',side_effect=lookup),patch.object(modal.Secret,'from_dict',return_value=object()):
            adapter=AccountTransfer(request,record,source_client,self.state,destination_client)
            adapter.submit('before');adapter.submit('copy');adapter.submit('after')
        self.assertEqual(seen,[('verify_models',destination_client),('copy_models',source_client),('verify_models',destination_client)])
        self.assertNotIn('fixture-secret',str(requests));self.assertNotIn('tokenSecret',str(self.state.data))
        self.assertTrue(requests[1]['hostOrchestrated'])


if __name__=='__main__':unittest.main()
