import {cp,mkdir,writeFile,rm} from 'node:fs/promises';
await import('./build-network.mjs');
// Canonical speech validation lives in the engine; ship the same pure code to the planner.
await cp('engine/arabic-dialogue.cjs','site/arabic-dialogue.js');
// Static frontend only: never include server data, env files, credentials, or model files.
await mkdir('dist',{recursive:true});for(const file of ['dist/app.js','dist/film.js'])await rm(file,{force:true});await cp('site','dist',{recursive:true});
if(process.env.ENGINE_PUBLIC_API_ORIGIN){const u=new URL(process.env.ENGINE_PUBLIC_API_ORIGIN);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('ENGINE_PUBLIC_API_ORIGIN must be a public HTTPS origin, never credentials');await writeFile('dist/engine-endpoint.js','window.IFF_ENGINE_BACKEND='+JSON.stringify(u.origin)+';\n');}
console.log('Static site built in dist/. Engine APIs require the separate trusted HTTPS backend.');
