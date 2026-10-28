import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {applyGenerationRules,FIXED_RULES} from '../engine/generation-rules.mjs';
test('fixed image and native speech directions apply without changing authored dialogue',()=>{
 const authored='أبو حسن بالقميص الأزرق يقول «إي ابني، محفظتي ضاعت»';const result=applyGenerationRules(authored);
 assert.ok(result.startsWith(authored));assert.ok(result.endsWith(FIXED_RULES));
 assert.match(result,/Never render subtitles/);assert.match(result,/hiss layer/);assert.match(result,/explicitly named speaker/);assert.match(result,/Iraqi colloquial stays Iraqi/);
 assert.equal(applyGenerationRules(result),result);assert.doesNotMatch(result,/ElevenLabs|OpenAI|OpenRouter|TTS|pocket wallet/);
});
test('fixed rules cannot be bypassed with just a version marker and preserve length guard',()=>{
 assert.ok(applyGenerationRules('native-av-clean-v1').endsWith(FIXED_RULES));assert.throws(()=>applyGenerationRules('x'.repeat(12000)),/PROMPT_TOO_LONG_WITH_FIXED_RULES/);
});
test('animation and live action keep the authored medium without forced photographic styling',()=>{
 for(const prompt of ['3D cartoon comedy. القط يقول «تدلل».','Live-action Iraqi advertisement. الرجل يقول «هلا».']){
  const result=applyGenerationRules(prompt);
  assert.ok(result.startsWith(prompt));
  assert.match(result,/Honor the authored visual style/);
  assert.match(result,/Do not impose photorealism on animation/);
  assert.doesNotMatch(result,/image remains clean and photographic/);
  assert.equal(applyGenerationRules(result),result);
 }
});
test('reusing actual v1 and v2 suffixes replaces obsolete speech and style rules without editing history',()=>{
 for(const legacy of JSON.parse(fs.readFileSync('tests/legacy-generation-rules.json','utf8'))){
  const input='A 3D animated Iraqi scene.\n\n'+legacy,result=applyGenerationRules(input);
  assert.ok(result.startsWith('A 3D animated Iraqi scene.'));
  assert.doesNotMatch(result,/image remains clean and photographic|native-av-clean-v[12]/);
  assert.equal(result.match(/Permanent production directions/g).length,1);
  assert.ok(input.endsWith(legacy));assert.match(result,/Explicitly silent scenes/);
 }
});
