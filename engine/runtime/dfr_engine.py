"""Production DFR adapter. Import is CPU-only; never falls back to Conv VAE."""
import copy
import hashlib
import json
import time
from pathlib import Path
import settings as cfg
from story import window_instructions, plan_hash
from telemetry import EventSink

PROFILE=json.loads((Path(__file__).parent/'production-profile.json').read_text())


def check_production_weights(root=None):
    root=Path(root or cfg.MODEL_DIR)
    marker=root/'READY.json'
    if not marker.is_file() or json.loads(marker.read_text()).get('revision')!=PROFILE['model_revision']:
        raise RuntimeError('DFR_BASE_READY_REQUIRED')
    for name,spec in PROFILE['files'].items():
        p=root/name
        if not p.is_file() or p.stat().st_size!=spec['size']:
            raise RuntimeError('DFR_COMPONENTS_REQUIRED_NO_DOWNLOAD')
        if 'repo' in spec:
            digest=hashlib.sha256()
            with p.open('rb') as f:
                for block in iter(lambda:f.read(8*1024**2),b''):digest.update(block)
            if digest.hexdigest()!=spec['sha256']:raise RuntimeError('DFR_COMPONENT_HASH_MISMATCH')
    return {'profile':PROFILE['id'],'files':len(PROFILE['files'])}


class DfrStoryEngine:
    def __init__(self,gpu,window=10,telemetry=None,plan=None,image_path=None):
        if gpu!='RTX-PRO-6000' or window!=10:raise ValueError('DFR_VALIDATED_RTX_10S_ONLY')
        self.gpu=gpu;self.events=telemetry or EventSink();self.plan=copy.deepcopy(plan)
        self.instructions=window_instructions(self.plan);self.expected_hash=plan_hash(self.plan)
        self.image_path=image_path;self.pipeline=None;self.prepared=False;self.rendering=False

    def prepare(self,defer_prompt=False):
        if __import__('os').environ.get('LTX25_LAB_PAID_APPROVED')!='YES':raise RuntimeError('Explicit approval required')
        if self.prepared:raise RuntimeError('Already prepared')
        start=time.monotonic();check_production_weights()
        with self.events.span('runtime_imports'):
            import torch
            from ltx_pipelines.dfr_pipeline import DFRPipeline
            from ltx_pipelines.utils.model_paths import ModelPaths
            from ltx_pipelines.utils.types import OffloadMode
            from ltx_core.loader import LoraPathStrengthAndSDOps
            from ltx_core.quantization.fp8_cast import build_policy
        if not torch.cuda.is_available() or torch.cuda.get_device_capability(0)!=(12,0):raise RuntimeError('RTX_CUDA_REQUIRED')
        props=torch.cuda.get_device_properties(0)
        if 'RTX PRO 6000' not in props.name.upper():raise RuntimeError('Unexpected GPU')
        self.torch=torch;self.events.sync=torch.cuda.synchronize
        self.device_info={'name':props.name,'capability':[12,0],'total_vram_bytes':props.total_memory,
                          'torch':str(torch.__version__),'cuda':torch.version.cuda,
                          'pipeline':'DFRPipeline','profile':PROFILE['id'],'stages_load_on_demand':True}
        paths={key:str(Path(cfg.MODEL_DIR)/PROFILE['paths'][key]) for key in
               ('transformer_path','text_encoder_path','video_vae_path','audio_vae_path')}
        with torch.inference_mode():
            self.pipeline=self.events.call(DFRPipeline,'pipeline_setup',
                model_paths=ModelPaths.from_split(**paths),
                spatial_upsampler_path=str(Path(cfg.MODEL_DIR)/PROFILE['paths']['spatial_upsampler_path']),
                loras=[],detailing_lora=[LoraPathStrengthAndSDOps(
                    str(Path(cfg.MODEL_DIR)/PROFILE['paths']['detailing_lora']),0.5)],
                quantization=build_policy(paths['transformer_path']),offload_mode=OffloadMode.CPU)
        if not self.pipeline.video_decoder._diffusion_vae:raise RuntimeError('DIFFUSION_VAE_REQUIRED_NO_FALLBACK')
        self.init_seconds=time.monotonic()-start;self.prepared=True

    def set_plan(self,plan):
        if not self.prepared or self.rendering:raise RuntimeError('Engine busy or unprepared')
        if plan.get('frames')!=241 or plan.get('window_seconds')!=10:raise RuntimeError('Quality cannot change')
        self.plan=copy.deepcopy(plan);self.instructions=window_instructions(plan);self.expected_hash=plan_hash(plan)

    def set_image(self,path):
        if not self.prepared or self.rendering:raise RuntimeError('Engine busy or unprepared')
        if path and not Path(path).is_file():raise RuntimeError('Conditioning image missing')
        self.image_path=path

    def render(self,raw_path,audit_path):
        if not self.prepared or self.rendering or plan_hash(self.plan)!=self.expected_hash:raise RuntimeError('Invalid render state')
        from ltx_pipelines.utils.types import ImageConditioningInput
        from ltx_pipelines.utils.blocks import PromptEncoder,DiffusionStage,VideoDecoder,AudioDecoder
        from ltx_pipelines.utils.media_io import encode_video
        from ltx_core.model.video_vae import AUTO_TILING,get_video_chunks_number
        from ltx_pipelines.utils.constants import DISTILLED_SIGMAS,STAGE_2_DISTILLED_SIGMAS
        torch=self.torch;patched=[];started=time.monotonic();self.rendering=True;status='error'
        self.denoise_calls=0;self.denoise_completed=0
        self.denoise_total=len(DISTILLED_SIGMAS)+len(STAGE_2_DISTILLED_SIGMAS)-2
        images=[ImageConditioningInput.at(self.image_path,0,1.0)] if self.image_path else []
        self.last_conditioning={'mode':'last-frame image-to-video' if images else 'text-to-video','frame':0 if images else None,
                               'image_sha256':hashlib.sha256(Path(self.image_path).read_bytes()).hexdigest() if images else None,
                               'native_conditioning_count':len(images)}
        # Scoped observation only. Upstream owns Transformer/LoRA lifetimes;
        # never reuse a base-weight context for the detailing LoRA stage.
        for cls,phase in [(PromptEncoder,'prompt_prepare'),(DiffusionStage,'denoise'),(VideoDecoder,'video_decode'),(AudioDecoder,'audio_decode')]:
            original=cls.__call__
            def measured(owner,*args,_original=original,_phase=phase,**kwargs):
                measured_phase=_phase
                if _phase=='denoise' and 'denoiser' in kwargs:
                    self.denoise_calls+=1;measured_phase=f'denoise_stage_{self.denoise_calls}'
                    denoiser=kwargs['denoiser'];total=len(kwargs['sigmas'])-1;completed=0
                    def observed(*a,**k):
                        nonlocal completed
                        value=denoiser(*a,**k);torch.cuda.synchronize();completed+=1;self.denoise_completed+=1
                        self.events.emit('progress',phase=measured_phase,completed=completed,total=total,
                                         global_completed=self.denoise_completed,global_total=self.denoise_total)
                        return value
                    kwargs['denoiser']=observed
                return self.events.call(_original,measured_phase,owner,*args,**kwargs)
            patched.append((cls,original));cls.__call__=measured
        torch.cuda.reset_peak_memory_stats()
        try:
            with torch.inference_mode():
                result=self.pipeline(prompt=('Clean, unobstructed imagery. Walls, storefront panels, garments and props '
                    'have plain unlettered surfaces. The conversation exists only as audible speech. '
                    +self.instructions[0]['prompt']),seed=cfg.SEED,
                    height=cfg.HEIGHT,width=cfg.WIDTH,num_frames=241,frame_rate=24,images=images,
                    temporal_upscalings=0,spatial_upscalings=1,tiling_config=AUTO_TILING,
                    enhance_prompt=False,enhance_static_cache=False)
                if result.audio is None:raise RuntimeError('Native audio missing')
                self.events.call(encode_video,'raw_encode',video=result.video,fps=24,audio=result.audio,
                                 output_path=raw_path,video_chunks_number=get_video_chunks_number(result.num_frames,result.tiling_config),video_marker=None,audio_marker=None)
            status='success'
        finally:
            for cls,original in patched:cls.__call__=original
            self.rendering=False
            Path(audit_path).write_text(json.dumps({'status':status,'profile':PROFILE['id'],
                'pipeline':'DFRPipeline','conv_vae':False,'native_audio':True,'offload':'cpu',
                'conditioning':self.last_conditioning,'story_hash':self.expected_hash,
                'render_seconds':time.monotonic()-started,'telemetry':self.events.events,
                'load_phase_seconds_recorded_at_prepare':self.init_seconds,
                'peak_torch_allocated_bytes':torch.cuda.max_memory_allocated(),
                'peak_torch_reserved_bytes':torch.cuda.max_memory_reserved(),
                'prompt_cache_enabled':False,'weight_cache_enabled':False,
                'transformer_residency':'official CPU streaming; not guaranteed resident across scenes'},indent=2))

    def close(self):
        self.pipeline=None;self.prepared=False
        if hasattr(self,'torch'):self.torch.cuda.empty_cache()
