/* Free chronological splitter, not an LLM. Never invents missing story events. */
(function(root){
 function beats(text){
  const result=[];let part='',quote=null;
  for(const char of text){
   part+=char;
   if(char==='«')quote='»';else if(char==='"')quote=quote==='"'?null:'"';else if(char===quote)quote=null;
   if(!quote&&/[\n.!؟]/u.test(char)){if(part.trim())result.push(part.trim());part='';}
  }
  if(part.trim())result.push(part.trim());return result;
 }
 function create(story,seconds,options={}){
  story=String(story||'').trim();seconds=Number(seconds);
  if(story.length<(seconds===10?8:80)||story.length>24000)throw Error('اكتب القصة الكاملة من 80 إلى 24000 حرف. التقسيم المحلي لا يخترع قصة من جملة.');
  if(!Number.isInteger(seconds)||seconds<10||seconds>3600||seconds%10)throw Error('مدة فيلم Modal من 10 إلى 3600 ثانية بمضاعفات 10.');
  const items=beats(story),count=seconds/10;
  if(items.length<count)throw Error('المدة تحتاج '+count+' أحداث أو جمل متسلسلة على الأقل؛ الموجود '+items.length+'. أضف تفاصيل القصة أو قلل المدة. لا نكرر الأحداث لملء الوقت.');
  const cast=String(options.cast||'').trim();if(cast.length>2000)throw Error('وصف الشخصيات طويل جداً.');
  const scenes=[];
  for(let i=0;i<count;i++){
   const from=Math.floor(i*items.length/count),to=Math.floor((i+1)*items.length/count),current=items.slice(from,to).join('\n');
   const speaker=current.match(/(?:المتحدث|المتكلّم|المتكلم)\s*:\s*([^؛|«"\n]{1,150})/u)?.[1]?.trim()||null;
   const dialogue=Array.from(current.matchAll(/«([^»]+)»|"([^"\n]+)"/gu),m=>m[1]||m[2]);
   const audioContract=speaker&&dialogue.length?{language:'ar',dialect:'iraqi',mode:'dialogue',lines:dialogue.map(text=>({speaker,text}))}:null;
   const prompt=['Generate exactly this next 10-second scene, with native LTX sound; use only the separately locked Arabic dialogue, never improvise words.',
    'Continue from the provided first-frame image when present. Preserve the visible characters, wardrobe, lighting and spatial layout. Do not replay the opening or completed events.',
    cast?'Fixed cast/voice directions (not a guarantee): '+cast:'Keep the characters and voice traits already established by the story and previous clip.',
    'Current story events, in order; action before reaction:\n'+current,
    speaker?'Only '+speaker+' speaks the quoted dialogue in this scene; frame that specific speaker clearly. All other people listen silently with still mouths.':'Do not guess speaker ownership. Name the speaking person and appearance explicitly for each line; introduce only people involved in this event.',
    'Clear natural foreground speech in the requested Arabic dialect, with quiet ambience below it and realistic human prosody. Clean unlettered image; dialogue is audible only, never rendered as text.',
    'Speak only the dialogue explicitly written for this scene, in its requested Arabic dialect. Do not read technical directions or invent repeated speech. No subtitles, captions or generated lettering.',
    'Reach the outcome of these events, then stop; subsequent events belong to the next scene.'].join('\n');
   if(prompt.length>12000)throw Error('أحد الأحداث طويل جداً لمشهد واحد. قسمه إلى جمل أو أحداث أقصر.');
   scenes.push({id:'S'+String(i+1).padStart(3,'0'),index:i+1,start:i*10,end:(i+1)*10,duration:10,prompt,audioContract,speaker,dialogue,qualityWarnings:dialogue.length&&!speaker?['الحوار يحتاج تحديد المتحدث صراحةً لتقليل تبديل الأصوات.']:[],sourceEvents:items.slice(from,to),status:'pending',jobId:null,cost:null});
  }
  return {scenes,title:story.split('\n')[0].slice(0,80),synopsis:'تقسيم محلي مرتب للنص الأصلي؛ راجع كل مشهد وحواره. لا يوجد توليد قصة أو تصنيف شخصيات بذكاء خارجي.',
   plan:{videoProvider:'modal',preparedAt:options.now??Date.now(),duration_seconds:seconds,slots:scenes,continuity:'last frame image conditioning; separate native-audio clips'},timelineVerified:true};
 }
 root.FilmModalPlan={create,beats};
})(window);
