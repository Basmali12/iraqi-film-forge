// Deterministic local brief compiler. No LLM, provider call, model or network.
const clean=value=>String(value??'').trim();
const invalid=()=>{throw Error('INVALID_CREATIVE_BRIEF');};
export function prepareBrief(input){
 const request=clean(input.request);
 if(!request||request.length>4000)invalid();
 for(const key of ['brand','activity','location','dialogue'])if(clean(input[key]).length>500)invalid();
 const normalized=request.replace(/[إأآ]/g,'ا').replace(/ة/g,'ه');
 let kind=clean(input.kind)||'auto';
 if(!['auto','advert','story','scene'].includes(kind))invalid();
 if(kind==='auto')kind=/اعلان|اعلاني|ترويج|دعاي[ه]/u.test(normalized)?'advert':/قصه|حكايه/u.test(normalized)?'story':'scene';
 const found=request.match(/(?:اسمها|اسم\s*(?:الشركة|الشركه|المحل|المطعم)|باسم|تسمى)\s*[-:،]*\s*[«"']?([^\n،.!؟»"']{2,100})/u);
 const brand=(clean(input.brand)||clean(found?.[1]).replace(/^[\s-]+|[\s-]+$/g,'')).slice(0,100);
 const activity=clean(input.activity)||(/برمج|تطبيق|مواقع|موقع|تقني|تكنولوج/u.test(normalized)?'software':/مطعم|طعام|طبخ|اكل/u.test(normalized)?'food':/منتج|متجر|محل/u.test(normalized)?'product':'requested subject');
 const tech=activity==='software'||/برمج|تطبيق|مواقع|تقني/u.test(activity);
 const food=activity==='food'||/مطعم|طعام|طبخ/u.test(activity);
 const explicitSpeech=request.match(/(?:يقول|تقول|الحوار|النص المنطوق)\s*[:：]?\s*[«"']([^»"']+)[»"']/u)?.[1];
 const dialogue=clean(input.dialogue)||clean(explicitSpeech)||(kind==='advert'&&brand?`عندك فكرة؟ ويّا ${brand} نحوّلها لواقع. خل نبدي مشروعك!`:'');
 const dialect=/عراقي|عراقيه|عراقية|بغداد/u.test(normalized)?'natural Iraqi Baghdadi Arabic, conversational pronunciation, never formal MSA':/فصحى|فصيح/u.test(normalized)?'Modern Standard Arabic':'the language and dialect explicitly requested by the user';
 const location=clean(input.location)||(kind==='advert'?(tech?'a contemporary Iraqi software studio with a real desk, laptops and a developer working in the background':food?'a clean working kitchen and serving counter, food preparation visible in the background':'a setting directly related to the requested business, with its product or service visibly demonstrated'):'the location specified in the user request; preserve its requested style and setting');
 const demonstration=tech?'The presenter turns the laptop toward the camera and demonstrates one simple app interaction; the screen shows clear abstract UI blocks and app navigation, not legible text or private data. A developer actually works at a second desk.':food?'The presenter demonstrates the food being prepared and then served, with the food and hands clearly visible.':'Show the requested action or service actually being performed with relevant objects, rather than only a person talking to camera.';
 const beats=kind==='advert'?[{time:'0–3 ثوانٍ',action:`Establish ${location}. The presenter starts with the relevant product or workstation already visible. Frame the business environment, not an unrelated corridor.`},{time:'3–7 ثوانٍ',action:demonstration},{time:'7–10 ثوانٍ',action:'Finish the demonstration, then the presenter reacts and gives the short call to action. Keep the product/workstation visible in the final composition.'}]:[{time:'0–3 ثوانٍ',action:'Clearly establish the requested character, place and initial situation. Show the scene rather than reciting its description.'},{time:'3–7 ثوانٍ',action:'Perform the specific central action from the request once, with the relevant objects and a visible change in state. Cause must precede reaction.'},{time:'7–10 ثوانٍ',action:'Show the immediate consequence of that action and a natural ending. Do not restart the action or invent unrelated characters or a new setting.'}];
 const warnings=['هذا إعداد محلي بالقواعد، وليس نموذج فهم عام. راجع التفاصيل المقترحة وعدّلها قبل اعتمادها.','توقيت الأحداث وتطابق الكلام والصورة توجيهات للنموذج، وليست ضماناً لتنفيذ كل تفصيل.'];
 if(kind==='advert'&&!brand)warnings.push('اسم النشاط غير واضح؛ أدخله إذا أردت نطقه بالإعلان.');
 if(kind==='advert'&&tech)warnings.push('واجهات التطبيق مقترحة ورمزية؛ العرض المطابق لمنتجك يحتاج مراجع فعلية.');
 if(!dialogue)warnings.push('لم يُحدد حوار حرفي؛ سيُطلب صوت المكان فقط. أضف جملة إذا أردت كلاماً محدداً.');
 if(dialogue.split(/\s+/).length>26)warnings.push('الحوار طويل نسبياً لفيديو 10 ثوانٍ؛ اختصره لتقليل احتمال قصّ الكلام.');
 const summaries=kind==='advert'?['إظهار المكان المرتبط بالشركة والشخص والخدمة من البداية.','عرض الخدمة أو المنتج فعلياً بحركة واضحة، مع بقاء البيئة المهنية ظاهرة.','نتيجة العرض ثم جملة قصيرة للتواصل، بدون تكرار الحديث.']:['تعريف الشخصية والمكان والحالة الأولية المطلوبة.','حدوث الفعل الرئيسي مرة واحدة، والسبب قبل رد الفعل.','إظهار النتيجة المباشرة ونهاية طبيعية بدون إعادة الحدث.'];
 beats.forEach((beat,i)=>{beat.summary=summaries[i];});
 const compiledPrompt=[
  `Create one coherent 10-second ${kind==='advert'?'cinematic commercial':kind==='story'?'short narrative scene':'visual scene'}, with synchronized native audio.`,
  `User intent — do not read these instructions aloud: ${request}`,
  `Location and visible environment: ${location}. Preserve explicitly requested cast, style and facts.`,
  ...beats.map(b=>`${b.time}: ${b.action}`),
  'Camera: one continuous purposeful moving shot. Start wide enough to establish the environment, reframe toward the central action or product, then settle on its outcome. Keep the same character and setting.'+(kind==='advert'?' Do not render only an isolated talking head.':' Preserve any specifically requested framing and performance.'),
  dialogue?`Spoken dialogue, once only, in ${dialect}: "${dialogue}". Speak only this dialogue; do not read the user request, timestamps or visual instructions.`:'No invented dialogue. Native ambience and sounds caused by visible actions only.',
  'Audio: preserve the model\'s synchronized native speech, room tone and relevant action sounds. No external voice engine.',
  'No subtitles, generated Arabic lettering, watermarks, invented logos, invented contact information, awards, prices or unsupported business claims. If a brand name is supplied, speak it rather than trying to draw it.',
 ].join('\n');
 if(compiledPrompt.length>12000)invalid();
 return {version:1,kind,brand,activity,location,dialogue,timeline:beats,compiledPrompt,warnings,method:'local deterministic rules; no external AI or network',paid:false};
}
