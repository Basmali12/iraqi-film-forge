import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const folder of ['site','engine','tools'])for(const file of readdirSync(folder))if(/\.(mjs|js)$/.test(file)){
 const r=spawnSync(process.execPath,['--check',folder+'/'+file],{stdio:'inherit'});if(r.status)process.exit(r.status);
}
const r=spawnSync(process.execPath,['--check','server.mjs'],{stdio:'inherit'});process.exit(r.status||0);
