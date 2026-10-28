"""Pinned LTX adapter. Import is CPU-only; prepare/render require explicit cloud approval."""
import copy
import gc
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import settings as cfg
from story import load_plan, plan_hash, window_instructions, route_contexts
from planner import choose_window
from residency import SharedContext, ComponentCache, MemoryBudgetExceeded
from telemetry import EventSink,WeightLoadObserver


class StoryEngine:
    def __init__(self,story='short',gpu=cfg.GPU,window='auto',telemetry=None,plan=None,image_path=None):
        self.plan=copy.deepcopy(plan) if plan is not None else load_plan(story)
        self.image_path=image_path
        self.plan['window_seconds']=choose_window(gpu,window)
        self.instructions=window_instructions(self.plan)
        self.expected_hash=plan_hash(self.plan)
        self.gpu=gpu
        self.pipeline=None
        self.shared=None
        self.cache=None
        self.prepared=False
        self.rendering=False
        self.init_seconds=None
        self.events=telemetry or EventSink()
        self.weight_observer=None

    def prepare(self,load_transformer=True,defer_prompt=False):
        if os.environ.get('LTX25_LAB_PAID_APPROVED')!='YES':
            raise RuntimeError('Cloud/model initialization blocked without explicit approval')
        if self.prepared:raise RuntimeError('Engine already prepared')
        with self.events.span('runtime_imports'):
            import torch
            from ltx_core.loader.registry import ModelRegistry
            from ltx_core.loader.sft_loader import SafetensorsStateDictLoader
            from ltx_core.quantization.fp8_cast import build_policy
            from ltx_pipelines.distilled import DistilledPipeline
            from ltx_pipelines.utils.model_paths import ModelPaths
            from ltx_pipelines.utils.types import OffloadMode
            from ltx_pipelines.utils.gpu_model import gpu_model
        from weights import check_weights
        check_weights()
        if not torch.cuda.is_available():raise RuntimeError('CUDA unavailable; no fallback')
        props=torch.cuda.get_device_properties(0)
        capability=torch.cuda.get_device_capability(0)
        expected=(8,9) if self.gpu=='L40S' else (12,0)
        if self.gpu not in ('L40S','RTX-PRO-6000') or capability!=expected:
            raise RuntimeError('Unexpected GPU architecture; no automatic fallback')
        if self.gpu=='L40S' and 'L40S' not in props.name:raise RuntimeError('Wrong GPU')
        if self.gpu=='RTX-PRO-6000' and ('RTX PRO 6000' not in props.name.upper() or 'BLACKWELL' not in props.name.upper()):
            raise RuntimeError('Wrong GPU')
        if torch.__version__!='2.9.1+cu128' or torch.version.cuda!='12.8':
            raise RuntimeError('Pinned Torch/CUDA mismatch')
        if not torch.cuda.is_bf16_supported():raise RuntimeError('BF16 unavailable')
        arches=torch.cuda.get_arch_list()
        if not any(f'sm_{expected[0]}{minor}' in arches for minor in range(expected[1]+1)):
            raise RuntimeError('Torch wheel lacks a compatible GPU cubin')
        self.events.sync=torch.cuda.synchronize
        if self.gpu in ('L40S','RTX-PRO-6000'):
            if self.gpu=='RTX-PRO-6000' and props.total_memory < 90*10**9:
                raise RuntimeError('Expected the 96GB RTX PRO 6000 variant; no fallback')
            # Tiny compatibility checks INSIDE the single authorized GPU call,
            # before loading any model. This does not enable FP8 GEMM or compile.
            with self.events.span('device_preflight'):
                with torch.inference_mode():
                    probe=torch.ones((16,16),device='cuda',dtype=torch.bfloat16)
                    product=probe@probe
                    restored=probe.to(torch.float8_e4m3fn).to(torch.bfloat16)
                    attention=torch.nn.functional.scaled_dot_product_attention(
                        probe.reshape(1,1,4,64),probe.reshape(1,1,4,64),probe.reshape(1,1,4,64))
                    if not (torch.isfinite(product).all().item() and torch.isfinite(restored).all().item()
                            and torch.isfinite(attention).all().item()):
                        raise RuntimeError('CUDA/BF16/FP8-cast/SDPA compatibility check failed')
                    del probe,product,restored,attention
        self.torch=torch
        self.events.sync=torch.cuda.synchronize
        self.weight_observer=WeightLoadObserver(SafetensorsStateDictLoader,self.events)
        self.weight_observer.install()
        self.device=torch.device('cuda')
        self.device_info={'name':props.name,'capability':list(capability),'total_vram_bytes':props.total_memory,
                          'torch':str(torch.__version__),'cuda':torch.version.cuda,'compiled_arches':arches,
                          'runtime_smoke_passed':True}
        started=time.monotonic()
        paths={flag:f'{cfg.MODEL_DIR}/{name}' for flag,name in zip(
            ('transformer_path','text_encoder_path','video_vae_path','audio_vae_path'),cfg.MODEL_FILES[:4],strict=True)}
        with torch.inference_mode():
            self.pipeline=self.events.call(DistilledPipeline,'pipeline_setup',
                model_paths=ModelPaths.from_split(**paths),
                spatial_upsampler_path=f'{cfg.MODEL_DIR}/{cfg.MODEL_FILES[4]}',loras=[],
                registry=ModelRegistry(cache_models=True,cache_weights=False),
                quantization=build_policy(paths['transformer_path']),
                compilation_config=None,offload_mode=OffloadMode.CPU)
            if self.pipeline.video_decoder._diffusion_vae:
                raise RuntimeError('This lab permits the existing Conv VAE only')
            torch.cuda.reset_peak_memory_stats()
            self.contexts=[]
            if not defer_prompt:self._encode_prompt_contexts()
            gc.collect(); torch.cuda.empty_cache()
            self.cache=ComponentCache(lambda:torch.cuda.mem_get_info()[0],torch.cuda.memory_allocated,
                                      cfg.AUX_CACHE_LIMIT_BYTES,cfg.MIN_FREE_VRAM_BYTES)
            # Keep the original streaming wrapper and TWO default GPU slots; never full no-offload.
            original_context=self.pipeline.stage._streaming_transformer_ctx
            self.shared=SharedContext(self.events.observed_context(original_context,'transformer_build'),self.guard_memory)
            self.pipeline.stage._transformer_ctx=self.shared.borrow
            for owner,attribute,role in [
                (self.pipeline.upsampler,'_encoder_builder','conv_encoder'),
                (self.pipeline.upsampler,'_upsampler_builder','spatial_upsampler'),
                (self.pipeline.video_decoder,'_decoder_builder','conv_decoder'),
                (self.pipeline.audio_decoder,'_decoder_builder','audio_decoder'),
                (self.pipeline.audio_decoder,'_vocoder_builder','native_vocoder')]:
                setattr(owner,attribute,self.cache.wrap(role,getattr(owner,attribute)))
            if load_transformer:self.shared.get()
        self.init_seconds=time.monotonic()-started
        self.prepared=True

    def _encode_prompt_contexts(self):
        from ltx_pipelines.utils.gpu_model import gpu_model
        torch=self.torch
        prompts=[e['prompt'] for e in self.instructions]
        self.contexts=[]
        prompt_encoder=self.pipeline.prompt_encoder
        # Prompt batch=1: keep Gemma/connector for this phase only. Never retain all
        # raw hidden states; release Gemma before denoising. Memory guards remain active.
        with self.events.span('prompt_prepare'):
            with self.events.observed_context(prompt_encoder._text_encoder_ctx,'text_encoder_load')() as encoder:
                with self.events.observed_context(lambda:gpu_model(prompt_encoder._build_embeddings_processor()),'text_connector_load')() as processor:
                    self.guard_memory()
                    for prompt in prompts:
                        raw=self.events.call(encoder.encode,'text_forward',[prompt])
                        hidden,mask=raw[0]
                        encoded=self.events.call(processor.process_hidden_states,'text_connector_forward',hidden,mask)
                        self.contexts.append(SimpleNamespace(video_encoding=encoded.video_encoding.detach().cpu(),
                                                             audio_encoding=encoded.audio_encoding.detach().cpu()))
                        del encoded,hidden,mask,raw
                        self.guard_memory()

    def set_plan(self,plan):
        if not self.prepared or self.rendering:
            raise RuntimeError('Plan may change only between renders on a prepared engine')
        plan=copy.deepcopy(plan)
        if plan.get('frames')!=241 or plan.get('window_seconds')!=10:
            raise RuntimeError('Prepared session quality cannot change')
        self.plan=plan
        self.instructions=window_instructions(plan)
        self.expected_hash=plan_hash(plan)
        self.contexts=[]
        if getattr(self,'cache',None):self.cache.evict_idle()
        gc.collect();self.torch.cuda.empty_cache()
        with self.torch.inference_mode():self._encode_prompt_contexts()
        gc.collect();self.torch.cuda.empty_cache();self.guard_memory()

    def set_image(self,path):
        if not self.prepared or self.rendering:
            raise RuntimeError('Conditioning may change only between renders')
        if path and not Path(path).is_file():raise RuntimeError('Conditioning image missing')
        self.image_path=path

    def guard_memory(self):
        if self.torch.cuda.mem_get_info()[0] < cfg.MIN_FREE_VRAM_BYTES:
            if self.cache:self.cache.evict_idle()
            self.torch.cuda.empty_cache()
        if self.torch.cuda.mem_get_info()[0] < cfg.MIN_FREE_VRAM_BYTES:
            raise MemoryBudgetExceeded('VRAM headroom below 12GiB; stop without retry or no-offload')

    def render(self,raw_path,audit_path):
        if not self.prepared or self.rendering or not self.contexts:raise RuntimeError('Engine not ready, prompt missing or already in use')
        if plan_hash(self.plan)!=self.expected_hash:raise RuntimeError('Snapshot/story identity mismatch')
        from ltx_core.types import VideoPixelShape
        from ltx_core.model.video_vae import AUTO_TILING
        from ltx_pipelines.chunks import (ChunkConfig,generate_uniform_chunks,denoise_chunks,
            spatially_upsample_chunks,decode_chunks,split_decoded_chunks)
        from ltx_pipelines.distilled import ANCESTRAL_NOISE_SEED_OFFSET,ANCESTRAL_STAGE_2_NOISE_SEED_OFFSET
        from ltx_pipelines.utils.constants import DISTILLED_SIGMAS,STAGE_2_DISTILLED_SIGMAS
        from ltx_pipelines.utils.media_io import encode_video
        from ltx_pipelines.utils.types import VideoAudio
        from pathlib import Path
        torch=self.torch
        events=[]; calls=[]
        started=time.monotonic()
        self.denoise_completed=0
        self.denoise_total=len(self.instructions)*((len(DISTILLED_SIGMAS)-1)+(len(STAGE_2_DISTILLED_SIGMAS)-1))
        self.rendering=True
        status='error'
        try:
            with torch.inference_mode():
                chunk_config=ChunkConfig(chunk_pixel_frames=self.plan['window_seconds']*cfg.FPS+1,
                    next_video_carry_frames=cfg.CARRY_FRAMES,overlap_blend_frames=cfg.BLEND_FRAMES)
                original_encoder=self.pipeline.prompt_encoder
                first=self.contexts[0]
                first_prompt=self.instructions[0]['prompt']
                def replay_first(prompts,**kwargs):
                    if prompts!=[first_prompt]:raise RuntimeError('Unexpected prompt replay request')
                    return [SimpleNamespace(video_encoding=first.video_encoding.to(self.device),
                                            audio_encoding=first.audio_encoding.to(self.device))]
                self.pipeline.prompt_encoder=replay_first
                try:
                    # Fresh generator/noiser every request, including after Snapshot restore.
                    from ltx_pipelines.utils.types import ImageConditioningInput
                    conditioning=[ImageConditioningInput.at(self.image_path,0,1.0)] if self.image_path else []
                    ctx=self.pipeline._prepare_run(prompt=first_prompt,seed=cfg.SEED,height=cfg.HEIGHT,width=cfg.WIDTH,
                        frame_rate=cfg.FPS,images=conditioning,color_space=None,num_frames=self.plan['frames'],
                        vae_dtype=torch.bfloat16,tiling_config=AUTO_TILING,enhance_prompt=False,
                        enhance_static_cache=False,generated_keyframes=0,decode_with_keyframes=False,
                        chunk_config=chunk_config)
                    if conditioning and not ctx.images:raise RuntimeError('Native image conditioning was not applied')
                    import hashlib
                    self.last_conditioning={'mode':'last-frame image-to-video' if conditioning else 'text-to-video',
                        'image_sha256':hashlib.sha256(Path(self.image_path).read_bytes()).hexdigest() if conditioning else None,
                        'frame':0 if conditioning else None,'native_conditioning_count':len(ctx.images)}
                finally:self.pipeline.prompt_encoder=original_encoder
                chunks=generate_uniform_chunks(
                    target=VideoPixelShape(batch=1,frames=ctx.num_frames,height=ctx.stage_1_height,
                                          width=ctx.stage_1_width,fps=cfg.FPS),
                    context=VideoAudio(video=ctx.video_context,audio=ctx.audio_context),
                    device=self.device,dtype=ctx.dtype,config=ctx.chunk_config,
                    video_scale_factors=self.pipeline.stage.video_scale_factors,
                    make_video_conditionings=self.pipeline._video_conditionings(ctx.images,ctx.num_frames),
                    generated_keyframes=0)
                chunks=route_contexts(chunks,self.plan,self.contexts,lambda v:v.to(self.device),events)
                base=denoise_chunks(chunks,MeasuredStage(self.pipeline.stage,'stage_1',self,calls),
                    sigmas=DISTILLED_SIGMAS.to(device=self.device,dtype=torch.float32),
                    noiser=ctx.noiser,fps=cfg.FPS,noise_scale=1.0,
                    **self.pipeline._sampler_kwargs(cfg.SEED,ANCESTRAL_NOISE_SEED_OFFSET))
                upscaled=spatially_upsample_chunks(base,GuardedCall(self.pipeline.upsampler,self.guard_memory,self.events,'upscale'))
                refined=denoise_chunks(upscaled,MeasuredStage(self.pipeline.stage,'stage_2',self,calls),
                    sigmas=STAGE_2_DISTILLED_SIGMAS.to(device=self.device,dtype=torch.float32),
                    noiser=ctx.noiser,fps=cfg.FPS,
                    **self.pipeline._sampler_kwargs(cfg.SEED,ANCESTRAL_STAGE_2_NOISE_SEED_OFFSET))
                decoded=decode_chunks(refined,GuardedCall(self.pipeline.video_decoder,self.guard_memory,self.events,'video_decode'),
                    GuardedCall(self.pipeline.audio_decoder,self.guard_memory,self.events,'audio_decode'),fps=cfg.FPS,
                    tiling_config=ctx.tiling_config,generator=ctx.generator,dtype=ctx.vae_dtype,keyframes=False)
                video,audio,rate=split_decoded_chunks(decoded)
                if audio is None:raise RuntimeError('Native audio stream missing')
                try:
                    self.events.call(encode_video,'raw_encode',video=video,fps=cfg.FPS,audio=audio,output_path=raw_path,
                        video_chunks_number=1,color_space=None,audio_sampling_rate=rate,
                        video_marker=None,audio_marker=None)
                finally:
                    video.close()
                    decoded.close()
                torch.cuda.synchronize()
                if len(events)!=len(self.instructions):raise RuntimeError('Incomplete event plan')
                if self.shared.build_count!=1:raise RuntimeError('Transformer unexpectedly rebuilt')
                status='success'
        finally:
            self.rendering=False
            payload={'status':status,'story_hash':self.expected_hash,'events':events,'stage_calls':calls,
                     'conditioning':getattr(self,'last_conditioning',None),
                     'load_phase_seconds_recorded_at_prepare':self.init_seconds,'render_seconds':time.monotonic()-started,
                     'transformer_build_count':self.shared.build_count,'transformer_build_seconds':self.shared.build_seconds,
                     'transformer_borrow_count':self.shared.borrow_count,'aux_build_counts':self.cache.builds,
                     'aux_cache_hits':self.cache.hits,'gpu':self.device_info,'offload':'cpu',
                     'telemetry':self.events.events,'prompt_cache_enabled':False,'weight_cache_enabled':False,'conv_vae':True,
                     'peak_torch_allocated_bytes':torch.cuda.max_memory_allocated(),
                     'peak_torch_reserved_bytes':torch.cuda.max_memory_reserved(),
                     'note':'Load timing is recorded at prepare/capture, NOT a measurement of Snapshot restore. Resource counters/peaks cover the container lifetime; event/stage records cover this request. Torch peaks exclude non-Torch/driver allocations. No quality/speed claims before GPU validation.'}
            Path(audit_path).write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')

    def close(self):
        try:
            if self.cache:self.cache.close()
        finally:
            try:
                if self.shared:self.shared.close()
            finally:
                if self.weight_observer:self.weight_observer.close()
                self.prepared=False


class GuardedCall:
    def __init__(self,target,guard,events=None,phase=None):self.target,self.guard,self.events,self.phase=target,guard,events,phase
    def __call__(self,*args,**kwargs):
        self.guard()
        if self.events:return self.events.call(self.target,self.phase,*args,**kwargs)
        return self.target(*args,**kwargs)
    def __getattr__(self,name):return getattr(self.target,name)


class MeasuredStage:
    def __init__(self,stage,phase,engine,calls):
        self.stage,self.phase,self.engine,self.calls,self.index=stage,phase,engine,calls,0
    def __getattr__(self,name):return getattr(self.stage,name)
    def __call__(self,*args,**kwargs):
        self.engine.guard_memory()
        started=time.monotonic()
        total=len(kwargs['sigmas'])-1
        original_denoiser=kwargs['denoiser']
        completed=0
        def observed_denoiser(*a,**k):
            nonlocal completed
            result=original_denoiser(*a,**k)
            self.engine.torch.cuda.synchronize()
            completed+=1
            self.engine.denoise_completed+=1
            self.engine.events.emit('progress',phase='denoise_'+self.phase,window=self.index,
                                    completed=completed,total=total,unit='denoiser_evaluations',
                                    global_completed=self.engine.denoise_completed,global_total=self.engine.denoise_total)
            return result
        kwargs['denoiser']=observed_denoiser
        with self.engine.events.span('denoise_'+self.phase,window=self.index):
            result=self.stage(*args,**kwargs)
        self.engine.torch.cuda.synchronize()
        self.calls.append({'phase':self.phase,'window_id':self.engine.instructions[self.index]['id'],
                           'event_ids':self.engine.instructions[self.index]['event_ids'],
                           'seconds':time.monotonic()-started})
        self.index+=1
        return result
