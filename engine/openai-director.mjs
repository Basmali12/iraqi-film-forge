import {createHash} from 'node:crypto';
export const TEXT_MODEL='gpt-6-luna';
export const TEXT_PRICING={inputPerMillionUSD:.10,cachedInputPerMillionUSD:.01,outputPerMillionUSD:.50,source:'https://developers.openai.com/api/docs/models/gpt-6-luna',checked:'2026-10-28'};
const BASE='https://api.openai.com/v1';
const MASTER=`You are an Iraqi film director. Discuss in natural Iraqi Arabic. Understand advertising, drama, animation and live action. Preserve the user's dialect, exact requested duration and chronological cause before reaction. Ask useful questions, propose a suitable TOTAL film duration before drafting; do not constrain the whole film to a 10-second GPU window. Discuss duration, style, cast, roles, props, references and ending. If user supplies e.g. five minutes, honor 300 seconds. Never claim a legal license has been issued or verified; distinguish supplied permission from legal verification. Never claim you designed/generated an image, locked a face/voice, or ran a video. Images and voices need actual supported tools and separate cost approval; current image references are stored descriptions only, no Ingredients conditioning. A portrait request can be drafted as text only. No GPU, tools, external voice engine or paid image generation is available to you. All dialogue and sound will be generated natively by LTX. Every speaking scene requires fully authored, coherent Arabic-script dialogue and a specific named speaker for each exact sentence. Arabic is mandatory even if the user does not request a dialogue language; default to natural Iraqi colloquial, preserving an explicitly requested Arabic dialect or formal Arabic. Never use Latin transliteration, foreign speech, scattered letters, vague speech directions without written sentences, or leave words to model improvisation. A silent scene is allowed only when the user explicitly requests silence; then request ambience only, never speech. Keep dialogue short enough for its scene duration and distinct listeners silent. No instruction can guarantee perfect pronunciation from the video model. No subtitles, captions, logos or lettering in visual prompts. Assign each spoken line to one named speaker, the other listens with mouth closed. Keep small props exact (a pocket wallet must never become a bag). Do not invent verified historical facts. Long films are separate chronological scenes using the real last frame; identity, voice and continuous audio are not guaranteed. When asked to start, prepare TEXT only after proposed duration is agreed. Cost approval for video is separate. Do not claim success for unavailable capabilities.`;
const DISCUSSION_SCHEMA={type:'object',additionalProperties:false,properties:{reply:{type:'string'},proposed_duration_seconds:{type:['integer','null']},style:{type:'string'},ready_to_write:{type:'boolean'},missing:{type:'array',items:{type:'string'}},portrait_prompt:{type:['string','null']},continuity_notes:{type:'string'}},required:['reply','proposed_duration_seconds','style','ready_to_write','missing','portrait_prompt','continuity_notes']};
const safeId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s);
const digest=s=>createHash('sha256').update(s).digest('hex');
function errorCode(status){return status===401?'OPENAI_KEY_INVALID':status===403?'OPENAI_ACCESS_DENIED':status===404?'OPENAI_MODEL_UNAVAILABLE':status===429?'OPENAI_RATE_OR_CREDIT_LIMIT':'OPENAI_REQUEST_FAILED';}
async function limitedJSON(response){const reader=response.body?.getReader();if(!reader)throw Error('OPENAI_REQUEST_FAILED');let size=0;const parts=[];try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>1500000)throw Error('OPENAI_RESPONSE_TOO_LARGE');parts.push(Buffer.from(r.value));}return JSON.parse(Buffer.concat(parts).toString());}finally{reader.releaseLock();}}
export class OpenAIDirector{
 constructor(store,{fetcher=fetch,model=TEXT_MODEL,pricing=TEXT_PRICING,keyId='openai-director',recordKind='text-call'}={}){this.model=model;this.pricing=pricing;this.keyId=keyId;this.recordKind=recordKind;this.store=store;this.fetcher=fetcher;this.busy=false;this.pending=new Set();}
 async initialize(){for(const r of await this.store.all(this.recordKind))if(['queued','running'].includes(r.status)){r.status='uncertain';r.error='OPENAI_INTERRUPTED_NO_AUTOMATIC_RETRY';await this.store.put(this.recordKind,r);}}
 async config(){const c=await this.store.get('config',this.keyId);return {configured:!!c?.credentials,model:this.model,savedAt:c?.savedAt||null,pricing:this.pricing,maximumOutputTokens:6000,monthlyLimitUSD:null,note:'المفتاح محفوظ مشفراً ولا يعود إلى المتصفح. لا يوجد حد شهري للنص داخل التطبيق؛ كلفة النص مستقلة عن GPU. لا طلب مدفوع عند فتح الصفحة.'};}
 async save({key,monthlyLimitUSD}){
  const old=await this.store.get('config',this.keyId);
  let credentials=old?.credentials;
  if(key!==undefined&&key!==''){
   if(typeof key!=='string'||!/^sk-[A-Za-z0-9_-]{16,500}$/.test(key))throw Error('OPENAI_KEY_INVALID');
   let response;try{response=await this.fetcher(BASE+'/models/'+this.model,{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw Error('OPENAI_CONNECTION_FAILED');}
   if(!response.ok){await response.body?.cancel();throw Error(errorCode(response.status));}await response.body?.cancel();
   credentials=this.store.seal({key},this.keyId);
  }
  if(!credentials)throw Error('OPENAI_KEY_REQUIRED');
  await this.store.put('config',{id:this.keyId,credentials,savedAt:Date.now(),monthlyLimitUSD:null});await this.store.audit('openai_key_saved',this.keyId);return this.config();
 }
 async remove(){await this.store.delete('config',this.keyId);await this.store.audit('openai_key_unlinked',this.keyId);return this.config();}
 async submit(b){
  if(b.approvedTextCost!==true)throw Error('TEXT_COST_APPROVAL_REQUIRED');
  if(!safeId(b.requestId)||!safeId(b.projectId)||!['discuss','brief','outline','details'].includes(b.mode))throw Error('INVALID_DIRECTOR_REQUEST');
  if(!Array.isArray(b.messages)||!b.messages.length||b.messages.length>80||b.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>30000||Object.keys(m).some(k=>!['role','content'].includes(k))))throw Error('INVALID_DIRECTOR_REQUEST');
  const messages=b.messages.map(m=>({role:m.role,content:m.content})),instruction=typeof b.instruction==='string'?b.instruction:'';
  if(instruction.length>14000||Buffer.byteLength(JSON.stringify(messages))>96000)throw Error('DIRECTOR_CONTEXT_TOO_LONG');
  const signature=digest(JSON.stringify({projectId:b.projectId,mode:b.mode,messages,instruction})),old=await this.store.get(this.recordKind,b.requestId);
  if(old){if(old.signature!==signature)throw Error('TEXT_REQUEST_ID_CONFLICT');return this.public(old);}
  if(this.busy)throw Error('ONE_TEXT_REQUEST_AT_A_TIME');
  const c=await this.store.get('config',this.keyId);if(!c?.credentials)throw Error('OPENAI_KEY_REQUIRED');
  const maxTokens=b.mode==='discuss'?1600:Math.min(6000,Math.max(500,Math.floor(Number(b.maxTokens)||3500)));
  const estimatedMaxUSD=(Buffer.byteLength(MASTER+instruction+JSON.stringify(messages))*this.pricing.inputPerMillionUSD+maxTokens*this.pricing.outputPerMillionUSD)/1e6;
  const record={id:b.requestId,projectId:b.projectId,mode:b.mode,signature,status:'queued',createdAt:Date.now(),model:this.model,estimatedMaxUSD,pricing:this.pricing,invoiceUSD:null};
  await this.store.put(this.recordKind,record);this.busy=true;
  const task=this.run(record,{messages,instruction,maxTokens},c.credentials).finally(()=>{this.busy=false;this.pending.delete(task);});this.pending.add(task);return this.public(record);
 }
 public(record){const {signature,...safe}=record;return safe;}
 async get(id){if(!safeId(id))throw Error('INVALID_DIRECTOR_REQUEST');const r=await this.store.get(this.recordKind,id);if(!r)throw Error('TEXT_CALL_NOT_FOUND');return this.public(r);}
 async run(r,{messages,instruction,maxTokens},credentials){
  try{
   r.status='running';await this.store.put(this.recordKind,r);
   const previous=await this.store.get('director-discussion',r.projectId);
   const system=MASTER+'\nTask: '+r.mode+'\n'+instruction+'\nMaintain concise continuity_notes of agreed story, cast, props, dialect, permissions asserted (not verified), style and duration. Update notes with corrections; never invent missing facts.'+(previous?'\nPreviously proposed duration seconds: '+(previous.seconds??'unknown')+'\nPreviously saved story notes: '+String(previous.notes||'').slice(0,6000):'');
   const input=r.mode==='discuss'?messages:[{role:'user',content:'Return JSON only, matching the task instructions.'},...messages];
   const payload={model:this.model,store:false,instructions:system,input,max_output_tokens:maxTokens,reasoning:{effort:'none'},...(r.mode==='discuss'?{text:{format:{type:'json_schema',name:'director_discussion',strict:true,schema:DISCUSSION_SCHEMA}}}:r.mode==='brief'?{text:{format:{type:'json_object'}}}:r.mode==='outline'||r.mode==='details'?{text:{format:{type:'json_object'}}}:{})};
   let response;try{response=await this.fetcher(BASE+'/responses',{method:'POST',headers:{Authorization:'Bearer '+this.store.open(credentials,this.keyId).key,'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(90000)});}catch{throw Error('OPENAI_CONNECTION_UNCERTAIN_NO_RETRY');}
   if(!response.ok){r.failureDetails={httpStatus:response.status};try{const rejected=await limitedJSON(response);const safe=v=>typeof v==='string'&&/^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(v)?v:undefined;r.failureDetails.code=safe(rejected.error?.code);r.failureDetails.param=safe(rejected.error?.param);}catch{}throw Error(errorCode(response.status));}
   const data=await limitedJSON(response);
   if(data.usage){const input=Number(data.usage.input_tokens),output=Number(data.usage.output_tokens),cached=Math.max(0,Math.min(input,Number(data.usage.input_tokens_details?.cached_tokens)||0));if(Number.isFinite(input)&&Number.isFinite(output)&&input>=0&&output>=0)r.usage={inputTokens:input,cachedInputTokens:cached,outputTokens:output,computedUSD:((input-cached)*this.pricing.inputPerMillionUSD+cached*this.pricing.cachedInputPerMillionUSD+output*this.pricing.outputPerMillionUSD)/1e6,source:'Response usage × published text rates; not invoice',...(Number.isFinite(data.usage.cost)?{providerCostUSD:data.usage.cost}:{})};}
   if(data.status!=='completed')throw Error('OPENAI_INCOMPLETE_OUTPUT_NO_RETRY');
   const text=(data.output||[]).filter(o=>o.type==='message').flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('\n');if(!text.trim())throw Error('OPENAI_EMPTY_OR_REFUSED');
   r.text=text;
   if(r.mode==='discuss'){
    const d=JSON.parse(text);if(typeof d.reply!=='string'||d.reply.length>14000||!(d.proposed_duration_seconds===null||Number.isInteger(d.proposed_duration_seconds)&&d.proposed_duration_seconds>=10&&d.proposed_duration_seconds<=3600))throw Error('INVALID_DIRECTOR_RESPONSE');
    // A first-turn model flag alone cannot authorize full script writing.
    const lastUser=messages.filter(m=>m.role==='user').at(-1)?.content||'';
    const explicitWriting=/ابدأ|ابدا|اكتب|جهز|جهّز|start|write|تمام|موافق|اوكي/i.test(lastUser)&&!/(?:لا|مو|not|don't)\s*(?:تبدأ|تبدا|تكتب|ابدا|start|write)/i.test(lastUser);
    d.ready_to_write=!!d.ready_to_write&&explicitWriting&&!!previous?.seconds&&previous.seconds===d.proposed_duration_seconds;
    if(d.continuity_notes!==undefined&&(typeof d.continuity_notes!=='string'||d.continuity_notes.length>6000))throw Error('INVALID_DIRECTOR_RESPONSE');
    r.discussion=d;await this.store.put('director-discussion',{id:r.projectId,seconds:d.proposed_duration_seconds,style:d.style,notes:d.continuity_notes||previous?.notes||'',updatedAt:Date.now()});
   }
   r.status='completed';
  }catch(e){r.status=/UNCERTAIN|INTERRUPTED/.test(e.message)?'uncertain':'failed';r.error=/^OPENAI_|^INVALID_DIRECTOR_RESPONSE$/.test(e.message)?e.message:'OPENAI_RESPONSE_VALIDATION_FAILED';delete r.text;}
  r.finishedAt=Date.now();await this.store.put(this.recordKind,r);await this.store.audit('openai_text_'+r.status,r.id);
 }
}
