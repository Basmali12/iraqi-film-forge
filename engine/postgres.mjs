import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Store,id} from './store.mjs';

export function databaseConfig() {
 const host=process.env.ENGINE_DATABASE_HOST||'127.0.0.1';
 // This deployment supports a database inside this server only, never public PG.
 if(!['127.0.0.1','::1','localhost'].includes(host)&&!host.startsWith('/'))throw Error('DATABASE_MUST_BE_LOCAL');
 const file=process.env.ENGINE_DATABASE_PASSWORD_FILE;
 return {host,port:Number(process.env.ENGINE_DATABASE_PORT||5432),database:process.env.ENGINE_DATABASE_NAME||'iraqi_film_forge',user:process.env.ENGINE_DATABASE_USER||'iff_app',password:file?fs.readFileSync(file,'utf8').trim():undefined,max:4,connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'iraqi-film-forge'};
}
export class PostgresStore {
 constructor(folder,key,config=databaseConfig()) {
  this.folder=path.resolve(folder);fs.mkdirSync(this.folder,{recursive:true,mode:0o700});
  this.key=Buffer.from(key||'','base64');if(this.key.length!==32)throw Error('INVALID_MASTER_KEY');
  this.pool=new pg.Pool(config);this.context=new AsyncLocalStorage();
  this.pool.on('error',()=>console.error('DATABASE_CONNECTION_LOST'));
 }
 seal(value,aad){return Store.prototype.seal.call(this,value,aad);}
 open(value,aad){return Store.prototype.open.call(this,value,aad);}
 query(text,values=[]) {return (this.context.getStore()||this.pool).query(text,values);}
 async ready(){if((await this.query("SELECT version FROM iff_migrations WHERE version='001'")).rowCount!==1)throw Error('MIGRATION_001_REQUIRED');}
 async get(kind,id){return (await this.query('SELECT data FROM iff_records WHERE kind=$1 AND id=$2',[kind,id])).rows[0]?.data??null;}
 async all(kind){return (await this.query('SELECT data FROM iff_records WHERE kind=$1 ORDER BY sequence',[kind])).rows.map(r=>r.data);}
 async recent(kind,limit=50){return (await this.query('SELECT data FROM iff_records WHERE kind=$1 ORDER BY sequence DESC LIMIT $2',[kind,limit])).rows.map(r=>r.data).reverse();}
 async put(kind,value){await this.query('INSERT INTO iff_records(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',[kind,value.id,JSON.stringify(value)]);return value;}
 async delete(kind,id){await this.query('DELETE FROM iff_records WHERE kind=$1 AND id=$2',[kind,id]);}
 async audit(action,subject){await this.query('INSERT INTO iff_audit(id,at,action,subject) VALUES($1,$2,$3,$4)',[id(),Date.now(),action,subject]);}
 async sessionPut(token,value){await this.query('INSERT INTO iff_sessions(token,data) VALUES($1,$2::jsonb)',[token,JSON.stringify(value)]);}
 async sessionGet(token){return (await this.query('SELECT data FROM iff_sessions WHERE token=$1',[token])).rows[0]?.data??null;}
 async sessionDelete(token){await this.query('DELETE FROM iff_sessions WHERE token=$1',[token]);}
 async intentGet(key){return (await this.query('SELECT job FROM iff_intents WHERE key=$1',[key])).rows[0]?.job??null;}
 async intentPut(key,job){await this.query('INSERT INTO iff_intents(key,job) VALUES($1,$2)',[key,job]);}
 async transaction(callback){
  if(this.context.getStore())throw Error('NESTED_TRANSACTION_DENIED');
  const client=await this.pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(190163,1)');
   const result=await this.context.run(client,callback);await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 async close(){await this.pool.end();this.key.fill(0);}
}
