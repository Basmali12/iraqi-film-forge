import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'runtime/source-manifest.json'),'utf8'));
export const GPUS=Object.freeze({'RTX-PRO-6000':{name:'NVIDIA RTX PRO 6000 Blackwell',vram:96,rate:.000842},L40S:{name:'NVIDIA L40S',vram:48,rate:.000542}});
export const PRICING={url:'https://modal.com/pricing',checked:'2026-10-27',cpu:.0000131,ram:.00000222,storageGiBMonth:.09};
export function settings(value={}) {
 const s={gpu:value.gpu??'RTX-PRO-6000',cpu:Number(value.cpu??4),ram:Number(value.ram??64),timeout:Number(value.timeout??600),startup:Number(value.startup??180),budget:Number(value.budget??1),seed:Number(value.seed??42)};
 if(!Object.hasOwn(GPUS,s.gpu)||![4,8].includes(s.cpu)||![64,96,128].includes(s.ram)||!Number.isInteger(s.timeout)||s.timeout<180||s.timeout>1500||!Number.isInteger(s.startup)||s.startup<120||s.startup>600||!Number.isFinite(s.budget)||s.budget<=0||s.budget>100||!Number.isSafeInteger(s.seed)||s.seed<0||s.seed>2147483647)throw Error('INVALID_SETTINGS');
 return {...s,ramLimit:s.ram*2};
}
export function estimate(s) {
 const rate=GPUS[s.gpu].rate+s.cpu*PRICING.cpu+s.ramLimit*PRICING.ram;
 return {rate,expectedSeconds:null,windowSeconds:s.timeout+s.startup+15,resourceWindowUSD:rate*(s.timeout+s.startup+15),recordedUSD:null,pricing:PRICING,note:'تقدير محافظ يحتسب حد RAM الأقصى (ضعف الطلب) وCPU محدوداً بعدد الأنوية المختار، ويشمل حتى 15 ثانية انتظار. ليس سقف فاتورة. البناء والنقل والتخزين قد تُضاف. زمن الانتظار غير معروف.'};
}
export const quality={model:'LTX-2.5 Distilled',revision:manifest.model_revision,source:manifest.source_commit,width:576,height:1024,seconds:10,frames:241,fps:24,convVAE:true,nativeAudio:true,offload:'cpu',fp8:'cast; BF16 compute',steps:[8,3]};
