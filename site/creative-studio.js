/* Shared administrator library. Descriptions are not advertised as visual/voice cloning. */
(function(root){
 'use strict';let library={revision:0,characters:[],props:[]},loaded=false,sceneInputs=null;
 const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
 const field=(box,label,value='',max=700)=>{const wrap=el('label',label),input=el('input');input.value=value;input.maxLength=max;wrap.append(input);box.append(wrap);return input;};
 const option=(select,value,text)=>{const n=el('option',text);n.value=value;select.append(n);};
 function selectCharacter(box,label,value=''){
  const wrap=el('label',label),select=el('select');option(select,'','غير محدد');for(const c of library.characters)option(select,c.id,c.name);select.value=value;wrap.append(select);box.append(wrap);return select;
 }
 function dialogueOf(slot){return slot.audioContract?.lines?.map(l=>l.text)||slot.dialogue||Array.from((slot.sourceEvents?.join('\n')||slot.prompt||'').matchAll(/«([^»]+)»|"([^"\n]+)"/gu),m=>m[1]||m[2]);}
 function scene(slot,prompt=""){ if(document.getElementById("creativeStudio")?.hidden&&!slot?.creativeScene)return undefined;
  if(!loaded)throw Error('انتظر تحميل مكتبة الشخصيات أو سجّل دخول المسؤول.');
  if(!library.characters.length&&!library.props.length)return undefined;
  if(slot){
   const turns=slot.creativeScene?.turns||[];
   if(dialogueOf(slot).length&&turns.length!==dialogueOf(slot).length)throw Error('حدد المتحدث لكل جملة من خيارات المشهد قبل التوليد.');
   return slot.creativeScene||{characterIds:[],propIds:[],turns:[]};
  }
  if(!sceneInputs)return undefined;
  const quoted=[...new Set(Array.from(prompt.matchAll(/«([^»]+)»|"([^"\n]+)"/gu),m=>m[1]||m[2]))];if(!sceneInputs.text.value.trim()&&quoted.length>1)throw Error('حدد الجملة المنطوقة وصاحبها في إعدادات المشهد.');const text=sceneInputs.text.value.trim()||(quoted.length===1?quoted[0]:''),speaker=sceneInputs.speaker.value,listener=sceneInputs.listener.value;
  if(text&&!speaker)throw Error('حدد صاحب الجملة المنطوقة قبل التوليد.');
  return {characterIds:[...new Set([speaker,listener].filter(Boolean))],propIds:[...sceneInputs.props.selectedOptions].map(o=>o.value),turns:text?[{speakerId:speaker,listenerIds:listener?[listener]:[],text}]:[]};
 }
 function sceneEditor(box,slot,save,locked=false){
  if(!loaded||!library.characters.length&&!library.props.length)return;
  const panel=el('fieldset'),legend=el('legend','المتحدث والأغراض في هذا المشهد');panel.append(legend);panel.disabled=locked||!!slot.jobId;panel.className='creative-scene';
  const current=slot.creativeScene||{},rows=[];
  for(const [i,line] of dialogueOf(slot).entries()){
   const row=el('div');row.className='creative-turn';row.append(el('p','الجملة: '+line));
   const explicit=library.characters.filter(c=>slot.speaker?.startsWith(c.name));
   const speaker=selectCharacter(row,'من يقولها؟',current.turns?.[i]?.speakerId||(explicit.length===1?explicit[0].id:''));
   const listener=selectCharacter(row,'إلى من؟ يبقى صامتاً',current.turns?.[i]?.listenerIds?.[0]||'');rows.push({line,speaker,listener});panel.append(row);
  }
  const propLabel=el('label','الأغراض المطلوبة فقط'),props=el('select');props.multiple=true;
  for(const p of library.props){option(props,p.id,p.name);props.lastChild.selected=(current.propIds||[]).includes(p.id);}propLabel.append(props);panel.append(propLabel);
  function read(){const turns=rows.filter(r=>r.speaker.value).map(r=>({speakerId:r.speaker.value,listenerIds:r.listener.value?[r.listener.value]:[],text:r.line}));slot.creativeScene={characterIds:[...new Set(turns.flatMap(t=>[t.speakerId,...t.listenerIds]))],propIds:[...props.selectedOptions].map(o=>o.value),turns};}
  for(const r of rows)for(const s of [r.speaker,r.listener])s.onchange=()=>{read();save();};props.onchange=()=>{read();save();};
  if(!slot.creativeScene&&rows.every(r=>r.speaker.value))read();box.append(panel);
 }
 root.CreativeStudio={scene,sceneEditor,get library(){return library;}};
 const mount=document.getElementById('creativeStudio');if(!mount)return;
 const header=el('summary','مكتبة الشخصيات والأصوات والأغراض — مشتركة بكل النظام');mount.append(header);
 const status=el('p','تحميل المكتبة يتطلب دخول المسؤول.'),cards=el('div'),buttons=el('div');mount.append(status,cards,buttons);
 const note=el('p','المراجع محفوظة على خادمنا ومستقلة عن حساب Modal. الربط الحالي بالأوصاف والمتحدثين؛ تكييف صور متعددة واستنساخ الأصوات غير مفعّلين قبل تجهيز LoRA واختبارهما.');note.className='note';mount.append(note);
 let draft=[];
 function card(entry,kind){
  const box=el('fieldset');box.className='creative-card';box.append(el('legend',kind==='character'?'شخصية وصوتها':'غرض ثابت'));
  const name=field(box,'الاسم',entry.name,100),description=field(box,kind==='character'?'الشكل والملابس':'الشكل والحجم والمادة',entry.description);
  const voice=kind==='character'?field(box,'وصف الصوت الطبيعي (ليس استنساخاً)',entry.voice,400):null;
  const dialect=kind==='character'?field(box,'اللهجة، مثل عراقي بغدادي أو فصحى',entry.dialect||'حسب القصة',100):null;
  const fileLabel=el('label','صورة مرجعية اختيارية — للحفظ والتحضير'),file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';fileLabel.append(file);box.append(fileLabel);
  let referenceId=entry.referenceId;
  if(referenceId)box.append(el('small','الصورة محفوظة؛ لا يعني ذلك تطبيق Ingredients على GPU.'));
  file.onchange=async()=>{
   try{const source=file.files?.[0];if(!source)return;if(source.size>4000000)throw Error('الصورة أكبر من 4MB.');
    const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(source);});
    await root.EngineAPI.session();const result=await root.EngineAPI.request('creative/reference',{assetId:crypto.randomUUID(),name:name.value||'مرجع',data});referenceId=result.id;status.textContent='حُفظت الصورة؛ اضغط حفظ المكتبة لربطها بالشخصية أو الغرض.';
   }catch(e){status.textContent=e.message;}
  };
  const remove=el('button','إزالة من هذه القائمة');remove.type='button';remove.onclick=()=>{draft=draft.filter(r=>r.box!==box);box.remove();};box.append(remove);cards.append(box);
  draft.push({box,kind,read:()=>({id:entry.id,name:name.value,description:description.value,...(voice?{voice:voice.value,dialect:dialect.value}:{}),...(referenceId?{referenceId}:{})})});
 }
 function render(){cards.replaceChildren();draft=[];for(const c of library.characters)card(c,'character');for(const p of library.props)card(p,'prop');}
 function button(label,fn){const b=el('button',label);b.type='button';b.onclick=fn;buttons.append(b);return b;}
 async function load(){try{await root.EngineAPI.session();const r=await root.EngineAPI.request('creative/library');library=r.library;loaded=true;render();status.textContent='المكتبة متصلة بالخادم؛ لا تشغيل GPU عند فتحها.';root.dispatchEvent(new Event('creative-library-loaded'));}catch(e){status.textContent=e.message;}}
 button('تحميل المكتبة',load);button('إضافة شخصية',()=>card({id:crypto.randomUUID(),name:'',description:''},'character'));button('إضافة غرض',()=>card({id:crypto.randomUUID(),name:'',description:''},'prop'));
 button('عرض خطة تفعيل المراجع المتعددة',async()=>{try{await root.EngineAPI.session();const p=await root.EngineAPI.request('creative/ingredients-plan');status.textContent='Ingredients غير مفعّل: يلزم محول استدلال واختبار مستقل وموافقة ترخيص. الملف الإضافي '+(p.bytes/2**30).toFixed(2)+'GiB، التخزين المرجعي $'+p.estimatedStorageUSDPerMonth.toFixed(2)+' بالشهر للحساب قبل الإعفاءات؛ كلفة التحميل واختبار GPU منفصلة. لم يبدأ تنزيل أو تشغيل، والأوزان الأساسية لا تحتاج إعادة تنزيل.';}catch(e){status.textContent=e.message;}});
 button('حفظ المكتبة',async()=>{try{await root.EngineAPI.session();const value={revision:library.revision,characters:draft.filter(d=>d.kind==='character').map(d=>d.read()),props:draft.filter(d=>d.kind==='prop').map(d=>d.read())};library=(await root.EngineAPI.request('creative/library',value)).library;loaded=true;render();status.textContent='حُفظت المكتبة؛ اختر المتحدث والغرض في المشاهد الجديدة. النتائج المكتملة لا تتغير.';root.dispatchEvent(new Event('creative-library-loaded'));}catch(e){status.textContent=e.message;}});
 if(location.pathname.endsWith('/engines.html')){
  const panel=el('fieldset');panel.append(el('legend','إسناد حوار المشهد القادم'));const speaker=selectCharacter(panel,'المتحدث'),listener=selectCharacter(panel,'المستمع');
  const textLabel=el('label','الجملة المنطوقة حرفياً'),text=el('textarea');text.maxLength=500;textLabel.append(text);panel.append(textLabel);const props=el('select');props.multiple=true;panel.append(el('p','الأغراض المختارة'),props);mount.append(panel);
  sceneInputs={speaker,listener,text,props};root.addEventListener('creative-library-loaded',()=>{for(const s of [speaker,listener]){s.replaceChildren();option(s,'','غير محدد');for(const c of library.characters)option(s,c.id,c.name);}props.replaceChildren();for(const p of library.props)option(props,p.id,p.name);});
 }
 load();
})(window);
