"""CPU-only contracts and tiny in-memory Volume fixtures. No cloud calls."""
import hashlib
import importlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch,AsyncMock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'engine'))
sys.path.insert(0,str(ROOT/'engine/runtime'))
import modal_bridge as bridge


class RuntimeTests(unittest.TestCase):
    def test_model_plan_constructs_without_torch_or_network(self):
        from engine import StoryEngine
        for gpu in ('L40S','RTX-PRO-6000'):
            engine=StoryEngine(story='horror',gpu=gpu,window=10)
            self.assertEqual(engine.plan['frames'],241)
            self.assertEqual(len(engine.instructions),1)
            self.assertIsNone(engine.pipeline)
        self.assertNotIn('torch',sys.modules)

    def test_modal_class_graph_is_valid_without_build_or_remote_call(self):
        import modal
        from gpu_service import FilmEngine
        app=modal.App('local-graph-validation-only')
        cls=app.cls(image=modal.Image.debian_slim(),gpu='RTX-PRO-6000',cpu=(4,4),memory=(65536,131072),
                    timeout=600,startup_timeout=180,retries=0,max_containers=1,min_containers=0,
                    buffer_containers=0,scaledown_window=2)(FilmEngine)
        self.assertIsNotNone(cls)
        self.assertIsNone(app.app_id)

    def test_no_implicit_cloud_approval(self):
        from gpu_host import run
        with self.assertRaisesRegex(RuntimeError,'approval'):
            run({'paidApproved':False})

    def test_native_image_conditioning_is_wired_and_original_audio_preserved(self):
        code=(ROOT/'engine/runtime/engine.py').read_text()
        self.assertIn('ImageConditioningInput.at(self.image_path,0,1.0)',code)
        self.assertIn('frame_rate=cfg.FPS,images=conditioning',code)
        self.assertIn("raise RuntimeError('Native audio stream missing')",code)
        host=(ROOT/'engine/gpu_host.py').read_text()
        self.assertIn('with_mount_options(read_only=True)',host)
        self.assertIn('min_containers=0',host)
        self.assertNotIn('ephemeral_disk=',host)

    def test_transfer_repairs_same_size_corruption_and_skips_valid_files(self):
        payload={f'weights/f{i}.bin':bytes([i])*4 for i in range(5)}
        files={name:{'size':len(content),'sha256':hashlib.sha256(content).hexdigest()} for name,content in payload.items()}
        source={bridge.PREFIX+'/'+n:b for n,b in payload.items()}
        dest=dict(source);dest[bridge.PREFIX+'/weights/f0.bin']=b'xxxx'
        reads=[];uploads=[];created=[]
        class Volume:
            def __init__(self,name):self.name=name;self.data=source if name=='source' else dest
            def hydrate(self):return self
            def read_file(self,path):reads.append((self.name,path));yield self.data[path]
            def batch_upload(self,force=False):return Batch(self)
        class Batch:
            def __init__(self,volume):self.volume=volume
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def put_file(self,file,remote):
                content=Path(file).read_bytes() if not hasattr(file,'read') else file.read()
                self.volume.data[remote]=content;uploads.append(remote)
        def from_name(name,**kwargs):created.append((name,kwargs.get('create_if_missing')));return Volume(name)
        def discovery(_):return {'ready':bridge.PREFIX+'/READY.json' in dest,'files':[{'name':n,'size':len(dest[bridge.PREFIX+'/'+n]),'manifestMatch':True} for n in files]}
        fake=SimpleNamespace(Volume=SimpleNamespace(from_name=from_name))
        with tempfile.TemporaryDirectory() as folder,patch.dict(sys.modules,{'modal':fake}),patch.object(bridge,'client',lambda creds:(object(),creds['workspace'])),patch.object(bridge,'discover',discovery),patch.object(bridge,'MANIFEST',{'model_revision':'test','source_commit':'local-test-source','files':files}),patch.object(bridge,'emit'),patch.object(bridge.shutil,'disk_usage',lambda _:SimpleNamespace(free=10*2**30)):
            request={'paidApproved':True,'credentials':{'workspace':'backup'},'source':{'workspace':'primary'},'sourceVolume':'source','volume':'backup','artifactDir':folder,'plan':{'source':'volume','files':[]}}
            review=bridge.transfer(request)
            self.assertTrue(review['requiresNewPlan']);self.assertEqual(uploads,[])
            request['plan']['files']=[{'name':'weights/f0.bin'}]
            result=bridge.transfer(request)
        self.assertEqual(result['transferredBytes'],4)
        self.assertEqual([r for r in reads if r[0]=='source'],[('source',bridge.PREFIX+'/weights/f0.bin')])
        self.assertEqual(uploads,[bridge.PREFIX+'/weights/f0.bin',bridge.PREFIX+'/RUNTIME.json',bridge.PREFIX+'/READY.json'])
        self.assertTrue(result['ready'])
        self.assertEqual(dest[bridge.PREFIX+'/weights/f0.bin'],payload['weights/f0.bin'])

    def test_transfer_never_writes_primary_or_runs_without_approval(self):
        import modal
        with self.assertRaisesRegex(RuntimeError,'Approval'):
            bridge.transfer({'paidApproved':False})
        with patch.object(bridge,'client',lambda _:(object(),'basm1998ali')),patch.object(modal.Volume,'from_name') as create:
            with self.assertRaisesRegex(RuntimeError,'read-only'):
                bridge.transfer({'paidApproved':True,'credentials':{},'plan':{'files':[]}})
            create.assert_not_called()

    def test_official_preflight_is_metadata_only(self):
        calls=[]
        def download(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(file_size=bridge.MANIFEST['files'][kwargs['filename']]['size'])
        fake=SimpleNamespace(hf_hub_download=download)
        with tempfile.TemporaryDirectory() as folder,patch.dict(sys.modules,{'huggingface_hub':fake}):
            result=bridge.official_model_info({'cacheDir':folder,'hfCredentials':{'HF_TOKEN':'hf_fixture_only'}})
            self.assertTrue(all(call['dry_run'] is True for call in calls))
            self.assertEqual(len(list(Path(folder).rglob('*.safetensors'))),0)
        self.assertEqual(len(calls),5)
        self.assertFalse(result['modelDownloaded'])
        self.assertNotIn('hf_fixture_only',json.dumps(result))

    def test_derived_frame_failure_does_not_discard_mp4(self):
        import gpu_service
        with tempfile.TemporaryDirectory() as folder:
            video=Path(folder)/'video.mp4';video.write_bytes(b'local-test-fixture')
            with patch.object(gpu_service.subprocess,'run',side_effect=RuntimeError('fixture')):
                self.assertFalse(gpu_service.extract_last_frame(video,Path(folder)/'frame.png'))
            self.assertEqual(video.read_bytes(),b'local-test-fixture')

    def test_stop_checks_ownership_even_when_app_is_not_in_list(self):
        import asyncio
        from modal.client import _Client
        from modal_proto import api_pb2 as api
        state={'value':api.APP_STATE_EPHEMERAL,'description':'iff-engine-owned-job'}
        async def info(_):return SimpleNamespace(info=SimpleNamespace(app_id='ap-owned',description=state['description'],environment_name='main',lifecycle=SimpleNamespace(app_state=state['value'])))
        async def stop(_):state['value']=api.APP_STATE_STOPPED
        stub=SimpleNamespace(AppGetInfo=AsyncMock(side_effect=info),TaskList=AsyncMock(return_value=SimpleNamespace(tasks=[])),AppStop=AsyncMock(side_effect=stop))
        c=SimpleNamespace(_stub=stub)
        with patch.object(_Client,'from_credentials',AsyncMock(return_value=c)):
            result=asyncio.run(bridge.metadata({'tokenId':'fixture','tokenSecret':'fixture'},'ap-owned','owned-job',True,False))
            self.assertTrue(result['cloud_stopped']);self.assertEqual(result['tasks'],0);self.assertEqual(stub.AppStop.await_count,1)
            state['description']='unrelated-primary-application'
            with self.assertRaisesRegex(RuntimeError,'unowned'):
                asyncio.run(bridge.metadata({'tokenId':'fixture','tokenSecret':'fixture'},'ap-owned','owned-job',True,False))
            self.assertEqual(stub.AppStop.await_count,1)


if __name__=='__main__':unittest.main()
