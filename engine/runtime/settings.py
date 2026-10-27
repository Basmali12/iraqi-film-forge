"""Pure configuration. No Modal/Torch imports or network side effects."""
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
MANIFEST = json.loads((ROOT/'source-manifest.json').read_text(encoding='utf-8'))
MODEL_REVISION = MANIFEST['model_revision']
SOURCE_COMMIT = MANIFEST['source_commit']
MODEL_FILES = tuple(MANIFEST['files'])
MODEL_DIR = f'/models/ltx25/{MODEL_REVISION}'
VOLUME_NAME = 'modal-ltx25-test-models'
GPU = 'L40S'
MEMORY_MIB = 65536
CPU_CORES = 4
WIDTH, HEIGHT, FPS, SEED = 576, 1024, 24, 42
CHUNK_FRAMES, CARRY_FRAMES, BLEND_FRAMES = 121, 25, 25
OFFLOAD = 'cpu'  # No no-offload CLI or environment override exists in this lab.
TIMEOUT_SECONDS, STARTUP_TIMEOUT_SECONDS, LOCAL_TIMEOUT_SECONDS = 300, 120, 900
SCALEDOWN_SECONDS = 2
AUX_CACHE_LIMIT_BYTES = 4 * 1024**3
MIN_FREE_VRAM_BYTES = 12 * 1024**3
GPU_RATES = {'L40S':Decimal('.000542'),'RTX-PRO-6000':Decimal('.000842')}
CPU_RATE, RAM_RATE = Decimal('.0000131'), Decimal('.00000222')


def cost_plan(gpu=GPU):
    rate = GPU_RATES[gpu] + CPU_CORES*CPU_RATE + Decimal(MEMORY_MIB//1024)*RAM_RATE
    return {'resource_usd_per_second':str(rate),
            'resource_usd_per_hour':str(rate*3600),
            'startup_execution_idle_seconds':STARTUP_TIMEOUT_SECONDS+TIMEOUT_SECONDS+SCALEDOWN_SECONDS,
            'window_estimate_usd':str(rate*(STARTUP_TIMEOUT_SECONDS+TIMEOUT_SECONDS+SCALEDOWN_SECONDS)),
            'resource_time_scenarios_usd':{str(seconds):str(rate*seconds) for seconds in (300,900,1800,3600)},
            'note':'Not a bill cap. Excludes image build, preflight, snapshot capture/restore overhead and other charges.',
            'pricing_url':'https://modal.com/pricing','checked_date':'2026-10-27'}
