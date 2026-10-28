"""Pinned transfer identity; importing this module performs no cloud operations."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
MANIFEST=json.loads((ROOT/'runtime/source-manifest.json').read_text())
VERSION='cloud-copy-v3-host-account-orchestration'
APP_NAME='iff-ltx25-cloud-copy-v1'
DICT_NAME='iff-ltx25-cloud-copy-state-v1'
FUNCTION_NAME='copy_models'
SOURCE_WORKSPACE='basm1998ali'
SOURCE_VOLUME='modal-ltx25-test-models'
PREFIX='/ltx25/'+MANIFEST['model_revision']
CPU=2;RAM_MIB=4096;TIMEOUT=3600;STARTUP=180
VERIFY_TIMEOUT=600
def verifier_names(volume):
    import re
    if not re.fullmatch(r'iff-ltx25-[a-f0-9]{8}',volume):raise ValueError('INVALID_TRANSFER_DESTINATION')
    suffix=volume[-8:]
    return 'iff-ltx25-verify-'+suffix,'iff-ltx25-verify-state-'+suffix
FINGERPRINT=hashlib.sha256(json.dumps({'version':VERSION,'manifest':MANIFEST,'cpu':CPU,'ram':RAM_MIB,'timeout':TIMEOUT,'verifyTimeout':VERIFY_TIMEOUT,'source':SOURCE_VOLUME},sort_keys=True).encode()).hexdigest()
