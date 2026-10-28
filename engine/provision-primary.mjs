// Owner-approved one-time SSH stdin provisioning; never write/export plaintext credentials.
import {createInterface} from 'node:readline';
import {masterKey} from './keyring.mjs';
import {openStore} from './open-store.mjs';
import {ModalProvider} from './provider.mjs';
import {id} from './store.mjs';
import {settings} from './config.mjs';
if(!process.argv.includes('--approve-primary-link'))throw Error('EXPLICIT_PRIMARY_LINK_APPROVAL_REQUIRED');
const input=await new Promise(resolve=>{const reader=createInterface({input:process.stdin,terminal:false});reader.once('line',line=>{reader.close();resolve(line);});});
let store;
try{
 const credentials=JSON.parse(String(input));
 if(!/^ak-[A-Za-z0-9_-]{8,200}$/.test(credentials.tokenId||'')||!/^as-[A-Za-z0-9_-]{8,200}$/.test(credentials.tokenSecret||''))throw Error('INVALID_CREDENTIALS');
 const folder=process.env.ENGINE_DATA_DIR||'.engine-data';store=await openStore(folder,masterKey(folder));
 if(!store)throw Error('SERVER_KEY_NOT_CONFIGURED');
 const provider=new ModalProvider(),verified=await provider.call('verify',{credentials:{...credentials,expectedWorkspace:'basm1998ali'}});
 if(verified.workspace!=='basm1998ali')throw Error('PRIMARY_WORKSPACE_MISMATCH');
 const existing=(await store.all('account')).find(a=>a.workspace==='basm1998ali');
 if(existing){console.log(JSON.stringify({workspace:existing.workspace,alreadyLinked:true,replaced:false}));}
 else{
  const accountId=id(),account={id:accountId,workspace:'basm1998ali',label:'الحساب الأساسي',mode:'token',role:'primary',volume:'modal-ltx25-test-models',createdAt:Date.now(),credentials:store.seal(credentials,accountId)};
  const discovery=await provider.call('discover',{credentials:{...credentials,expectedWorkspace:'basm1998ali'},volume:account.volume});
  account.discovery={...discovery,checkedAt:Date.now()};
  await store.put('account',account);await store.put('config',{id:'selection',accountId,settings:settings(),checkedAt:Date.now(),weightsReady:discovery.ready,capacity:'unknown_until_allocation'});
  await store.audit('owner_approved_primary_link',accountId);
  console.log(JSON.stringify({workspace:account.workspace,linked:true,encrypted:true,ready:discovery.ready,files:discovery.files.length,bytes:discovery.files.reduce((n,f)=>n+f.size,0),gpuStarted:false,resourcesCreated:false}));
 }
}catch{console.error('PRIMARY_LINK_FAILED_NO_CREDENTIAL_DETAILS');process.exitCode=1;}finally{if(store)await store.close();}
