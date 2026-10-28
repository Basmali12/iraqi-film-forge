"""Offline experiment contract. No Modal, Torch, network, or downloads."""
import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT.parent / 'engine' / 'runtime'
if not RUNTIME.is_dir():
    RUNTIME = ROOT.parent  # Stable runtime image mounts its pinned files at /root.
BASE = json.loads((RUNTIME / 'source-manifest.json').read_text())
EXTRA = json.loads((ROOT / 'extra-weights.json').read_text())['files']
PROFILES = {'baseline': ('ltx_pipelines.distilled', False, False),
            'diffvae': ('ltx_pipelines.distilled', True, False),
            'dfr': ('ltx_pipelines.dfr_pipeline', True, True)}


def make_plan(profile, prompt, seconds=5, seed=42):
    if profile not in PROFILES:
        raise ValueError('Unknown comparison profile')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError('A non-empty prompt up to 12000 characters is required')
    if seconds not in (5, 10) or type(seed) is not int or not 0 <= seed < 2**31:
        raise ValueError('Short comparison only: 5 or 10 seconds and a valid seed')
    module, diffvae, dfr = PROFILES[profile]
    revision = BASE['model_revision']
    model_root = f'/models/ltx25/{revision}'
    files = [{**v, 'relative_path': k, 'base': True} for k, v in BASE['files'].items()]
    if diffvae:
        files = [f for f in files if '-video-vae-conv-' not in f['relative_path']]
        files.append(EXTRA[0])
    if dfr:
        files.append(EXTRA[1])
    rate = Decimal('.000842') + 4 * Decimal('.0000131') + 96 * Decimal('.00000222')
    return dict(profile=profile, module=module, prompt=prompt, seed=seed, seconds=seconds,
                frames=seconds*24+1, fps=24, native_width=768, native_height=1280,
                output_width=720, output_height=1280, model_root=model_root,
                model_revision=revision, source_commit=BASE['source_commit'],
                gpu='RTX-PRO-6000', ram_gib=96, cpu=4, offload='cpu', quantization='fp8-cast',
                native_audio=True, temporal_upscalings=0, spatial_upscalings=1,
                execution_timeout=900, startup_timeout=180, local_timeout=1500,
                min_containers=0, max_containers=1, retries=0,
                required_files=files, additional_bytes=sum(f['size'] for f in files if not f.get('base')),
                prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
                rate_usd_per_second=str(rate), resource_window_estimate_usd=str(rate*1082),
                pricing_checked='2026-10-28', pricing_url='https://modal.com/pricing',
                warning='Estimate, not a bill cap. DFR runtime/VRAM not validated. Excludes image build, storage and traffic.')


def official_command(plan, output, python=sys.executable):
    root = plan['model_root']
    names = list(BASE['files'])
    vae = EXTRA[0]['relative_path'] if plan['profile'] != 'baseline' else names[2]
    command = [python, '-m', plan['module']]
    for flag, name in [('transformer', names[0]), ('text-encoder', names[1]),
                       ('video-vae', vae), ('audio-vae', names[3]), ('spatial-upsampler', names[4])]:
        command += [f'--{flag}-path', f'{root}/{name}']
    command += ['--prompt', plan['prompt'], '--seed', str(plan['seed']),
                '--num-frames', str(plan['frames']), '--frame-rate', '24',
                '--width', '768', '--height', '1280', '--offload', 'cpu',
                '--quantization', 'fp8-cast', '--output-path', str(output)]
    if plan['profile'] == 'dfr':
        command += ['--detailing-lora', f"{root}/{EXTRA[1]['relative_path']}",
                    '--temporal-upscalings', '0', '--spatial-upscalings', '1']
    return command


def check_files(plan, root):
    """Validate an explicitly supplied mounted/local snapshot, never fetch files."""
    root = Path(root)
    ready = root / 'READY.json'
    if not ready.is_file() or json.loads(ready.read_text()).get('revision') != plan['model_revision']:
        raise ValueError('Matching READY.json is required; no automatic preparation')
    checked = []
    for spec in plan['required_files']:
        path = root / spec['relative_path']
        if not path.is_file() or path.stat().st_size != spec['size']:
            raise ValueError(f"Missing or wrong size: {spec['relative_path']}")
        if not spec.get('base'):
            digest = hashlib.sha256()
            with path.open('rb') as f:
                for block in iter(lambda: f.read(8*1024**2), b''):
                    digest.update(block)
            if digest.hexdigest() != spec['sha256']:
                raise ValueError(f"Checksum mismatch: {spec['relative_path']}")
        checked.append(spec['relative_path'])
    return checked
