import {passwordHash,Store} from './store.mjs';
import {masterKey} from './keyring.mjs';
import {openStore} from './open-store.mjs';
import {createInterface} from 'node:readline';
// Reads credentials from environment / hidden PowerShell input, never prints them.
const fromStdin=process.argv.includes('--password-stdin');
if(fromStdin)console.log('Administrator password input ready (hidden stdin).');
const password=fromStdin?await new Promise(resolve=>{const reader=createInterface({input:process.stdin,terminal:false});reader.once('line',line=>{reader.close();resolve(line);});}):process.env.ENGINE_ADMIN_PASSWORD;
// The owner may explicitly choose an 8+ character password for this preview only.
const minimum=process.argv.includes('--owner-preview')?8:14;
if(typeof password!=='string'||password.length<minimum||password.length>500)throw Error('Administrator password does not meet the selected policy; use hidden input, never argv.');
const folder=process.env.ENGINE_DATA_DIR||'.engine-data',key=masterKey(folder,{create:true});
if(!key)throw Error('Set ENGINE_MASTER_KEY via your server secret manager first (32 random bytes, base64).');
const store=await openStore(folder,key);
if(await store.get('admin','administrator')){await store.close();throw Error('Administrator already exists; no overwrite.');}
await store.put('admin',{id:'administrator',username:process.env.ENGINE_ADMIN_USER||'admin',password:passwordHash(password),role:'admin'});
await store.close();delete process.env.ENGINE_ADMIN_PASSWORD;
console.log('Administrator provisioned. No Modal resource was accessed.');
