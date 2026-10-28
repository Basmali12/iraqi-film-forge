"""Offline production-profile and lifecycle contracts; not a GPU test."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'engine/runtime'))
import dfr_engine
from story import load_plan


class ProductionDFRTests(unittest.TestCase):
    def test_profile_has_no_conv_dependency_and_pins_all_six_components(self):
        profile=dfr_engine.PROFILE
        self.assertEqual(profile['pipeline'],'DFRPipeline')
        self.assertEqual(len(profile['files']),6)
        self.assertFalse(any('vae-conv' in p for p in profile['files']))
        self.assertIn('detailing_lora',profile['paths'])
        self.assertTrue(all(len(v['sha256'])==64 for v in profile['files'].values()))

    def test_missing_and_corrupt_components_stop_without_downloading(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);content=b'quality-model'
            profile={'model_revision':'fixture','id':'fixture','files':{'extra':{'size':len(content),'sha256':hashlib.sha256(content).hexdigest(),'repo':'official'}}}
            with patch.object(dfr_engine,'PROFILE',profile):
                with self.assertRaisesRegex(RuntimeError,'READY'):dfr_engine.check_production_weights(root)
                (root/'READY.json').write_text(json.dumps({'revision':'fixture'}))
                with self.assertRaisesRegex(RuntimeError,'COMPONENTS_REQUIRED'):dfr_engine.check_production_weights(root)
                (root/'extra').write_bytes(content)
                self.assertEqual(dfr_engine.check_production_weights(root)['files'],1)
                (root/'extra').write_bytes(b'x'*len(content))
                with self.assertRaisesRegex(RuntimeError,'HASH_MISMATCH'):dfr_engine.check_production_weights(root)

    def test_prepared_pipeline_object_is_reused_and_image_can_be_cleared(self):
        plan=load_plan('horror');engine=dfr_engine.DfrStoryEngine('RTX-PRO-6000',plan=plan)
        pipeline=object();engine.pipeline=pipeline;engine.prepared=True
        next_plan=dict(plan);next_plan['scene']='The next distinct event, no repeated speech.'
        engine.set_plan(next_plan);self.assertIs(engine.pipeline,pipeline)
        engine.set_image(None);self.assertIsNone(engine.image_path)
        engine.rendering=True
        with self.assertRaises(RuntimeError):engine.set_plan(plan)
        self.assertNotIn('torch',sys.modules)

    def test_original_gpu_service_selects_dfr_without_legacy_fallback(self):
        source=(ROOT/'engine/runtime/gpu_service.py').read_text()
        self.assertIn('from dfr_engine import DfrStoryEngine',source)
        self.assertNotIn('from engine import StoryEngine',source)
        with self.assertRaises(ValueError):dfr_engine.DfrStoryEngine('L40S',plan=load_plan('horror'))


if __name__=='__main__':unittest.main()
