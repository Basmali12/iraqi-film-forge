"""Bounded component lifetime helpers. No Torch imports; independently CPU-testable."""
from contextlib import contextmanager
import time


class MemoryBudgetExceeded(RuntimeError):
    pass


class SharedContext:
    """Keep ONE original streaming context open across calls, release exactly once."""
    def __init__(self,factory,guard=lambda:None):
        self.factory=factory
        self.guard=guard
        self.cm=None
        self.value=None
        self.build_count=0
        self.borrow_count=0
        self.build_seconds=0.0
        self.closed=False

    def get(self):
        if self.closed:raise RuntimeError('Shared resource is closed')
        self.guard()
        if self.cm is None:
            cm=self.factory()
            started=time.monotonic()
            value=cm.__enter__()
            self.cm,self.value=cm,value
            self.build_count+=1
            self.build_seconds+=time.monotonic()-started
            try:self.guard()
            except BaseException:
                self.close()
                raise
        return self.value

    @contextmanager
    def borrow(self,**kwargs):
        model=self.get()
        self.borrow_count+=1
        yield model

    def close(self):
        cm=self.cm
        self.cm,self.value=None,None
        self.closed=True
        if cm is not None:cm.__exit__(None,None,None)

    def __enter__(self):return self

    def __exit__(self,*exc):self.close()


class ComponentCache:
    """Retain only bounded auxiliary weights; fall back to normal disposal if tight."""
    def __init__(self,free_bytes,allocated_bytes,limit_bytes,min_free_bytes):
        self.free_bytes=free_bytes
        self.allocated_bytes=allocated_bytes
        self.limit=limit_bytes
        self.floor=min_free_bytes
        self.entries={}
        self.builds={}
        self.hits={}
        self.closed=False

    def evict_idle(self):
        for key,entry in list(self.entries.items()):
            if entry['active']==0:
                entry['model'].dispose()
                del self.entries[key]

    def acquire(self,role,builder,kwargs):
        if self.closed:raise RuntimeError('Component cache is closed')
        key=(role,tuple(sorted((k,str(v)) for k,v in kwargs.items())))
        if key in self.entries:
            self.hits[role]=self.hits.get(role,0)+1
            self.entries[key]['active']+=1
            return CachedModel(self,key)
        if self.free_bytes()<self.floor:
            self.evict_idle()
        if self.free_bytes()<self.floor:
            raise MemoryBudgetExceeded('Insufficient free VRAM before auxiliary build')
        before=self.allocated_bytes()
        model=builder.build(**kwargs)
        size=max(0,self.allocated_bytes()-before)
        self.entries[key]={'model':model,'size':size,'active':1}
        self.builds[role]=self.builds.get(role,0)+1
        return CachedModel(self,key)

    def release(self,key):
        entry=self.entries.get(key)
        if entry is None:return
        entry['active']-=1
        if entry['active']<0:raise RuntimeError('Unbalanced model disposal')
        if entry['active']:return
        retained=sum(e['size'] for e in self.entries.values())
        if retained>self.limit or self.free_bytes()<self.floor:
            entry['model'].dispose()
            del self.entries[key]

    def wrap(self,role,builder):return CachedBuilder(self,role,builder)

    def close(self):
        for entry in self.entries.values():entry['model'].dispose()
        self.entries.clear()
        self.closed=True


class CachedBuilder:
    def __init__(self,cache,role,builder):self.cache,self.role,self.builder=cache,role,builder
    def build(self,**kwargs):return self.cache.acquire(self.role,self.builder,kwargs)
    def __getattr__(self,name):return getattr(self.builder,name)


class CachedModel:
    def __init__(self,cache,key):self.cache,self.key,self.released=cache,key,False
    @property
    def model(self):return self.cache.entries[self.key]['model']
    def eval(self):self.model.eval(); return self
    def __call__(self,*args,**kwargs):return self.model(*args,**kwargs)
    def __getattr__(self,name):return getattr(self.model,name)
    def dispose(self):
        if not self.released:
            self.released=True
            self.cache.release(self.key)
