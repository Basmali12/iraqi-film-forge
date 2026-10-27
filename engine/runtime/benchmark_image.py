"""Stable image definition; never accepts job payload, GPU, seed or timeouts."""
import os
if os.environ.get('LTX25_BENCHMARK_APPROVED')!='YES':raise RuntimeError('Image definitions blocked')
import modal
from settings import ROOT,SOURCE_COMMIT

STATIC_ENV={'LTX25_LAB_PAID_APPROVED':'YES','LTX25_BENCHMARK_APPROVED':'YES',
    'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1',
    'PYTORCH_CUDA_ALLOC_CONF':'expandable_segments:True'}

def make_image():
    return (modal.Image.debian_slim(python_version='3.12').apt_install('git','ffmpeg','libgomp1')
        .run_commands('git clone https://github.com/Lightricks/LTX-2.git /opt/LTX-2 && '
                      f'git -C /opt/LTX-2 checkout --detach {SOURCE_COMMIT}')
        .pip_install_from_requirements(str(ROOT/'requirements-remote.lock'))
        .pip_install_from_requirements(str(ROOT/'build-requirements.lock'))
        .run_commands('python -m pip install --no-build-isolation --no-deps /opt/LTX-2/packages/ltx-core /opt/LTX-2/packages/ltx-pipelines',
                      'python -m pip check')
        .env(STATIC_ENV)
        .add_local_dir(ROOT,remote_path='/root',copy=True,ignore=['**/__pycache__/**','**/*.pyc']))

def check_image():
    image=modal.Image.debian_slim(python_version='3.12')
    for name in ('settings.py','weights.py','source-manifest.json'):
        image=image.add_local_file(ROOT/name,f'/root/{name}')
    return image
