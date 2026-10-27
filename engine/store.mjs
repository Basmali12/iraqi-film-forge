import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const id=()=>randomUUID();
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function passwordHash(password,salt=randomBytes(16).toString('hex')) {return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function passwordOK(password,stored) {try{const [salt,h]=stored.split(':');return timingSafeEqual(Buffer.from(h,'hex'),scryptSync(password,salt,64));}catch{return false;}}
export class Store {
 constructor(folder,key) {
  this.folder=path.resolve(folder);fs.mkdirSync(this.folder,{recursive:true,mode:0o700});
  this.key=Buffer.from(key||'','base64');if(this.key.length!==32)throw Error('ENGINE_MASTER_KEY must be a base64 encoded 32-byte secret');
  this.db=new DatabaseSync(path.join(this.folder,'engines.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,data TEXT);
   CREATE TABLE IF NOT EXISTS intents(key TEXT PRIMARY KEY,job TEXT);
   CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at INTEGER,action TEXT,subject TEXT);`);
  this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_live_gpu_operation ON records((1)) WHERE kind='job' AND json_extract(data,'$.action') IN ('start','generate') AND json_extract(data,'$.attachedEngineId') IS NULL AND json_extract(data,'$.status') IN ('queued','running','ready','stopping','uncertain','recovery_required') AND COALESCE(json_extract(data,'$.cloudStopped'),0)=0;`);
 }
 seal(value,aad) {const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(aad));const bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return [iv,c.getAuthTag(),bytes].map(x=>x.toString('base64')).join('.');}
 open(value,aad) {const [iv,tag,bytes]=value.split('.').map(x=>Buffer.from(x,'base64')),c=createDecipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(aad));c.setAuthTag(tag);return JSON.parse(Buffer.concat([c.update(bytes),c.final()]).toString());}
 get(kind,id) {const r=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(String(r.data)):null;}
 all(kind) {return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(String(r.data)));}
 recent(kind,limit=50) {return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC LIMIT ?').all(kind,limit).reverse().map(r=>JSON.parse(String(r.data)));}
 put(kind,value) {this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,JSON.stringify(value));return value;}
 delete(kind,id) {this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);}
 audit(action,subject) {this.db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(id(),Date.now(),action,subject);}
 close() {this.db.close();this.key.fill(0);}
}
