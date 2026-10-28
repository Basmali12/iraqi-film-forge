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
    def test_continuation_uses_the_new_file_bytes_and_clears_stale_conditioning(self):
        from gpu_host import session_payload,conditioning_image
        from gpu_service import request_conditioning
        from engine import StoryEngine
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'last-frame.png';data=b'\x89PNG\r\n\x1a\n'+b'fixture'*8;p.write_bytes(data)
            payload=session_payload({'seed':42,'image':b'old','orientation':'portrait'},
                                    {'prompt':'The next event, not a recap','previousFrame':str(p)})
            self.assertEqual(payload['image'],data)
            self.assertIsNone(session_payload(payload,{'prompt':'An unrelated new scene'})['image'])
            one=request_conditioning(payload);two=request_conditioning(payload)
            try:
                self.assertNotEqual(one,two);self.assertEqual(Path(two).read_bytes(),data)
                fake=SimpleNamespace(prepared=True,rendering=False,image_path=one)
                StoryEngine.set_image(fake,two);self.assertEqual(fake.image_path,two)
                StoryEngine.set_image(fake,None);self.assertIsNone(fake.image_path)
                fake.rendering=True
                with self.assertRaises(RuntimeError):StoryEngine.set_image(fake,two)
            finally:Path(one).unlink();Path(two).unlink()
            p.write_text('not an image but a possible secret fixture')
            with self.assertRaises(RuntimeError):conditioning_image(p)

    def test_manual_controls_disable_budget_watchdog_but_map_to_valid_modal_timeouts(self):
        from gpu_host import runtime_limits,watchdog_limit
        settings={'gpu':'RTX-PRO-6000','cpu':4,'ramLimit':128,'timeout':0,'startup':0,'budget':0}
        self.assertEqual(runtime_limits(settings),(86400,86400))
        self.assertIsNone(watchdog_limit(settings,session=True))
        self.assertEqual(watchdog_limit(settings,session=False),172802)
        legacy={**settings,'timeout':600,'startup':180,'budget':3}
        self.assertEqual(runtime_limits(legacy),(600,180))
        self.assertGreater(watchdog_limit(legacy,session=True),0)
        self.assertEqual(watchdog_limit(legacy,session=False),782)

    def test_denoise_progress_counts_completed_calls_without_gpu_or_timer_estimates(self):
        from engine import MeasuredStage
        from telemetry import EventSink
        sink=EventSink()
        engine=SimpleNamespace(guard_memory=lambda:None,torch=SimpleNamespace(cuda=SimpleNamespace(synchronize=lambda:None)),
            events=sink,denoise_completed=8,denoise_total=11,instructions=[{'id':'one','event_ids':['scene']}])
        def stage(**kwargs):
            for _ in range(len(kwargs['sigmas'])-1):kwargs['denoiser']()
            return 'rendered'
        calls=[];wrapped=MeasuredStage(stage,'stage_2',engine,calls)
        self.assertEqual(wrapped(sigmas=[1,0.5,0.1,0],denoiser=lambda:None),'rendered')
        progress=[e for e in sink.events if e['kind']=='progress']
        self.assertEqual([e['global_completed'] for e in progress],[9,10,11])
        self.assertEqual([e['global_total'] for e in progress],[11,11,11])
        self.assertNotIn('torch',sys.modules)
    def test_orientation_changes_only_dimensions_without_model_or_quality_change(self):
        from gpu_service import render_dimensions
        from gpu_host import session_payload
        self.assertEqual(render_dimensions('portrait'),(768,1280))
        self.assertEqual(render_dimensions('landscape'),(1280,768))
        original={'prompt':None,'gpu':'RTX-PRO-6000','seed':42,'orientation':'portrait'}
        result=session_payload(original,{'prompt':'شخص يمشي في الصحرا','orientation':'landscape'})
        self.assertEqual(result['orientation'],'landscape');self.assertEqual(result['gpu'],'RTX-PRO-6000')
        self.assertEqual(original['orientation'],'portrait')
        with self.assertRaises(RuntimeError):render_dimensions('square')
    def test_twenty_minute_idle_window_resets_after_each_completed_render(self):
        from gpu_host import IdleWindow
        clock=[100.0];idle=IdleWindow(1200,lambda:clock[0])
        clock[0]=1299;self.assertFalse(idle.expired());self.assertEqual(idle.remaining(),1)
        # A completed render starts a fresh idle period rather than inheriting old time.
        clock[0]=1500;idle.reset();clock[0]=2699;self.assertFalse(idle.expired())
        clock[0]=2700;self.assertTrue(idle.expired())
    def test_ready_metadata_does_not_ship_dependency_specific_string_subclasses(self):
        from gpu_service import metadata_for_wire
        import pickle
        class DependencyVersion(str):pass
        original={'torch':DependencyVersion('2.9.1+cu128'),'capability':(12,0),'total_vram_bytes':96*2**30}
        # A local subclass cannot be pickled; normalized metadata has no such dependency.
        with self.assertRaises((AttributeError,TypeError)):pickle.dumps(original)
        result=metadata_for_wire(original)
        self.assertIs(type(result['torch']),str)
        self.assertEqual(pickle.loads(pickle.dumps(result))['torch'],'2.9.1+cu128')
        self.assertEqual(result['capability'],[12,0])
        self.assertNotIn('torch',sys.modules)

    def test_lost_prepared_container_cannot_implicitly_reload_model(self):
        from gpu_service import validate_prepared_request
        with self.assertRaisesRegex(RuntimeError,'no implicit model reload'):
            validate_prepared_request({'require_prepared':True},'generate',None)
        validate_prepared_request({'require_prepared':True},'generate',object())
        validate_prepared_request({},'prepare',None)
        self.assertNotIn('torch',sys.modules)

    def test_deferred_prompt_updates_plan_without_rebuilding_transformer(self):
        from engine import StoryEngine
        from contextlib import nullcontext
        engine=StoryEngine(story='horror',gpu='RTX-PRO-6000',window=10)
        engine.prepared=True;engine.contexts=[]
        engine.shared=SimpleNamespace(build_count=1)
        engine.torch=SimpleNamespace(inference_mode=nullcontext,cuda=SimpleNamespace(empty_cache=lambda:None))
        engine.guard_memory=lambda:None
        def encode():engine.contexts=['encoded-later']
        engine._encode_prompt_contexts=encode
        plan=dict(engine.plan);plan['scene']='A new scene entered after the GPU is ready, with original Arabic speech.'
        previous=engine.expected_hash;engine.set_plan(plan)
        self.assertEqual(engine.shared.build_count,1);self.assertEqual(engine.contexts,['encoded-later']);self.assertNotEqual(previous,engine.expected_hash)
        engine.set_plan(plan)
        self.assertEqual(engine.shared.build_count,1)
        engine.rendering=True
        with self.assertRaises(RuntimeError):engine.set_plan(plan)
        self.assertNotIn('torch',sys.modules)

    def test_session_command_replaces_prompt_but_not_gpu_seed_or_quality(self):
        from gpu_host import session_payload
        original={'prompt':None,'gpu':'RTX-PRO-6000','seed':42,'image':None}
        actual=session_payload(original,{'prompt':'A later scene with dialogue and a clear chronological event.','seed':42})
        self.assertIsNone(original['prompt']);self.assertEqual(actual['gpu'],original['gpu']);self.assertEqual(actual['seed'],42)
        self.assertEqual(session_payload(original,{'prompt':'شخص يمشي في الصحرا'})['prompt'],'شخص يمشي في الصحرا')
        with self.assertRaises(RuntimeError):session_payload(original,{'prompt':'  '})
        with self.assertRaises(RuntimeError):session_payload(original,{'prompt':actual['prompt'],'seed':7})
        self.assertNotIn('torch',sys.modules)

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
                    buffer_containers=0,scaledown_window=1200)(FilmEngine)
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
