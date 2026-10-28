import {Store} from './store.mjs';
import fs from 'node:fs';
import path from 'node:path';
export async function openStore(folder,key) {
 if(!key)return null;
 if(process.env.ENGINE_DATABASE_DRIVER==='postgres'){
  if(fs.existsSync(path.join(folder,'engines.sqlite')))throw Error('EXISTING_SQLITE_REQUIRES_APPROVED_IMPORT_NO_AUTOMATIC_SWITCH');
  const {PostgresStore}=await import('./postgres.mjs');const store=new PostgresStore(folder,key);
  try{await store.ready();return store;}catch{await store.close();throw Error('DATABASE_NOT_READY_RUN_APPROVED_MIGRATIONS');}
 }
 if(process.env.ENGINE_DATABASE_DRIVER&&process.env.ENGINE_DATABASE_DRIVER!=='sqlite')throw Error('UNKNOWN_DATABASE_DRIVER');
 return new Store(folder,key);
}
