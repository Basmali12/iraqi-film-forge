"""Speech policy regression; no Torch, network, model or GPU."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine/runtime'))
from story import load_plan,window_instructions

class ArabicRuntimeTests(unittest.TestCase):
    def test_standalone_scene_never_requests_a_nonexistent_audio_prefix(self):
        plan=load_plan('horror')
        baseline=window_instructions(plan)
        self.assertTrue(any('audible speech in the carried prefix' in w['prompt'] for w in baseline))
        plan['standalone_scene']=True
        for window in window_instructions(plan):
            self.assertNotIn('audible speech in the carried prefix',window['prompt'])
            self.assertIn('speak only its locked script',window['prompt'])
        self.assertEqual([w['dialogue'] for w in baseline],[w['dialogue'] for w in window_instructions(plan)])
