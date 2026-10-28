"""Local byte fixtures only; no SDK, cloud access, model weights or resources."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
from destination_integrity import verify_mounted_files


class DestinationIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = b'fixture-content'
        (self.root / 'weights.bin').write_bytes(self.content)
        self.files = {'weights.bin': {'size': len(self.content),
                                     'sha256': hashlib.sha256(self.content).hexdigest()}}

    def test_read_only_verification_emits_actual_byte_counts_without_ready_marker(self):
        events = []
        ticks = iter(range(100))
        result = verify_mounted_files(self.root, self.files, emit=lambda **e: events.append(e),
                                      now=lambda: next(ticks), chunk_bytes=4)
        self.assertTrue(result['verificationPassed'])
        progress = [e for e in events if e['kind'] == 'progress']
        self.assertEqual([e['completed'] for e in progress], [4, 8, 12, 15])
        self.assertEqual(progress[-1]['global_completed'], len(self.content))
        self.assertEqual(progress[-1]['rate'], 15 / 4)
        self.assertFalse(result['gpuUsed'])
        self.assertFalse(result['readyMarkerWritten'])
        self.assertEqual(list(self.root.iterdir()), [self.root / 'weights.bin'])
        self.assertEqual((self.root / 'weights.bin').read_bytes(), self.content)

    def test_same_size_corruption_fails_actual_digest(self):
        (self.root / 'weights.bin').write_bytes(b'x' * len(self.content))
        result = verify_mounted_files(self.root, self.files)
        self.assertFalse(result['verificationPassed'])
        self.assertEqual(result['files'][0]['reason'], 'SIZE_OR_SHA256_MISMATCH')

    def test_missing_file_and_empty_scope_never_claim_complete(self):
        files = {'missing.bin': self.files['weights.bin']}
        self.assertFalse(verify_mounted_files(self.root, files)['verificationPassed'])
        self.assertFalse(verify_mounted_files(self.root, {})['verificationPassed'])

    def test_cancel_before_read_preserves_file_and_emits_no_success(self):
        events = []
        def cancel():
            raise RuntimeError('TRANSFER_CANCELLED')
        with self.assertRaisesRegex(RuntimeError, 'TRANSFER_CANCELLED'):
            verify_mounted_files(self.root, self.files, check=cancel,
                                 emit=lambda **e: events.append(e))
        self.assertEqual(events, [])
        self.assertEqual((self.root / 'weights.bin').read_bytes(), self.content)

    def test_paths_cannot_escape_mount_and_no_fake_rate_without_elapsed_time(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_VERIFICATION_PATH'):
            verify_mounted_files(self.root, {'../outside.bin': self.files['weights.bin']})
        events = []
        verify_mounted_files(self.root, self.files, now=lambda: 0,
                             emit=lambda **e: events.append(e))
        self.assertIsNone(next(e for e in events if e['kind'] == 'progress')['rate'])


if __name__ == '__main__':
    unittest.main()
