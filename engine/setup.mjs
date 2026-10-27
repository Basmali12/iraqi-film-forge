import {passwordHash,Store} from './store.mjs';
import {masterKey} from './keyring.mjs';
// Reads credentials from environment / hidden PowerShell input, never prints them.
const password=process.env.ENGINE_ADMIN_PASSWORD;
if(!password||password.length<14)throw Error('Set ENGINE_ADMIN_PASSWORD securely, minimum 14 characters; do not pass it on the command line.');
const folder=process.env.ENGINE_DATA_DIR||'.engine-data',key=masterKey(folder,{create:true});
if(!key)throw Error('Set ENGINE_MASTER_KEY via your server secret manager first (32 random bytes, base64).');
const store=new Store(folder,key);
if(store.get('admin','administrator'))throw Error('Administrator already exists; no overwrite.');
store.put('admin',{id:'administrator',username:process.env.ENGINE_ADMIN_USER||'admin',password:passwordHash(password),role:'admin'});
store.close();delete process.env.ENGINE_ADMIN_PASSWORD;
console.log('Administrator provisioned. No Modal resource was accessed.');
