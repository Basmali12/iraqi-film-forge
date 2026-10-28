"""Offline regression: a model-file SDK read must fail this test immediately."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from destination_integrity import verify_mounted_files
from transfer_verified_copy import copy_with_destination_verification


class VerifiedCopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.source = self.root / 'source'; self.dest = self.root / 'dest'
        self.source.mkdir(); self.dest.mkdir()
        self.data = {f'model-{i}.bin': bytes([i]) * 17 for i in range(5)}
        for n, data in self.data.items(): (self.source / n).write_bytes(data)
        self.manifest = {'model_revision': 'fixture', 'source_commit': 'fixture',
            'files': {n: {'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()} for n, b in self.data.items()}}
        outer = self
        class Target:
            uploads = []
            def ensure(self): pass
            def upload(self, name, path):
                self.uploads.append(name); (outer.dest / name).write_bytes(Path(path).read_bytes())
            def upload_bytes(self, name, content): (outer.dest / name).write_bytes(content)
            def read(self, name):
                if name != 'READY.json': raise AssertionError('MODEL_BYTES_MUST_NOT_CROSS_SDK')
                yield (outer.dest / name).read_bytes()
        self.target = Target()
    def verify(self, phase):
        result = verify_mounted_files(self.dest, self.manifest['files'])
        return {**result, 'revision': 'fixture'}
    def test_existing_valid_large_file_is_not_uploaded_or_read_through_sdk(self):
        name = next(iter(self.data)); (self.dest / name).write_bytes(self.data[name])
        result = copy_with_destination_verification(self.manifest, self.source, self.target,
                    set(self.data) - {name}, self.verify)
        self.assertTrue(result['ready']); self.assertEqual(len(self.target.uploads), 4)
        self.assertNotIn(name, self.target.uploads)
        self.assertTrue(json.loads((self.dest / 'READY.json').read_text())['hashVerified'])
    def test_corrupt_preexisting_file_requires_new_approval_and_never_overwrites(self):
        name = next(iter(self.data)); (self.dest / name).write_bytes(b'x' * 17)
        result = copy_with_destination_verification(self.manifest, self.source, self.target,
                    set(self.data) - {name}, self.verify)
        self.assertTrue(result['requiresNewPlan']); self.assertEqual(self.target.uploads, [])
        self.assertEqual((self.dest / name).read_bytes(), b'x' * 17)
    def test_verify_only_never_uploads_or_writes_ready(self):
        name = next(iter(self.data)); (self.dest / name).write_bytes(self.data[name])
        result = copy_with_destination_verification(self.manifest, self.source, self.target,
                    [], self.verify, verify_only=True)
        self.assertTrue(result['verificationOnly']); self.assertFalse(result['ready'])
        self.assertEqual(result['verifiedFiles'], [name]); self.assertEqual(self.target.uploads, [])
        self.assertFalse((self.dest / 'READY.json').exists())
    def test_verify_only_reports_existing_corruption_instead_of_success(self):
        name=next(iter(self.data));(self.dest/name).write_bytes(b'x'*17)
        result=copy_with_destination_verification(self.manifest,self.source,self.target,[],self.verify,verify_only=True)
        self.assertTrue(result['requiresNewPlan']);self.assertFalse(result['existingFilesValid'])
        self.assertEqual(result['corruptFiles'],[name]);self.assertEqual(self.target.uploads,[])
    def test_verify_only_cannot_succeed_when_files_disappear_before_execution(self):
        with self.assertRaisesRegex(ValueError,'NO_SAVED_WEIGHTS_TO_VERIFY'):
            copy_with_destination_verification(self.manifest,self.source,self.target,[],self.verify,verify_only=True)
    def test_changed_or_forged_final_receipt_cannot_write_ready(self):
        calls = []
        def verify(phase):
            calls.append(phase); receipt = self.verify(phase)
            if phase == 'after': receipt['files'][0]['sha256'] = 'wrong'
            return receipt
        with self.assertRaisesRegex(ValueError, 'DESTINATION_SHA256_MISMATCH'):
            copy_with_destination_verification(self.manifest, self.source, self.target, self.data, verify)
        self.assertEqual(calls, ['before', 'after']); self.assertFalse((self.dest / 'READY.json').exists())

    def test_host_orchestrated_copy_returns_before_final_verification_and_marker(self):
        name=next(iter(self.data));(self.dest/name).write_bytes(self.data[name])
        phases=[]
        def verify(phase):phases.append(phase);return self.verify(phase)
        result=copy_with_destination_verification(self.manifest,self.source,self.target,
            set(self.data)-{name},verify,upload_only=True)
        self.assertEqual(phases,['before']);self.assertEqual(result['status'],'awaiting_verification')
        self.assertFalse(result['ready']);self.assertFalse((self.dest/'READY.json').exists())
        self.assertEqual(len(self.target.uploads),4);self.assertNotIn(name,self.target.uploads)

if __name__ == '__main__': unittest.main()
