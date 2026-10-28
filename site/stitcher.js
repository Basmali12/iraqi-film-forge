/* Iraqi Film Forge local video stitcher.
 * Browser-only FFmpeg.wasm; no video uploads, no external provider calls.
 * Based on ffmpegwasm/ffmpeg.wasm MIT / discussion #580.
 */
"use strict";
(function(global){
  const CDN="https://cdn.jsdelivr.net/npm";
  const FFMPEG=CDN+"/@ffmpeg/ffmpeg@0.12.6/dist/umd";
  const CORE=CDN+"/@ffmpeg/core@0.12.3/dist/umd";
  let loader=null;
  const resources=[];
  const clean=()=>{
    for(const url of resources)URL.revokeObjectURL(url);
    resources.length=0;
  };
  async function getBlobURL(url,type,patch){
    const res=await fetch(url,{mode:"cors",cache:"force-cache"});
    if(!res.ok)throw Error("فشل تحميل مكتبة الدمج: HTTP "+res.status);
    const source=patch?patch(await res.text()):await res.blob();
    const blob=source instanceof Blob?source:new Blob([source],{type});
    const objectURL=URL.createObjectURL(blob);resources.push(objectURL);
    return objectURL;
  }
  async function loadEngine(report){
    if(loader)return loader;
    loader=(async()=>{
      if(!global.FFmpegWASM){
        report("تحميل محرّك الدمج للمتصفح لأول مرة… (حوالي 30 ميگابايت)");
        const main=await getBlobURL(FFMPEG+"/ffmpeg.js","text/javascript",source=>{
          const needle="new URL(e.p+e.u(814),e.b)";
          if(!source.includes(needle))throw Error("نسخة FFmpeg تغيرت، لا يمكن تأمين تشغيل العامل.");
          return source.replace(needle,"r.workerLoadURL");
        });
        await new Promise((resolve,reject)=>{
          const s=document.createElement("script");s.src=main;
          s.onload=()=>{s.remove();resolve()};
          s.onerror=()=>{s.remove();reject(Error("فشل تحميل سكربت الدمج"))};
          document.head.appendChild(s);
        });
      }
      if(!global.FFmpegWASM||!global.FFmpegWASM.FFmpeg)throw Error("مكتبة FFmpeg غير جاهزة");
      const ffmpeg=new global.FFmpegWASM.FFmpeg();
      report("تنزيل محرك الصوت والصورة وضبطه…");
      const [workerLoadURL,coreURL,wasmURL]=await Promise.all([
        getBlobURL(FFMPEG+"/814.ffmpeg.js","text/javascript"),
        getBlobURL(CORE+"/ffmpeg-core.js","text/javascript"),
        getBlobURL(CORE+"/ffmpeg-core.wasm","application/wasm")
      ]);
      await Promise.race([
        ffmpeg.load({workerLoadURL,coreURL,wasmURL}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error("انتهت مهلة تهيئة محرّك الدمج")),80000))
      ]);
      return ffmpeg;
    })().catch(e=>{loader=null;clean();throw e});
    return loader;
  }
  async function inspect(blob){
    if(!(blob instanceof Blob)||blob.size===0)throw Error("ملف فيديو فارغ");
    const u=URL.createObjectURL(blob);
    try{
      const video=document.createElement("video");
      video.muted=true;video.preload="metadata";video.playsInline=true;
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error("انتهت مهلة قراءة بيانات الفيديو")),17000);
        video.onloadedmetadata=()=>{
          clearTimeout(timer);
          if(!Number.isFinite(video.duration)||video.duration<=0||!video.videoWidth||!video.videoHeight)
            return reject(Error("تعذر قراءة المدة أو الدقة"));
          resolve({duration:video.duration,width:video.videoWidth,height:video.videoHeight});
        };
        video.onerror=()=>{clearTimeout(timer);reject(Error("الفيديو غير قابل للقراءة"))};
        video.src=u;
      });
    }finally{URL.revokeObjectURL(u)}
  }
  async function merge(blobs,mode="cut",onStatus=()=>{}){
    if(!Array.isArray(blobs)||blobs.length<2)throw Error("يجب توفر مقطعين على الأقل");
    if(blobs.length>12)throw Error("لدمج أكثر من 12 مقطعاً استخدم محرّك FFmpeg في الخادم");
    const size=blobs.reduce((sum,b)=>sum+b.size,0);
    if(size>140*1024*1024)throw Error("ملفات كبيرة على الهاتف. استخدم الدمج عبر الخادم");
    onStatus("فحص طول ودقة المقاطع");
    const info=await Promise.all(blobs.map(inspect));
    if(info.some(i=>i.width!==info[0].width||i.height!==info[0].height))
      throw Error("دقة المقاطع مختلفة. وحّد الدقة أو ادمجها على الخادم");
    const ffmpeg=await loadEngine(onStatus);
    const inputNames=blobs.map((_,i)=>"clip_"+i+".mp4");
    const tempFiles=[...inputNames,"clips.ffconcat","joined.mp4"];
    try{
      onStatus("نسخ المقاطع إلى محرّك الدمج…");
      for(let i=0;i<blobs.length;i++){
        await ffmpeg.writeFile(inputNames[i],new Uint8Array(await blobs[i].arrayBuffer()));
      }
      let args;
      if(mode==="smooth"){
        // Same fractional transition for picture and sound, eliminating A/V drift.
        // This path re-encodes and can be much slower on a mobile phone.
        const d=0.20,filters=[];
        for(let i=0;i<blobs.length;i++){
          filters.push("["+i+":v:0]fps=24,scale="+info[0].width+":"+info[0].height+
            ",format=yuv420p[v"+i+"]");
          filters.push("["+i+":a:0]aresample=48000,asetpts=PTS-STARTPTS[a"+i+"]");
        }
        let previousVideo="v0",previousAudio="a0",timeline=info[0].duration;
        for(let i=1;i<blobs.length;i++){
          const v="t"+i,a="s"+i,offset=Math.max(.1,timeline-d);
          filters.push("["+previousVideo+"][v"+i+"]xfade=transition=fade:duration="+d+":offset="+offset.toFixed(4)+"["+v+"]");
          filters.push("["+previousAudio+"][a"+i+"]acrossfade=d="+d+":c1=tri:c2=tri["+a+"]");
          previousVideo=v;previousAudio=a;
          timeline+=info[i].duration-d;
        }
        args=["-hide_banner","-loglevel","error"];
        inputNames.forEach(n=>args.push("-i",n));
        args.push("-filter_complex",filters.join(";"),"-map","["+previousVideo+"]","-map","["+previousAudio+"]",
          "-c:v","libx264","-preset","ultrafast","-crf","24","-pix_fmt","yuv420p",
          "-c:a","aac","-b:a","128k","-movflags","frag_keyframe+empty_moov+default_base_moof","joined.mp4");
      }else{
        const list="ffconcat version 1.0\n"+inputNames.map(n=>"file '"+n+"'").join("\n")+"\n";
        await ffmpeg.writeFile("clips.ffconcat",new TextEncoder().encode(list));
        args=["-hide_banner","-loglevel","error","-f","concat","-safe","0","-i","clips.ffconcat",
          "-map","0:v:0","-map","0:a:0?","-c","copy",
          "-movflags","frag_keyframe+empty_moov+default_base_moof","joined.mp4"];
      }
      onStatus(mode==="smooth"?"الدمج الناعم جارٍ مع الحفاظ على الصوت…":"وصل المقاطع والصوت بدون إعادة توليد…");
      const code=await ffmpeg.exec(args,mode==="smooth"?240000:120000);
      if(code!==0)throw Error("محرك الدمج رفض المقاطع ("+code+")");
      const result=await ffmpeg.readFile("joined.mp4");
      if(!result||result.byteLength<1024)throw Error("ملف الدمج غير صالح");
      const data=new Uint8Array(result);
      const blob=new Blob([data],{type:"video/mp4"});
      onStatus("جارٍ التحقق من ملف MP4 الموحد…");
      const meta=await inspect(blob);
      const expected=info.reduce((a,b)=>a+b.duration,0)-(mode==="smooth"?.20*(blobs.length-1):0);
      if(Math.abs(meta.duration-expected)>Math.max(2,info.length*.25))
        throw Error("طول الفيديو المدموج غير مطابق: "+meta.duration.toFixed(1)+" ثانية");
      return {blob,duration:meta.duration,segments:blobs.length,mode};
    }finally{
      for(const filename of tempFiles){try{await ffmpeg.deleteFile(filename)}catch{}}
    }
  }
  async function normalize720(blob,ratio='9:16',report=()=>{}){
    const target=ratio==='16:9'?{width:1280,height:720}:{width:720,height:1280},before=await inspect(blob);
    if(before.width===target.width&&before.height===target.height)return blob;
    if(before.width<target.width||before.height<target.height)throw Error('المصدر أقل من720p؛ لا نرفع دقة وهمية ولا نعدّل الأصل.');
    if(blob.size>140*1024*1024)throw Error('الفيديو كبير على ذاكرة المتصفح؛ المصدر محفوظ.');
    const ffmpeg=await loadEngine(report),input='normalize-source.mp4',output='normalize-720.mp4';
    try{
      await ffmpeg.writeFile(input,new Uint8Array(await blob.arrayBuffer()));report('تهيئة نسخة720p على CPU المتصفح؛ الأصل والصوت محفوظان.');
      const filter='scale='+target.width+':'+target.height+':force_original_aspect_ratio=increase,crop='+target.width+':'+target.height+',setsar=1';
      const code=await ffmpeg.exec(['-hide_banner','-loglevel','error','-i',input,'-map','0:v:0','-map','0:a:0','-vf',filter,'-c:v','libx264','-preset','ultrafast','-crf','20','-pix_fmt','yuv420p','-c:a','copy','-movflags','frag_keyframe+empty_moov+default_base_moof',output],240000);
      if(code!==0)throw Error('تعذر توحيد720p؛ فيديو المزود ناجح والأصل محفوظ.');
      const data=await ffmpeg.readFile(output);if(data.byteLength<1024)throw Error('ملف720p غير صالح؛ الأصل محفوظ.');
      const normalized=new Blob([new Uint8Array(data)],{type:'video/mp4'}),after=await inspect(normalized);
      if(after.width!==target.width||after.height!==target.height||Math.abs(after.duration-before.duration)>.1)throw Error('فشل التحقق من نسخة720p؛ الأصل محفوظ.');
      return normalized;
    }finally{for(const name of [input,output])try{await ffmpeg.deleteFile(name);}catch{}}
  }
  global.IraqiFilmStitcher={merge,inspect,normalize720};
})(window);
