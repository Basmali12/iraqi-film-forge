"""SDK-free component for the destination CPU verifier (not yet cloud-tested).

Reads an existing mounted tree; never creates resources, downloads files,
writes markers or imports the SDK.
"""
import hashlib
from pathlib import Path
import time


def verify_mounted_files(root, files, *, emit=lambda **event: None,
                         check=lambda: None, now=time.monotonic,
                         chunk_bytes=8 * 2**20):
    root = Path(root).resolve()
    if not 1 <= chunk_bytes <= 8 * 2**20:
        raise ValueError('INVALID_VERIFICATION_CHUNK_SIZE')
    # Validate the complete read scope before touching any file.
    paths = {}
    for name in files:
        path = (root / name).resolve()
        if Path(name).is_absolute() or not path.is_relative_to(root):
            raise ValueError('INVALID_VERIFICATION_PATH')
        paths[name] = path
    started = now()
    verified_bytes = 0
    total = sum(item['size'] for item in files.values())
    outcomes = []
    for name, expected in files.items():
        check()
        emit(kind='phase_start', phase='integrity', file=name)
        size = 0
        digest = hashlib.sha256()
        try:
            with paths[name].open('rb') as stream:
                while True:
                    check()
                    chunk = stream.read(chunk_bytes)
                    if not chunk:
                        break
                    size += len(chunk)
                    digest.update(chunk)
                    elapsed = max(0, now() - started)
                    emit(kind='progress', phase='integrity', file=name,
                         completed=size, total=expected['size'],
                         global_completed=verified_bytes + size,
                         global_total=total, unit='destination_bytes_hashed',
                         rate=(verified_bytes + size) / elapsed if elapsed else None)
        except FileNotFoundError:
            outcomes.append({'name': name, 'valid': False, 'reason': 'MISSING'})
            continue
        valid = size == expected['size'] and digest.hexdigest() == expected['sha256']
        outcomes.append({'name': name, 'valid': valid, 'size': size,
                         'sha256': digest.hexdigest(),
                         'reason': None if valid else 'SIZE_OR_SHA256_MISMATCH'})
        verified_bytes += size
        emit(kind='file_verified' if valid else 'phase_error', phase='integrity',
             file=name, completed=size, total=expected['size'])
    # This receipt proves only the requested files; never a full engine READY.
    return {'verificationPassed': bool(files) and all(f['valid'] for f in outcomes),
            'files': outcomes, 'bytesRead': verified_bytes,
            'gpuUsed': False, 'readyMarkerWritten': False}
