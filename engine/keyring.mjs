import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
function dpapi(value,protect) {
 const operation=protect?'Protect':'Unprotect';
 const script=`Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $protectedBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))`;
 try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:value,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}).trim();}
 catch{throw Error('WINDOWS_KEYRING_UNAVAILABLE');}
}
export function masterKey(folder,{create=false}={}) {
 if(process.env.ENGINE_MASTER_KEY_FILE)return fs.readFileSync(process.env.ENGINE_MASTER_KEY_FILE,'utf8').trim();
 if(process.env.ENGINE_MASTER_KEY)return process.env.ENGINE_MASTER_KEY;
 if(process.platform!=='win32')return undefined;
 const target=path.resolve(folder,'master-key.dpapi');
 if(fs.existsSync(target))return dpapi(fs.readFileSync(target,'utf8'),false);
 if(!create)return undefined;
 if(fs.existsSync(path.resolve(folder,'engines.sqlite')))throw Error('EXISTING_DATABASE_REQUIRES_ORIGINAL_MASTER_KEY');
 fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const key=randomBytes(32).toString('base64');
 fs.writeFileSync(target,dpapi(key,true),{mode:0o600,flag:'wx'});return key;
}
