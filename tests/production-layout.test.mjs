import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutScene,progressOf,sceneStatus} from '../site/production-layout.js';
test('neural coordinates stay stable across scene updates and reloads, with no overlapping cards',()=>{const old=Array.from({length:30},(_,i)=>layoutScene(i+1,'same-film')),next=Array.from({length:60},(_,i)=>layoutScene(i+1,'same-film'));assert.deepEqual(next.slice(0,30),old);for(let i=0;i<old.length;i++)for(let j=i+1;j<old.length;j++)assert.ok(Math.abs(old[i].x-old[j].x)>=106||Math.abs(old[i].y-old[j].y)>=85);});
test('only measured progress is a percentage; stopped/uncertain tasks do not pulse',()=>{assert.equal(progressOf(undefined,8),null);assert.equal(progressOf(1,0),null);assert.equal(progressOf(9,8),null);assert.equal(progressOf(3,8),38);assert.equal(sceneStatus('recovery_required'),'uncertain');assert.equal(sceneStatus('stopped'),'stopped');assert.equal(sceneStatus('completed'),'done');});
