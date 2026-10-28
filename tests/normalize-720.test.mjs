import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('legacy 768 output normalizes to 720 locally, preserves source/audio and never calls a provider',async()=>{
 let inspected=0;const calls=[],deleted=[];class FFmpeg{async load(){}async writeFile(name,data){calls.push({name,bytes:data.length});}async exec(args){calls.push(args);return 0;}async readFile(){return new Uint8Array(2048);}async deleteFile(name){deleted.push(name);}}
 const window={FFmpegWASM:{FFmpeg},document:{createElement(tag){assert.equal(tag,'video');const v={duration:10,videoWidth:inspected++?720:768,videoHeight:inspected===1?1366:1280};Object.defineProperty(v,'src',{set(){queueMicrotask(()=>v.onloadedmetadata());}});return v;}}};
 const scope={window,document:window.document,Blob,URL,Uint8Array,TextEncoder,fetch:async url=>{assert.match(url,/^https:\/\/cdn.jsdelivr.net\/npm\/@ffmpeg\//);return new Response('fixture bytes');},setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout};
 vm.runInNewContext(fs.readFileSync('site/stitcher.js','utf8'),scope);
 const original=new Blob(['immutable provider source']),result=await window.IraqiFilmStitcher.normalize720(original,'9:16');
 assert.equal(await original.text(),'immutable provider source');assert.equal(result.type,'video/mp4');const args=calls.find(Array.isArray);assert.ok(args);assert.equal(args[args.indexOf('-c:a')+1],'copy');assert.equal(args[args.indexOf('-map')+1],'0:v:0');assert.ok(args.includes('0:a:0'));assert.match(args[args.indexOf('-vf')+1],/scale=720:1280/);assert.equal(deleted.length,2);
});
test('normalizer rejects lower-resolution source before downloading or executing FFmpeg',async()=>{
 let fetched=false;const document={createElement(){const v={duration:10,videoWidth:576,videoHeight:1024};Object.defineProperty(v,'src',{set(){queueMicrotask(()=>v.onloadedmetadata());}});return v;}};
 const scope={window:{document},document,Blob,URL,Uint8Array,TextEncoder,setTimeout,clearTimeout,fetch:async()=>{fetched=true;throw Error('forbidden');}};vm.runInNewContext(fs.readFileSync('site/stitcher.js','utf8'),scope);
 await assert.rejects(()=>scope.window.IraqiFilmStitcher.normalize720(new Blob(['saved old video'])),/أقل من720p/);assert.equal(fetched,false);
});
