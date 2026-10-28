"""Tiny isolated byte fixtures only. No real accounts, network, builds or cloud calls."""
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'engine'))
from cloud_transfer_core import copy_weights


class Target:
    def __init__(self,files=None):self.files=dict(files or {});self.uploads=[];self.creations=0
    def exists(self,name):return name in self.files
    def ensure(self):self.creations+=1
    def read(self,name):yield self.files[name]
    def upload(self,name,path):self.files[name]=Path(path).read_bytes();self.uploads.append(name)
    def upload_bytes(self,name,content):self.files[name]=content;self.uploads.append(name)


class State:
    def __init__(self):self.data={}
    def get(self,key,default=None):return self.data.get(key,default)
    def put(self,key,value,skip_if_exists=False):
        if skip_if_exists and key in self.data:return False
        self.data[key]=value;return True
    def pop(self,key,default=None):return self.data.pop(key,default)


class CloudTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.source=Path(self.temp.name)
        self.contents={f'weights/file{i}.bin':bytes([i])*11 for i in range(5)}
        for name,data in self.contents.items():
            p=self.source/name;p.parent.mkdir(exist_ok=True);p.write_bytes(data)
        self.manifest={'model_revision':'fixture','source_commit':'fixture','files':{n:{'size':len(d),'sha256':hashlib.sha256(d).hexdigest()} for n,d in self.contents.items()}}

    def test_missing_only_and_existing_hash_verification(self):
        existing={next(iter(self.contents)):next(iter(self.contents.values()))};target=Target(existing);events=[]
        result=copy_weights(self.manifest,self.source,target,set(self.contents)-set(existing),lambda **e:events.append(e))
        self.assertTrue(result['ready']);self.assertFalse(result['gpuUsed']);self.assertEqual(result['transferredBytes'],44)
        self.assertNotIn(next(iter(existing)),target.uploads);self.assertEqual(target.files['weights/file4.bin'],self.contents['weights/file4.bin'])
        self.assertTrue(json.loads(target.files['READY.json'])['hashVerified'])
        self.assertEqual(sum(e['kind']=='file_verified' for e in events),5)
        self.assertEqual({p.relative_to(self.source).as_posix() for p in self.source.rglob('*') if p.is_file()},set(self.contents))

    def test_unexpected_corruption_requires_new_approval_before_any_write(self):
        target=Target(self.contents);target.files['weights/file2.bin']=b'x'*11
        result=copy_weights(self.manifest,self.source,target,[])
        self.assertTrue(result['requiresNewPlan']);self.assertEqual(result['corruptFiles'],['weights/file2.bin'])
        self.assertEqual(target.creations,0);self.assertEqual(target.uploads,[])

    def test_source_corruption_or_cancel_never_creates_ready_marker(self):
        (self.source/'weights/file0.bin').write_bytes(b'bad');target=Target()
        with self.assertRaisesRegex(ValueError,'SOURCE_SHA256'):copy_weights(self.manifest,self.source,target,self.contents)
        self.assertEqual(target.creations,0);self.assertNotIn('READY.json',target.files)
        def stop():raise RuntimeError('TRANSFER_CANCELLED')
        with self.assertRaisesRegex(RuntimeError,'CANCELLED'):copy_weights(self.manifest,self.source,Target(),self.contents,check=stop)

    def test_month_change_does_not_reupload_complete_weights(self):
        target=Target(self.contents)
        result=copy_weights(self.manifest,self.source,target,[])
        self.assertEqual(result['transferredBytes'],0);self.assertTrue(result['ready'])
        self.assertEqual(target.uploads,['RUNTIME.json','READY.json'])

    def test_probe_copies_only_a_prefix_and_never_creates_a_ready_marker(self):
        from cloud_transfer_core import copy_probe
        target=Target();result=copy_probe(self.source,target,'weights/file0.bin','fixture-job',limit=4)
        self.assertTrue(result['probeVerified']);self.assertFalse(result['ready']);self.assertEqual(result['transferredBytes'],4)
        self.assertEqual(target.uploads,['_probe/fixture-job.bin']);self.assertNotIn('READY.json',target.files)

    def test_definition_graph_has_no_gpu_and_no_hydration_or_build(self):
        import modal
        with patch.dict(os.environ,{'IFF_DEFINE_TRANSFER_WORKER':'YES'}),patch.object(modal.Client,'from_env',side_effect=AssertionError('No cloud')):
            worker=importlib.import_module('transfer_worker')
            self.assertIsNone(worker.app.app_id);self.assertIsInstance(worker.copy_models,modal.Function)
        self.assertNotIn('torch',sys.modules)
        text=(ROOT/'engine/transfer_worker.py').read_text()
        self.assertIn('read_only=True',text);self.assertIn('min_containers=0',text);self.assertNotIn('gpu=',text)

    def test_dispatch_is_idempotent_and_never_stores_secrets_in_progress(self):
        import cloud_transfer_host as host
        import modal_bridge as bridge
        state=State();state.put('deployment',{'appId':'ap-fixture'})
        calls=[]
        fn=SimpleNamespace(with_options=lambda **kw:fn,spawn=lambda request:(calls.append(request) or SimpleNamespace(object_id='fc-fixture')))
        request={'paidApproved':True,'jobId':'fixture-job','credentials':{'tokenId':'ak-fixture','tokenSecret':'as-fixture'},'source':{},'volume':'iff-ltx25-12345678','plan':{'workerFingerprint':host.FINGERPRINT,'mode':'probe','files':[{'name':'fixture'}]}}
        with patch.object(host,'preflight',return_value={'workerReady':True}),patch.object(host,'control',return_value=(None,state)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Function,'from_name',return_value=fn),patch.object(host.modal.Secret,'from_dict',return_value=object()):
            one=host.dispatch(request);two=host.dispatch(request)
        self.assertEqual(one['call_id'],two['call_id']);self.assertEqual(len(calls),1)
        self.assertNotIn('as-fixture',json.dumps(state.data));self.assertNotIn('tokenSecret',json.dumps(calls))

    def test_lost_spawn_response_never_resubmits(self):
        import cloud_transfer_host as host
        import modal_bridge as bridge
        state=State();state.put('deployment',{'appId':'ap-fixture'});calls=[]
        def ambiguous(request):calls.append(request);raise ConnectionError('fixture connection lost')
        fn=SimpleNamespace(with_options=lambda **kw:fn,spawn=ambiguous)
        request={'paidApproved':True,'jobId':'fixture-job','credentials':{'tokenId':'ak-fixture','tokenSecret':'as-fixture'},'source':{},'volume':'iff-ltx25-12345678','plan':{'workerFingerprint':host.FINGERPRINT,'mode':'probe','files':[]}}
        with patch.object(host,'preflight',return_value={'workerReady':True}),patch.object(host,'control',return_value=(None,state)),patch.object(bridge,'client',return_value=(None,'backup-fixture')),patch.object(host.modal.Function,'from_name',return_value=fn),patch.object(host.modal.Secret,'from_dict',return_value=object()):
            with self.assertRaises(ConnectionError):host.dispatch(request)
            with self.assertRaisesRegex(RuntimeError,'UNCERTAIN_NO_RETRY'):host.dispatch(request)
        self.assertEqual(len(calls),1)

    def test_deploy_without_approval_exits_before_cloud_access(self):
        import deploy_transfer_worker as script
        import modal
        with patch.object(sys,'argv',['deploy_transfer_worker.py']),patch.object(modal.Client,'from_env',side_effect=AssertionError('No cloud')):
            with self.assertRaises(SystemExit):script.main()

    def test_approved_deploy_initializes_lazy_registry_without_running_a_function(self):
        import deploy_transfer_worker as script
        import modal
        from transfer_contract import SOURCE_WORKSPACE,FINGERPRINT
        state=State();deploys=[]
        app=SimpleNamespace(app_id='ap-fixture',deploy=lambda **kw:deploys.append(kw))
        workspace=SimpleNamespace(name=SOURCE_WORKSPACE,hydrate=lambda:None)
        fn=SimpleNamespace(object_id='fu-fixture',hydrate=lambda:None)
        def registry(*args,**kwargs):
            if not kwargs.get('create_if_missing'):raise modal.exception.NotFoundError('Lazy registry absent')
            return state
        with patch.object(sys,'argv',['deploy_transfer_worker.py','--approve-worker-deploy']),patch.dict(sys.modules,{'transfer_worker':SimpleNamespace(app=app)}),patch.dict(os.environ,{},clear=False),patch.object(modal.Client,'from_env',return_value=object()),patch.object(modal.Workspace,'from_context',return_value=workspace),patch.object(modal.Function,'from_name',return_value=fn),patch.object(modal.Dict,'from_name',side_effect=registry),patch('builtins.print'):
            script.main()
        self.assertEqual(len(deploys),1)
        self.assertEqual(state.get('deployment'),{'fingerprint':FINGERPRINT,'functionId':'fu-fixture','appId':'ap-fixture'})


if __name__=='__main__':unittest.main()
