import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'runtime/source-manifest.json'),'utf8'));
export const GPUS=Object.freeze({'RTX-PRO-6000':{name:'NVIDIA RTX PRO 6000 Blackwell',vram:96,rate:.000842},L40S:{name:'NVIDIA L40S',vram:48,rate:.000542}});
export const PRICING={url:'https://modal.com/pricing',checked:'2026-10-27',cpu:.0000131,ram:.00000222,storageGiBMonth:.09};
export function settings(value={}) {
 const s={gpu:value.gpu??'RTX-PRO-6000',cpu:Number(value.cpu??4),ram:Number(value.ram??96),timeout:Number(value.timeout??600),startup:Number(value.startup??180),idleSeconds:Number(value.idleSeconds??1200),budget:Number(value.budget??3),seed:Number(value.seed??42)};
 if(!Object.hasOwn(GPUS,s.gpu)||![4,8].includes(s.cpu)||![64,96,128].includes(s.ram)||!Number.isInteger(s.timeout)||(s.timeout!==0&&(s.timeout<180||s.timeout>1500))||!Number.isInteger(s.startup)||(s.startup!==0&&(s.startup<120||s.startup>600))||![15,30,60,1200].includes(s.idleSeconds)||!Number.isFinite(s.budget)||s.budget<0||s.budget>100||!Number.isSafeInteger(s.seed)||s.seed<0||s.seed>2147483647)throw Error('INVALID_SETTINGS');
 const orientation=value.orientation??'portrait';
 if(!['portrait','landscape'].includes(orientation))throw Error('INVALID_ORIENTATION');
 return {...s,ramLimit:s.ram,orientation};
}
export function runtimeLimits(s){const timeout=s.timeout||86400;return {timeout,startup:s.startup||timeout};}
export function estimate(s) {
 const rate=GPUS[s.gpu].rate+s.cpu*PRICING.cpu+s.ramLimit*PRICING.ram;
 const idle=s.idleSeconds??60;
 const manual=s.timeout===0||s.startup===0;
 const windowSeconds=manual?null:s.timeout+s.startup+idle;
 return {rate,expectedSeconds:null,windowSeconds,resourceWindowUSD:windowSeconds===null?null:rate*windowSeconds,manualControl:manual,recordedUSD:null,pricing:PRICING,note:manual?'المتابعة والإيقاف يدويان؛ لا يوجد حد مالي للمهمة عندما يكون budget=0. المدة والكلفة النهائية غير معروفتين مسبقاً. تبقى مهلة Modal التقنية والإيقاف للخمول.':'تقدير محافظ يحتسب حد RAM الأقصى وCPU المحدد، ويشمل انتظار الخمول المحدود. ليس سقف فاتورة؛ البناء والتخزين والنقل قد تُضاف.'};
}
export const quality={model:'LTX-2.5 Distilled',revision:manifest.model_revision,source:manifest.source_commit,width:720,height:1280,nativeWidth:768,nativeHeight:1280,output:'720p',contract:'ltx25-dfr-diffvae-720-v1',pipeline:'DFRPipeline',videoDecoder:'Diffusion VAE',textQualityRequired:true,seconds:10,frames:241,fps:24,convVAE:false,nativeAudio:true,offload:'cpu',fp8:'cast; BF16 compute',steps:[8,3],note:'Native inference uses 64-aligned dimensions; final MP4 is center-cropped to exact 720p without stretching/upscaling. Higher-resolution GPU memory/performance remain unverified.'};
export const qualityFor=s=>({...quality,width:s.orientation==='landscape'?1280:720,height:s.orientation==='landscape'?720:1280,nativeWidth:s.orientation==='landscape'?1280:768,nativeHeight:s.orientation==='landscape'?768:1280});
export function fixedEngineSettings(value={}){return settings({...value,gpu:'RTX-PRO-6000',cpu:4,ram:96});}
export function sameEngineSettings(a,b){const {orientation:ao,...av}=settings(a),{orientation:bo,...bv}=settings(b);return JSON.stringify(av)===JSON.stringify(bv);}
