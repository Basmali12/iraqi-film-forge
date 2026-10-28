"""Local text-gate safety tests, without models or cloud access."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('cpu_video_text',Path(__file__).resolve().parents[1]/'engine/video_text.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
process_video,word_box=module.process_video,module.word_box


class VideoTextSafetyTests(unittest.TestCase):
    def test_existing_source_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'original.mp4';p.write_bytes(b'original fixture')
            with self.assertRaisesRegex(RuntimeError,'MUST_NOT_BE_OVERWRITTEN'):
                process_video(p,p,Path(folder)/'report.json')
            self.assertEqual(p.read_bytes(),b'original fixture')

    def test_existing_candidate_is_never_silently_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'original.mp4';output=Path(folder)/'candidate.mp4'
            source.write_bytes(b'original');output.write_bytes(b'prior attempt')
            with self.assertRaisesRegex(RuntimeError,'MUST_NOT_BE_OVERWRITTEN'):
                process_video(source,output,Path(folder)/'report.json')
            self.assertEqual(output.read_bytes(),b'prior attempt')

    @unittest.skipUnless(importlib.util.find_spec('numpy'),'CPU text environment required')
    def test_observed_buttons_are_not_treated_as_words(self):
        self.assertFalse(word_box([[574,1056],[585,1056],[585,1075],[574,1075]]))
        self.assertTrue(word_box([[150,900],[430,900],[430,940],[150,940]]))


if __name__=='__main__':unittest.main()
