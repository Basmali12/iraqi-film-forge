export type GPU = 'RTX-PRO-6000' | 'L40S';
export interface EngineSettings {gpu:GPU; cpu:4|8; ram:64|96|128; ramLimit?:number; timeout:number; startup:number; budget:number; seed:number}
export type JobState='queued'|'running'|'ready'|'completed'|'stopping'|'stopped'|'uncertain'|'recovery_required';
export interface CredentialInput {tokenId:string;tokenSecret:string;expectedWorkspace?:string}
export interface LocalProfile {mode:'local_profile';expectedWorkspace:'basm1998ali'}
export interface ProgressEvent {kind?:string;phase?:string;seconds?:number;completed?:number;total?:number;transferred?:number;required?:number;unit?:string;app_id?:string;cloud_stopped?:boolean;receivedAt?:number}
export interface AccountView {id:string;workspace:string;label:string;role:'primary'|'backup';mode:'token'|'local_profile';volume:string;hasHF:boolean;discovery?:{ready:boolean;capacity:string}}
export interface Cost {rate:number;resourceWindowUSD:number;recordedUSD:number|null;expectedSeconds:number|null;windowSeconds:number}
