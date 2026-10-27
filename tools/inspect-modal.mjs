// Explicit, non-billable inspection. No App/Image creation or model downloads.
import fs from 'node:fs/promises';
import {ModalProvider} from '../engine/provider.mjs';
if(!process.argv.includes('--primary-read-only'))throw Error('Use --primary-read-only; this tool never prepares or generates.');
const provider=new ModalProvider();
const r=await provider.call('discover',{credentials:{mode:'local_profile',expectedWorkspace:'basm1998ali'},volume:'modal-ltx25-test-models'});
const evidence={checkedAt:new Date().toISOString(),workspace:r.workspace,environment:'main',ready:r.ready,files:r.files,bytes:r.files.reduce((n,f)=>n+f.size,0),runningTasks:r.runningTasks,apps:r.apps.map(a=>({containers:a.containers,functions:a.functions,state:a.state})),configurationSource:r.configurationSource,readyMarker:r.readyMarker,gpuStarted:false,weightsDownloaded:false,remoteResourcesCreated:false};
await fs.mkdir('docs',{recursive:true});await fs.writeFile('docs/read-only-inspection.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({workspace:r.workspace,environment:'main',ready:r.ready,files:r.files.length,bytes:evidence.bytes,runningTasks:r.runningTasks,listedApps:evidence.apps.length}));
