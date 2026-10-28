"""Runs the pinned upstream CLI main, never an independently reimplemented sampler."""
import contextlib
import importlib
import json
import sys
import time
from pathlib import Path


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    plan = request['plan']
    from quality_lab.plan import official_command, check_files
    # No network fallback. Extra weights must already have verified hashes.
    check_files(plan, plan['model_root'])
    start = time.monotonic()
    import torch
    from telemetry import EventSink
    from ltx_pipelines.utils.blocks import PromptEncoder, DiffusionStage, VideoDecoder, AudioDecoder
    sink = EventSink(sync=torch.cuda.synchronize)
    sink.emit('phase_end', phase='runtime_imports', seconds=time.monotonic()-start)
    if 'RTX PRO 6000' not in torch.cuda.get_device_name(0):
        raise RuntimeError('Unexpected GPU; no fallback permitted')
    torch.cuda.reset_peak_memory_stats()
    patched = []
    # Observe real component calls including lazy decoder iteration. Nested spans
    # are reported separately and must not be summed as disjoint wall time.
    for cls, phase in [(PromptEncoder,'prompt_prepare'), (DiffusionStage,'denoise'),
                       (VideoDecoder,'video_decode'), (AudioDecoder,'audio_decode')]:
        original = cls.__call__
        def measured(self, *args, _original=original, _phase=phase, **kwargs):
            return sink.call(_original, _phase, self, *args, **kwargs)
        patched.append((cls, original))
        cls.__call__ = measured
    module = importlib.import_module(plan['module'])
    old_argv = sys.argv
    old_encode = module.encode_video
    def measured_encode(*args, **kwargs):
        return sink.call(old_encode, 'encode_mp4', *args, **kwargs)
    module.encode_video = measured_encode
    sys.argv = official_command(plan, request['raw'])[2:]
    try:
        # All pipeline construction, DFR keyframes/detailing/LoRA application,
        # scheduling and native audio remain upstream responsibilities.
        with sink.span('official_pipeline_total'), contextlib.redirect_stdout(sys.stderr):
            module.main()
        result = {'status':'completed', 'events':sink.events,
                  'peak_torch_allocated_bytes':torch.cuda.max_memory_allocated(),
                  'peak_torch_reserved_bytes':torch.cuda.max_memory_reserved(),
                  'gpu':torch.cuda.get_device_name(0), 'cuda':torch.version.cuda,
                  'torch':str(torch.__version__), 'recorded_cost':None,
                  'note':'PyTorch peaks exclude non-PyTorch allocations. Nested spans are not additive.'}
        Path(request['metrics']).write_text(json.dumps(result))
    finally:
        sys.argv = old_argv
        module.encode_video = old_encode
        for cls, original in patched:
            cls.__call__ = original


if __name__ == '__main__':
    main()
