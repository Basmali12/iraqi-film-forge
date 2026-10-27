"""Validated chronological event plans and context routing; CPU-only."""
from dataclasses import dataclass, replace
import hashlib
import json
import re
from pathlib import Path

from settings import ROOT, CHUNK_FRAMES, CARRY_FRAMES, FPS


@dataclass(frozen=True)
class Window:
    index: int
    start: int
    frames: int
    previous_carry: int
    next_carry: int

    @property
    def owned_range(self):
        return self.start+self.previous_carry, self.start+self.frames


def window_plan(frames,window_seconds=5):
    if window_seconds not in (5,10,15,20) or frames % 8 != 1 or frames<1:
        raise ValueError('Invalid window selection or causal-grid frame count')
    chunk_frames=window_seconds*FPS+1
    target_latents=(frames-1)//8+1
    chunk_latents=(chunk_frames-1)//8+1
    carry_latents=(CARRY_FRAMES-1)//8+1
    if target_latents<=chunk_latents:
        lengths=[frames]
    else:
        full,remainder=divmod(target_latents-chunk_latents,chunk_latents-carry_latents)
        lengths=[chunk_frames]*(1+full)
        if remainder:lengths.append((carry_latents+remainder-1)*8+1)
    result=[]
    emitted=0
    for i,size in enumerate(lengths):
        previous=0 if i==0 else CARRY_FRAMES
        result.append(Window(i,emitted-previous,size,previous,0 if i==len(lengths)-1 else CARRY_FRAMES))
        emitted+=size-previous
    if emitted != frames:
        raise ValueError('Invalid stitched frame plan')
    return result


def normalized(text):
    return ' '.join(re.sub(r'[^\w\s]','',text.casefold()).split())


def prompt_for(plan,event):
    language=plan.get('language','natural Iraqi Baghdadi Arabic')
    speech = (' '.join(f'{line["speaker"]} says aloud in {language}: "{line["text"]}".'
                       for line in event['dialogue']) or 'Native ambience appropriate to the supplied scene is heard.')
    return (f'{plan["scene"]} Current visible state: {event["before"]} '
            f'The next action happens once: {event["action"]} {speech} '
            f'The action settles into this state: {event["after"]} '
            'One continuous real-time camera take. Keep the same faces, clothes, lighting and location. '
            'Spoken words are heard as speech. No captions, writing, watermarks or unrequested props.')


def load_plan(name='short'):
    if name not in ('short','full','horror'):
        raise ValueError('Unknown story')
    plan=json.loads((ROOT/f'story-{name}.json').read_text(encoding='utf-8'))
    validate_plan(plan)
    return plan


def validate_plan(plan):
    windows=window_plan(plan['frames'],plan.get('window_seconds',5))
    events=plan['events']
    if not events or plan['frames'] != plan['duration_seconds']*FPS+1:
        raise ValueError('Timeline/duration mismatch')
    ids=set(); actions=set(); lines=set(); prompts=set()
    end=0
    for i,event in enumerate(events):
        if event['start_frame']!=end or not event['start_frame']<event['end_frame']<=plan['frames']:
            raise ValueError('Timeline gap, overlap or invalid duration')
        end=event['end_frame']
        if event['id'] in ids or normalized(event['action']) in actions:
            raise ValueError('Repeated event/action')
        ids.add(event['id']); actions.add(normalized(event['action']))
        if event['completed_before'] != [e['id'] for e in events[:i]]:
            raise ValueError('Completed-event ledger is out of sequence')
        if i and event['before'] != events[i-1]['after']:
            raise ValueError('Object/character state discontinuity')
        for line in event['dialogue']:
            text=normalized(line['text'])
            if not text or text in lines:
                raise ValueError('Repeated/empty dialogue')
            lines.add(text)
            if line['speaker'] not in plan.get('speakers',('The young man','The elderly bookseller')):
                raise ValueError('Unknown speaker')
        prompt=prompt_for(plan,event)
        if prompt in prompts:
            raise ValueError('Repeated prompt')
        prompts.add(prompt)
    if end!=plan['frames']:raise ValueError('Timeline does not cover the requested film')
    return windows


def plan_hash(plan):
    return hashlib.sha256(json.dumps(plan,ensure_ascii=False,sort_keys=True).encode()).hexdigest()


def window_instructions(plan):
    """Timed beats inside each window; dialogue is emitted only in its owner window."""
    result=[]
    for window in validate_plan(plan):
        start,end=window.owned_range
        active=[e for e in plan['events'] if e['start_frame']<end and e['end_frame']>start]
        beats=[]; dialogue=[]
        for event in active:
            beginning=start<=event['start_frame']<end
            offset=max(0,event['start_frame']-start)/FPS
            action=event['action'] if beginning else 'Continue the ongoing action from its current pose without restarting: '+event['action']
            speech=event['dialogue'] if beginning else []
            dialogue.extend(speech)
            language=plan.get('language','Iraqi Baghdadi Arabic')
            words=' '.join(f'{line["speaker"]} says aloud in {language}: "{line["text"]}".' for line in speech)
            beats.append(f'At +{offset:.2f}s of the new footage: {action} {words}')
        prompt=(f'{plan["scene"]} Current state: {active[0]["before"]}. '
                +' '.join(beats)+' Preserve ongoing motion and audible speech in the carried prefix. '
                'New dialogue occurs once at its indicated beat. Quiet natural ambience between lines. '
                'One continuous real-time take, same characters and location. No captions, writing, watermarks or unrequested props.')
        result.append({'id':f'window-{window.index:03}','event_ids':[e['id'] for e in active],
            'completed_before':[e['id'] for e in plan['events'] if e['end_frame']<=start],
            'dialogue':dialogue,'prompt':prompt})
    return result


def route_contexts(chunks,plan,contexts,move_context=lambda value:value, audit=None):
    """Set BOTH modalities once before the official stage-1/upsample/stage-2 chain."""
    windows=validate_plan(plan)
    instructions=window_instructions(plan)
    if len(contexts)!=len(windows):
        raise ValueError('Missing per-event embeddings')
    count=0
    for count,chunk in enumerate(chunks,1):
        if count>len(windows):
            raise ValueError('Unexpected extra window')
        window=windows[count-1]
        layout=chunk.layout
        actual=(layout.start_pixel_frame,layout.pixel_frames,layout.prev_video_carry_frames,layout.next_video_carry_frames)
        expected=(window.start,window.frames,window.previous_carry,window.next_carry)
        if actual!=expected:
            raise ValueError(f'Upstream layout changed: {actual} != {expected}')
        event=instructions[count-1]
        context=contexts[count-1]
        if audit is not None:
            audit.append({'window_id':event['id'],'event_ids':event['event_ids'],'window':count-1,'owned_frame_range':window.owned_range,
                          'completed_before':event['completed_before'],
                          'prompt_sha256':hashlib.sha256(event['prompt'].encode()).hexdigest(),
                          'dialogue':event['dialogue'],'carry_from_window':None if count==1 else count-2})
        yield replace(chunk,video_context=move_context(context.video_encoding),
                      audio_context=move_context(context.audio_encoding))
    if count!=len(windows):
        raise ValueError('Incomplete chunk sequence')
