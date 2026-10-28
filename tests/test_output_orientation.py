"""Offline ffprobe fixtures; no encoding, models or cloud execution."""
import importlib
import json
import pathlib
import sys
import tempfile
import unittest
import shutil
import subprocess
import hashlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'engine'/'runtime'))
import settings

class OrientationTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'CPU ffmpeg tools unavailable on this platform')
    def test_exact_720_crop_on_real_cpu_test_pattern_preserves_source_and_audio(self):
        import cloud_output
        with tempfile.TemporaryDirectory() as folder:
            for native,target in [((768,1280),(720,1280)),((1280,768),(1280,720))]:
                raw=pathlib.Path(folder)/'raw.mp4';final=pathlib.Path(folder)/'out.mp4'
                subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i',f'color=c=navy:s={native[0]}x{native[1]}:r=24','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','1','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac',str(raw)],check=True,timeout=30)
                before=hashlib.sha256(raw.read_bytes()).hexdigest()
                cloud_output.finalize(raw,final,1,width=native[0],height=native[1],output_width=target[0],output_height=target[1])
                audit=json.loads(final.with_suffix('.json').read_text())
                self.assertEqual((audit['width'],audit['height']),target)
                self.assertTrue(audit['center_cropped']);self.assertEqual((audit['native_width'],audit['native_height']),native)
                self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(),before)
                self.assertTrue(any(s['codec_type']=='audio' for s in audit['ffprobe']['streams']))

    def test_invalid_crop_rejected_without_encoding(self):
        import cloud_output
        with tempfile.TemporaryDirectory() as folder,patch.object(cloud_output.subprocess,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'Invalid output crop'):
                cloud_output.finalize('fixture',pathlib.Path(folder)/'out.mp4',10,width=768,height=1280,output_width=800,output_height=1280)
            run.assert_not_called()

    def test_landscape_preparation_then_portrait_render_validates_current_request(self):
        with patch.object(settings,'WIDTH',1024),patch.object(settings,'HEIGHT',576):
            import cloud_output
            output=importlib.reload(cloud_output)
            settings.WIDTH,settings.HEIGHT=576,1024
            metadata={'streams':[{'codec_type':'video','width':576,'height':1024},{'codec_type':'audio'}],'format':{'duration':'10.0'}}
            with tempfile.TemporaryDirectory() as folder,patch.object(output.subprocess,'run'),patch.object(output.subprocess,'check_output',return_value=json.dumps(metadata).encode()):
                final=pathlib.Path(folder)/'video.mp4'
                output.finalize('offline-fixture.mp4',final,10)
                saved=json.loads(final.with_suffix('.json').read_text())
                self.assertEqual((saved['width'],saved['height']),(576,1024))

    def test_wrong_resolution_and_missing_audio_still_rejected(self):
        import cloud_output
        with patch.object(settings,'WIDTH',576),patch.object(settings,'HEIGHT',1024),tempfile.TemporaryDirectory() as folder,patch.object(cloud_output.subprocess,'run'):
            metadata={'streams':[{'codec_type':'video','width':1024,'height':576},{'codec_type':'audio'}],'format':{'duration':'10.0'}}
            with patch.object(cloud_output.subprocess,'check_output',return_value=json.dumps(metadata).encode()),self.assertRaisesRegex(RuntimeError,'Resolution changed'):
                cloud_output.finalize('fixture',pathlib.Path(folder)/'video.mp4',10)
            metadata['streams']=metadata['streams'][:1]
            with patch.object(cloud_output.subprocess,'check_output',return_value=json.dumps(metadata).encode()),self.assertRaisesRegex(RuntimeError,'Native audio missing'):
                cloud_output.finalize('fixture',pathlib.Path(folder)/'video.mp4',10)
