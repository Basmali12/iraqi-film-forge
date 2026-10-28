"""Private RPC service. Same pinned quality and native AV as successful benchmark.
No model download paths, external voice, endpoints, or writes to model Volume.
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import modal

def metadata_for_wire(value):
    # Strip dependency-specific primitive subclasses (notably TorchVersion).
    # HostHatch is an SDK controller and deliberately has no Torch installation.
    return json.loads(json.dumps(value))

def render_dimensions(orientation):
    if orientation not in ('portrait','landscape'):raise RuntimeError('Unsupported orientation')
    return (768,1280) if orientation=='portrait' else (1280,768)

def validate_prepared_request(payload,mode,engine):
    if mode not in ('prepare','generate'):raise RuntimeError('Unsupported operation')
    if mode=='generate' and payload.get('require_prepared') and engine is None:
        raise RuntimeError('Prepared session lost; no implicit model reload')


def request_conditioning(payload):
    value=payload.get('image')
    if value is None:return None
    if not isinstance(value,bytes) or not 32<=len(value)<=4000000:
        raise RuntimeError('Invalid conditioning image')
    if not (value.startswith(b'\x89PNG\r\n\x1a\n') or value.startswith(b'\xff\xd8\xff') or (value[:4]==b'RIFF' and value[8:12]==b'WEBP')):
        raise RuntimeError('Invalid conditioning image')
    with tempfile.NamedTemporaryFile(prefix='iff-conditioning-',suffix='.png',delete=False) as stream:
        stream.write(value)
        return stream.name


def extract_last_frame(video,frame):
    try:
        subprocess.run(['ffmpeg','-v','error','-y','-sseof','-0.05','-i',str(video),'-frames:v','1',str(frame)],check=True,timeout=30)
        return frame.exists() and frame.stat().st_size>32
    except Exception:
        return False  # Derived-frame failure must not discard a verified MP4.


class FilmEngine:
    @modal.enter()
    def initialize(self):
        self.engine=None
        self.prepared_prompt=None

    @modal.exit()
    def shutdown(self):
        if getattr(self,'engine',None):self.engine.close()

    @modal.method(is_generator=True)
    def operate(self,payload,mode):
        if os.environ.get('LTX25_LAB_PAID_APPROVED')!='YES':
            raise RuntimeError('Approval required')
        events=queue.Queue()
        def work():
            image_path=None
            try:
                validate_prepared_request(payload,mode,self.engine)
                import settings as cfg
                cfg.WIDTH,cfg.HEIGHT=render_dimensions(payload.get('orientation','portrait'))
                from telemetry import EventSink
                from dfr_engine import DfrStoryEngine
                from cloud_output import finalize
                import hashlib
                sink=EventSink(callback=lambda e:events.put({'event':e}))
                cfg.SEED=payload['seed']
                plan={'name':'director-scene','standalone_scene':True,'duration_seconds':10,'frames':241,'window_seconds':10,
                      'scene':payload.get('prompt') or 'Await the user scene description. No generation has been requested.','language':'Arabic dialogue exactly as written in the scene',
                      'speakers':[],'events':[{'id':'scene','start_frame':0,'end_frame':241,
                       'before':'The opening state described in the scene.','action':'Perform the supplied scene chronologically, cause before reaction. Dialogue occurs once. Do not restart.',
                       'after':'The supplied scene reaches its final state.','dialogue':[],'completed_before':[]}]}
                image_path=request_conditioning(payload)
                if self.engine is None:
                    # Persist the actual conditioned frame only in temporary container storage.
                    self.engine=DfrStoryEngine(gpu=payload['gpu'],window=10,telemetry=sink,plan=plan,image_path=image_path)
                    self.engine.prepare(defer_prompt=mode=='prepare')
                    self.prepared_prompt=None if mode=='prepare' else payload['prompt']
                else:
                    self.engine.events.callback=lambda e:events.put({'event':e})
                    if mode=='generate':
                        self.engine.events.events=[]
                        self.engine.set_image(image_path)
                        self.engine.set_plan(plan)
                        self.prepared_prompt=payload['prompt']
                if mode=='prepare':
                    events.put({'prepared':True,'gpu':metadata_for_wire(self.engine.device_info),
                                'allocated_vram_bytes':self.engine.torch.cuda.memory_allocated(),
                                'reserved_vram_bytes':self.engine.torch.cuda.memory_reserved()})
                    return
                with tempfile.TemporaryDirectory(prefix='iff-scene-') as folder:
                    folder=Path(folder);raw=folder/'raw.mp4';final=folder/'video.mp4';audit=folder/'audit.json';frame=folder/'last-frame.png'
                    self.engine.render(str(raw),str(audit))
                    target=(720,1280) if cfg.WIDTH<cfg.HEIGHT else (1280,720)
                    sink.call(finalize,'finalize_mp4',raw,final,10,width=cfg.WIDTH,height=cfg.HEIGHT,output_width=target[0],output_height=target[1])
                    frame_ready=extract_last_frame(final,frame)
                    content=final.read_bytes()
                    events.put({'video':content,'frame':frame.read_bytes() if frame_ready else None,'lastFrameReady':frame_ready,'sha256':hashlib.sha256(content).hexdigest(),
                                'audit':json.loads(audit.read_text()),'metadata':json.loads(final.with_suffix('.json').read_text()),
                                'videoVerified':True,'continuity':{'mode':'actual last frame → native ImageConditioningInput.at(frame=0)' if payload.get('image') else 'text-to-video; no identity guarantee','conditioning':self.engine.last_conditioning,'qualityVerifiedOnGPU':False}})
            except BaseException as exc:
                # Send only type, not a potentially credential-bearing exception string.
                events.put({'failure':type(exc).__name__})
            finally:
                if image_path:
                    try:Path(image_path).unlink(missing_ok=True)
                    except OSError:events.put({'event':{'kind':'cleanup_warning','phase':'conditioning_image','error_type':'OSError'}})
                events.put(None)
        thread=threading.Thread(target=work,daemon=True);thread.start()
        while True:
            value=events.get()
            if value is None:break
            if 'failure' in value:
                yield {'event':{'kind':'phase_error','phase':'gpu_operation','error_type':value['failure']}}
                raise RuntimeError('GPU operation failed: '+value['failure'])
            yield value
        thread.join()
