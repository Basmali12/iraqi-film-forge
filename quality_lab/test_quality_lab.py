import ast
import contextlib
import hashlib
import io
import json
import subprocess
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from quality_lab.plan import ROOT, BASE, EXTRA, make_plan, official_command, check_files


class QualityContract(unittest.TestCase):
    def test_cpu_worker_imports_without_controller_manifests_or_gpu_sdk(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            package=root/'quality_lab';package.mkdir()
            for name in ['__init__.py','prepare_weights.py']:
                shutil.copyfile(ROOT/name,package/name)
            # Exactly the worker's minimal uploaded package; no plan.py and no
            # /root/source-manifest.json. This reproduced the cloud startup error.
            code='''import sys,importlib.abc
class Block(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname.split('.')[0] in ('modal','torch','huggingface_hub'):raise RuntimeError('CLOUD_IMPORT_BLOCKED')
sys.meta_path.insert(0,Block())
from quality_lab.prepare_weights import prepare_remote
assert callable(prepare_remote)
print('MINIMAL_CPU_WORKER_IMPORT_OK')
'''
            run=subprocess.run([sys.executable,'-X','utf8','-I','-c','import sys;sys.path.insert(0,'+repr(str(root))+');\n'+code],
                               cwd=root,capture_output=True,text=True,encoding='utf-8',check=True)
            self.assertIn('MINIMAL_CPU_WORKER_IMPORT_OK',run.stdout)
    def test_profiles_share_comparison_controls(self):
        plans=[make_plan(p,'Animated Iraqi scene. "هلا"',5,42) for p in ['baseline','diffvae','dfr']]
        for key in ['prompt_sha256','seed','frames','fps','native_width','native_height',
                    'output_width','output_height','model_revision','source_commit','gpu','offload',
                    'quantization','cpu','ram_gib','native_audio','execution_timeout']:
            self.assertEqual(len({str(p[key]) for p in plans}),1,key)
        self.assertEqual([len(p['required_files']) for p in plans],[5,5,6])
        self.assertEqual(plans[2]['additional_bytes'],1472223346+327322640)

    def test_real_official_dfr_entrypoint_and_explicit_safety_flags(self):
        plan=make_plan('dfr','Animation.')
        args=official_command(plan,'/tmp/out.mp4')
        self.assertEqual(args[1:3],['-m','ltx_pipelines.dfr_pipeline'])
        self.assertIn('--detailing-lora',args)
        self.assertIn(EXTRA[0]['relative_path'], ' '.join(args))
        self.assertEqual(args[args.index('--offload')+1],'cpu')
        self.assertNotIn('--enhance-prompt',args)
        self.assertNotIn('--compile',args)
        self.assertNotIn('--duration-head-path',args)
        self.assertEqual(plan['min_containers'],0)
        self.assertEqual(plan['max_containers'],1)
        self.assertEqual(plan['retries'],0)

    def test_missing_weights_and_marker_stop_without_preparation(self):
        with tempfile.TemporaryDirectory() as folder:
            plan=make_plan('dfr','Animation.')
            with self.assertRaisesRegex(ValueError,'READY'):
                check_files(plan,folder)
            (Path(folder)/'READY.json').write_text(json.dumps({'revision':plan['model_revision']}))
            with self.assertRaisesRegex(ValueError,'Missing or wrong size'):
                check_files(plan,folder)

    def test_extra_integrity_and_existing_ready_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            ready=json.dumps({'revision':BASE['model_revision']})
            (root/'READY.json').write_text(ready)
            (root/'extra').write_bytes(b'weights')
            plan=make_plan('dfr','Animation.')
            plan['required_files']=[{'relative_path':'extra','size':7,'sha256':hashlib.sha256(b'weights').hexdigest()}]
            self.assertEqual(check_files(plan,root),['extra'])
            (root/'extra').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'Checksum mismatch'):
                check_files(plan,root)
            self.assertEqual((root/'READY.json').read_text(),ready)

    def test_dry_cli_cannot_import_modal_or_torch(self):
        # Import blocker turns accidental SDK/GPU imports into a real process failure.
        code='''import sys,importlib.abc
class Block(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname.split('.')[0] in ('modal','torch','huggingface_hub'):raise RuntimeError('CLOUD_IMPORT_BLOCKED')
sys.meta_path.insert(0,Block())
from quality_lab.benchmark_once import main
main(['--profile','dfr','--prompt-file','quality_lab/fixtures/advertisement.txt'])
'''
        run=subprocess.run([sys.executable,'-X','utf8','-c',code],cwd=ROOT.parent,capture_output=True,text=True,encoding='utf-8',check=True)
        result=json.loads(run.stdout)
        self.assertEqual(result['mode'],'offline-plan-only')
        self.assertFalse(result['cloud_checked'])

    def test_invalid_requests_fail_locally(self):
        for profile,prompt,seconds,seed in [('other','x',5,42),('dfr','',5,42),
                                          ('dfr','x',30,42),('dfr','x',5,-1)]:
            with self.assertRaises(ValueError):make_plan(profile,prompt,seconds,seed)


if __name__=='__main__':
    unittest.main()
