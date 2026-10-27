"""Real operation events only. No simulated percentages or model/cloud imports."""
from contextlib import contextmanager,ExitStack
from collections.abc import Iterator
import json
import re
import time
import uuid

PREFIX='LTX_EVENT '


def redact(text):
    return re.sub(r'\b(?:hf_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,})\b','[REDACTED]',str(text))


class EventSink:
    def __init__(self,callback=None,stdout=False,sync=lambda:None):
        self.callback,self.stdout,self.sync=callback,stdout,sync
        self.events=[]

    def emit(self,kind,**fields):
        event={'kind':kind,'time':time.time(),**fields}
        encoded=redact(json.dumps(event,ensure_ascii=False))
        event=json.loads(encoded)
        self.events.append(event)
        if self.stdout:print(PREFIX+encoded,flush=True)
        if self.callback:self.callback(event)
        return event

    @contextmanager
    def span(self,phase,**fields):
        self.sync()
        ident=uuid.uuid4().hex
        started=time.perf_counter()
        self.emit('phase_start',phase=phase,span_id=ident,**fields)
        try:
            yield
        except BaseException as exc:
            self.emit('phase_error',phase=phase,span_id=ident,error_type=type(exc).__name__,message=redact(exc))
            raise
        else:
            self.sync()
            self.emit('phase_end',phase=phase,span_id=ident,seconds=time.perf_counter()-started,**fields)

    def observed_context(self,factory,phase):
        @contextmanager
        def context():
            with ExitStack() as stack:
                with self.span(phase):model=stack.enter_context(factory())
                yield model
        return context

    def call(self,target,phase,*args,**kwargs):
        self.sync();started=time.perf_counter();ident=uuid.uuid4().hex
        self.emit('phase_start',phase=phase,span_id=ident)
        try:result=target(*args,**kwargs)
        except BaseException as exc:
            self.emit('phase_error',phase=phase,span_id=ident,message=redact(exc),error_type=type(exc).__name__)
            raise
        self.sync();active=time.perf_counter()-started
        if isinstance(result,Iterator):
            return self._iterator(result,phase,ident,active)
        self.emit('phase_end',phase=phase,span_id=ident,seconds=active)
        return result

    def _iterator(self,iterator,phase,ident,active):
        try:
            while True:
                self.sync();started=time.perf_counter()
                try:value=next(iterator)
                except StopIteration:
                    self.sync();active+=time.perf_counter()-started
                    self.emit('phase_end',phase=phase,span_id=ident,seconds=active,active_iterator_time=True)
                    return
                self.sync();active+=time.perf_counter()-started
                yield value  # Encoding/other work while suspended is excluded from active time.
        except GeneratorExit:
            self.emit('phase_aborted',phase=phase,span_id=ident)
            raise
        except BaseException as exc:
            self.emit('phase_error',phase=phase,span_id=ident,message=redact(exc),error_type=type(exc).__name__)
            raise
        finally:
            close=getattr(iterator,'close',None)
            if close:close()


class WeightLoadObserver:
    """Scoped observation of the pinned safetensors loader, including sd_ops/transfers."""
    def __init__(self,loader_class,sink):self.cls,self.sink,self.original=loader_class,sink,None
    def install(self):
        if self.original is not None:raise RuntimeError('Weight observer already installed')
        self.original=self.cls.load
        original,sink=self.original,self.sink
        def load(loader,*args,**kwargs):
            with sink.span('weights_read_transform'):
                return original(loader,*args,**kwargs)
        self.cls.load=load
    def close(self):
        if self.original is not None:
            self.cls.load=self.original
            self.original=None
