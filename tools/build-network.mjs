import {build} from 'esbuild';
await build({entryPoints:['site/production-network.tsx'],bundle:true,format:'iife',target:'es2022',outfile:'site/production-network.js',minify:true,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'}});
console.log('Production React network built locally; no API requests.');
