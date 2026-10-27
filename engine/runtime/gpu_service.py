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
            try:
                import settings as cfg
                from telemetry import EventSink
                from engine import StoryEngine
                from cloud_output import finalize
                import hashlib
                sink=EventSink(callback=lambda e:events.put({'event':e}))
                cfg.SEED=payload['seed']
                plan={'name':'director-scene','duration_seconds':10,'frames':241,'window_seconds':10,
                      'scene':payload['prompt'],'language':'Arabic dialogue exactly as written in the scene',
                      'speakers':[],'events':[{'id':'scene','start_frame':0,'end_frame':241,
                       'before':'The opening state described in the scene.','action':'Perform the supplied scene chronologically, cause before reaction. Dialogue occurs once. Do not restart.',
                       'after':'The supplied scene reaches its final state.','dialogue':[],'completed_before':[]}]}
                if self.engine is None:
                    # Persist the actual conditioned frame only in temporary container storage.
                    image_path=None
                    if payload.get('image'):
                        image_path='/tmp/iff-initial-frame.png';Path(image_path).write_bytes(payload['image'])
                    self.engine=StoryEngine(gpu=payload['gpu'],window=10,telemetry=sink,plan=plan,image_path=image_path)
                    self.engine.prepare()
                    self.prepared_prompt=payload['prompt']
                else:
                    if self.prepared_prompt!=payload['prompt']:
                        raise RuntimeError('Prepared prompt mismatch; no implicit reload or second render')
                    self.engine.events.callback=lambda e:events.put({'event':e})
                if mode=='prepare':
                    events.put({'prepared':True,'gpu':self.engine.device_info,
                                'allocated_vram_bytes':self.engine.torch.cuda.memory_allocated(),
                                'reserved_vram_bytes':self.engine.torch.cuda.memory_reserved()})
                    return
                with tempfile.TemporaryDirectory(prefix='iff-scene-') as folder:
                    folder=Path(folder);raw=folder/'raw.mp4';final=folder/'video.mp4';audit=folder/'audit.json';frame=folder/'last-frame.png'
                    self.engine.render(str(raw),str(audit))
                    sink.call(finalize,'finalize_mp4',raw,final,10)
                    frame_ready=extract_last_frame(final,frame)
                    content=final.read_bytes()
                    events.put({'video':content,'frame':frame.read_bytes() if frame_ready else None,'lastFrameReady':frame_ready,'sha256':hashlib.sha256(content).hexdigest(),
                                'audit':json.loads(audit.read_text()),'metadata':json.loads(final.with_suffix('.json').read_text()),
                                'videoVerified':True,'continuity':{'mode':'actual last frame → native ImageConditioningInput.at(frame=0)' if payload.get('image') else 'text-to-video; no identity guarantee','qualityVerifiedOnGPU':False}})
            except BaseException as exc:
                # Send only type, not a potentially credential-bearing exception string.
                events.put({'failure':type(exc).__name__})
            finally:
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
