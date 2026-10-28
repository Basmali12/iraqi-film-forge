// Shared generation directions. No external speech service or media processing.
const PREVIOUS_VERSION='native-av-clean-v2';
const PREVIOUS_RULES=[
 '[Permanent production directions: '+PREVIOUS_VERSION+']',
 'Honor the authored visual style throughout: animation stays animated, illustration stays illustrated, and live-action stays live-action. Do not impose photorealism on animation or change the requested medium. Keep surfaces and props unlettered. Never render subtitles, captions, dialogue text, titles, credits, logos, watermarks, UI or readable writing anywhere in any frame. Dialogue is audible only, never visual text.',
 'Native synchronized human dialogue is clear in the foreground, naturally paced, with realistic breath, consonants and pitch variation. Keep quiet location ambience below speech. No robotic or vocoder delivery, metallic doubling, hiss layer, hum, static, distortion, overlapping voices or added music unless the scene explicitly requests music.',
 'Preserve the requested Arabic language and dialect exactly: Iraqi colloquial stays Iraqi; formal Arabic stays formal. Do not translate, paraphrase, invent or repeat dialogue.',
 'Bind each quoted line to its explicitly named speaker and visible appearance. Only that person moves their mouth for the line; listeners stay silent. Distinct people retain their own voice and clothing. Never let one person ask and answer both sides of another person’s conversation. If the speaker is unclear, do not invent an attribution.',
 'Introduce only the characters required by the current event. Keep every specified prop at its stated size and type rather than changing it into another object. These directions are not spoken or displayed.'
].join('\n');
// Strip only our exact historical suffix when a stored prompt is used for a
// new request. Never rewrite stored projects, receipts or authored descriptions.
const LEGACY_RULES=PREVIOUS_RULES.replace('native-av-clean-v2','native-av-clean-v1').replace(
 'Honor the authored visual style throughout: animation stays animated, illustration stays illustrated, and live-action stays live-action. Do not impose photorealism on animation or change the requested medium. Keep surfaces and props unlettered.',
 'The entire image remains clean and photographic: blank unlettered surfaces and props.');
export const FIXED_RULES_VERSION='native-av-clean-v3';
export const FIXED_RULES=PREVIOUS_RULES.replace(PREVIOUS_VERSION,FIXED_RULES_VERSION).replace(
 'Native synchronized human dialogue is clear in the foreground, naturally paced, with realistic breath, consonants and pitch variation.',
 'Only when this scene has a locked Arabic dialogue script, speak those exact words with native synchronized human voices, naturally paced, with realistic breath, consonants and pitch variation. Explicitly silent scenes have location ambience only, no human words. Never invent dialogue to fill a pause.').replace(
 'Preserve the requested Arabic language and dialect exactly: Iraqi colloquial stays Iraqi; formal Arabic stays formal.',
 'Arabic is the mandatory spoken language. Default to natural Iraqi Arabic unless another Arabic dialect or formal Arabic is explicitly specified in the locked script: Iraqi colloquial stays Iraqi; formal Arabic stays formal.');
export function applyGenerationRules(value,script=""){
 let text=String(value??'').trim();
 for(const old of [LEGACY_RULES,PREVIOUS_RULES,FIXED_RULES])if(text.endsWith(old))text=text.slice(0,-old.length).trimEnd();
 const prompt=text+'\n\n'+(script?script+'\n\n':'')+FIXED_RULES;
 if(prompt.length>12000)throw Error('PROMPT_TOO_LONG_WITH_FIXED_RULES');
 return prompt;
}
