// Account-independent character/prop metadata; no provider calls or model loading.
const ID=/^[a-zA-Z0-9_-]{1,80}$/;
const text=(v,n)=>{if(typeof v!=='string'||v.length>n)throw Error('INVALID_CREATIVE_LIBRARY');return v.trim();};
export const emptyLibrary=()=>({id:'creative-library',revision:0,characters:[],props:[]});
export function validateLibrary(input){
 if(!input||!Number.isSafeInteger(input.revision)||input.revision<0)throw Error('INVALID_CREATIVE_LIBRARY');
 const used=new Set();
 function entries(items,kind){
  if(!Array.isArray(items)||items.length>24)throw Error('INVALID_CREATIVE_LIBRARY');
  return items.map(v=>{
   if(!v||!ID.test(v.id)||used.has(v.id))throw Error('INVALID_CREATIVE_LIBRARY');used.add(v.id);
   const entry={id:v.id,name:text(v.name,100),description:text(v.description||'',700)};
   if(!entry.name)throw Error('INVALID_CREATIVE_LIBRARY');
   if(kind==='character'){entry.voice=text(v.voice||'',400);entry.dialect=text(v.dialect||'as-written',100);}
   if(v.referenceId!==undefined){if(!/^[a-f0-9]{64}$/.test(v.referenceId))throw Error('INVALID_CREATIVE_LIBRARY');entry.referenceId=v.referenceId;}
   return entry;
  });
 }
 return {id:'creative-library',revision:input.revision,characters:entries(input.characters,'character'),props:entries(input.props,'prop')};
}
export function compileScene(library,value){
 if(value===undefined||value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CREATIVE_SCENE');
 if(value.referenceMode&&value.referenceMode!=='descriptions')throw Error('INGREDIENTS_INFERENCE_NOT_CONFIGURED');
 const chars=new Map(library.characters.map(c=>[c.id,c])),props=new Map(library.props.map(c=>[c.id,c]));
 const checkIds=(list,map)=>{if(!Array.isArray(list)||list.length>8||new Set(list).size!==list.length||list.some(id=>!map.has(id)))throw Error('UNKNOWN_CREATIVE_ENTITY');return list;};
 const visible=checkIds(value.characterIds||[],chars),propIds=checkIds(value.propIds||[],props),turns=value.turns||[];
 if(!Array.isArray(turns)||turns.length>6)throw Error('INVALID_CREATIVE_SCENE');
 const lines=turns.map((t,index)=>{
  if(!t||!chars.has(t.speakerId)||!visible.includes(t.speakerId))throw Error('SPEAKER_NOT_IN_SCENE');
  const listeners=checkIds(t.listenerIds||[],chars);if(listeners.some(id=>id===t.speakerId||!visible.includes(id)))throw Error('INVALID_LISTENER');
  const line=text(t.text,500);if(!line)throw Error('DIALOGUE_TEXT_REQUIRED');
  if(t.replyTo!==undefined&&(!Number.isInteger(t.replyTo)||t.replyTo<0||t.replyTo>=index||turns[t.replyTo].speakerId===t.speakerId))throw Error('DIALOGUE_REPLY_REQUIRES_OTHER_SPEAKER');
  return {speakerId:t.speakerId,listenerIds:listeners,text:line,...(t.replyTo!==undefined?{replyTo:t.replyTo}:{})};
 });
 const snapshot={libraryRevision:library.revision,referenceMode:'descriptions',characters:visible.map(id=>chars.get(id)),props:propIds.map(id=>props.get(id)),turns:lines,
  visualConditioning:'descriptions only; multi-image Ingredients conditioning is not active',voiceConditioning:'descriptions only; no voice cloning or external TTS'};
 const directions=['Scene cast and dialogue contract. These directions are never rendered as text or read aloud.',
  'Only these selected characters are required in this scene: '+(snapshot.characters.map(c=>c.name+': '+c.description+'; voice: '+c.voice+'; dialect: '+c.dialect).join(' | ')||'only those explicitly in the authored action'),
  ...snapshot.props.map(p=>'Keep this prop unchanged across the action: '+p.name+' — '+p.description),
  ...(lines.length?['Use exactly the following speaker assignment, overriding ambiguous pronouns in the authored scene:']:[]),
  ...lines.map((t,i)=>{const c=chars.get(t.speakerId);return 'Turn '+(i+1)+': '+c.name+' ('+c.description+') alone speaks '+JSON.stringify(t.text)+'. '+t.listenerIds.map(id=>chars.get(id).name).join(', ')+' listens silently. Keep other mouths still.';}),
  'Preserve the supplied cause-before-reaction sequence. Distinct actors never exchange voices, clothing or lines.'];
 return {snapshot,directions:directions.join('\n')};
}
