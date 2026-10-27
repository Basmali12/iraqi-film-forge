"""Local window/resource planning. Does not pretend unmeasured windows are VRAM-safe."""
from settings import GPU, FPS, WIDTH, HEIGHT, cost_plan, TIMEOUT_SECONDS, STARTUP_TIMEOUT_SECONDS
from story import window_plan


def choose_window(gpu,requested='auto'):
    if gpu not in ('L40S','RTX-PRO-6000'):raise ValueError('Unsupported planning GPU')
    if requested=='auto':
        # Historical L40S evidence only. RTX uses a proposed test size, not a passed benchmark.
        return 5 if gpu=='L40S' else 10
    value=int(requested)
    if value not in (5,10,15,20):raise ValueError('Window must be 5, 10, 15 or 20 seconds')
    return value


def preflight_plan(duration_seconds=9,window='auto',gpu=GPU):
    if not isinstance(duration_seconds,int) or not 1<=duration_seconds<=300:
        raise ValueError('Local planner supports 1..300 seconds; longer films require a reviewed budget')
    selected=choose_window(gpu,window)
    frames=duration_seconds*FPS+1
    layouts=window_plan(frames,selected)
    latent_frames=(selected*FPS)//8+1
    highres_tokens=latent_frames*(HEIGHT//32)*(WIDTH//32)
    baseline_tokens=16*(HEIGHT//32)*(WIDTH//32)
    return {'mode':'LOCAL PLAN ONLY','gpu':gpu,'film_seconds':duration_seconds,'frames':frames,
        'window_request':str(window),'selected_window_seconds':selected,'chunk_pixel_frames':selected*FPS+1,
        'carry_frames':25,'video_blend_frames':25,'windows':len(layouts),'resolution':[WIDTH,HEIGHT],
        'audio':'native LTX joint video/audio, latent carry, native vocoder','offload':'cpu',
        'no_offload_enabled':False,'model_snapshot_enabled':False,'memory_runtime_validated':False,
        'historical_evidence':'Only 121-frame windows were run successfully on the original L40S pipeline; this modified engine is untested.',
        'approx_highres_video_tokens':highres_tokens,'token_ratio_to_5s':highres_tokens/baseline_tokens,
        'attention_work_ratio_if_quadratic':(highres_tokens/baseline_tokens)**2,
        'memory_warning':'Token counts are NOT a VRAM estimate. Fused attention, audio/text tokens, casts, decode tiling and residency affect peaks. No 20s safety guarantee.',
        'execution_timeout_seconds':TIMEOUT_SECONDS,'startup_timeout_seconds':STARTUP_TIMEOUT_SECONDS,
        'long_film_warning':'Configured short-test timeout is not a budget for a 1-5 minute film. A complete Story Timeline, timing measurements and separate approval are required.',
        'cost':cost_plan(gpu),
        'window_layouts':[{'window':w.index,'start_frame':w.start,'frames':w.frames,'owned_range':w.owned_range} for w in layouts]}
