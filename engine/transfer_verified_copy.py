"""Copy via the source mount; verify through a destination-local CPU receipt.

No destination model bytes are read across the SDK in this workflow.
"""
import json
from pathlib import Path
from cloud_transfer_core import digest, file_chunks


class DestinationIntegrityMismatch(ValueError):
    def __init__(self, files):
        super().__init__('DESTINATION_SHA256_MISMATCH')
        self.corrupt_files = files


def validated_receipt(manifest, receipt):
    if receipt.get('revision') != manifest['model_revision']:
        raise ValueError('VERIFIER_RECEIPT_REVISION_MISMATCH')
    rows = receipt.get('files', [])
    indexed = {r['name']: r for r in rows}
    if len(indexed) != len(rows) or set(indexed) != set(manifest['files']):
        raise ValueError('VERIFIER_RECEIPT_SCOPE_MISMATCH')
    return {name for name, spec in manifest['files'].items()
            if indexed[name].get('valid') is True and
            (indexed[name].get('size'), indexed[name].get('sha256')) ==
            (spec['size'], spec['sha256'])}


def copy_with_destination_verification(manifest, source_root, target, approved,
                                       verify, emit=lambda **e: None, check=lambda: None,
                                       verify_only=False, upload_only=False):
    files = manifest['files']
    if not set(approved).issubset(files):
        raise ValueError('UNAPPROVED_FILE')
    existing = verify('before')
    valid = validated_receipt(manifest, existing)
    needed = [n for n in files if n not in valid]
    if verify_only:
        corrupt = [row['name'] for row in existing['files']
                   if not row.get('valid') and row.get('reason') != 'MISSING']
        if not valid and not corrupt:
            raise ValueError('NO_SAVED_WEIGHTS_TO_VERIFY')
        return {'verificationOnly': True, 'ready': False, 'gpuUsed': False,
                'verifiedFiles': sorted(valid), 'remainingFiles': needed,
                'requiresNewPlan':bool(corrupt), 'corruptFiles':corrupt,
                'existingFilesValid':not corrupt,
                'transferredBytes': 0, 'status': 'needs_review' if corrupt else 'completed'}
    unexpected = [n for n in needed if n not in approved]
    if unexpected:
        return {'ready': False, 'requiresNewPlan': True, 'corruptFiles': unexpected,
                'gpuUsed': False, 'status': 'needs_review'}
    required = sum(files[n]['size'] for n in needed)
    done = 0
    for name in needed:
        check()
        path = (Path(source_root) / name).resolve()
        if not path.is_relative_to(Path(source_root).resolve()):
            raise ValueError('INVALID_SOURCE_PATH')
        emit(kind='phase_start', phase='transfer', file=name)
        def observed(count):
            check()
            emit(kind='progress', phase='transfer', file=name, transferred=done+count,
                 required=required, unit='source_bytes_hashed')
        size, sha = digest(file_chunks(path), observed)
        if (size, sha) != (files[name]['size'], files[name]['sha256']):
            raise ValueError('SOURCE_SHA256_MISMATCH')
        target.ensure()
        emit(kind='phase_start', phase='upload', file=name)
        target.upload(name, path)
        emit(kind='phase_end', phase='upload', file=name)
        done += size
    check()
    if upload_only:
        return {'ready':False, 'gpuUsed':False, 'status':'awaiting_verification',
                'transferredBytes':done, 'verifiedFiles':sorted(valid)}
    final = verify('after')
    return finalize_verified_copy(manifest, target, final, done, emit, check)


def finalize_verified_copy(manifest, target, final, done=0,
                           emit=lambda **e:None, check=lambda:None):
    files = manifest['files']
    final_valid = validated_receipt(manifest, final)
    if final_valid != set(files):
        raise DestinationIntegrityMismatch(sorted(set(files)-final_valid))
    check()
    emit(kind='phase_start', phase='engine_configuration')
    target.ensure()
    runtime = {'model_revision': manifest['model_revision'], 'source_commit': manifest['source_commit'],
               'native_audio': True, 'vae': 'conv', 'gpu_choices': ['RTX-PRO-6000', 'L40S'],
               'torch': '2.9.1+cu128', 'cuda': '12.8', 'precision': 'FP8 cast / BF16 compute',
               'offload': 'cpu'}
    target.upload_bytes('RUNTIME.json', json.dumps(runtime).encode())
    marker = {'revision': manifest['model_revision'], 'files': files, 'hashVerified': True}
    target.upload_bytes('READY.json', json.dumps(marker).encode())
    # Only the tiny marker is read through the SDK, never model weights.
    if json.loads(b''.join(target.read('READY.json'))) != marker:
        raise ValueError('READY_MARKER_MISMATCH')
    emit(kind='phase_end', phase='engine_configuration')
    emit(kind='ready', phase='ready')
    return {'ready': True, 'gpuUsed': False, 'status': 'completed',
            'transferredBytes': done, 'verifiedFiles': sorted(final_valid),
            'inspection': {'ready': True, 'revision': manifest['model_revision'],
                'hashVerifiedByTransfer': True,
                'files': [{'name': n, 'size': f['size'], 'manifestMatch': True,
                           'hashVerifiedNow': True} for n, f in files.items()],
                'readyMarker': {'revision': manifest['model_revision'], 'present': True}}}
