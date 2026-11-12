import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object} from '../http.js';
import type {TurnBinding} from '../security/broker.js';
import type {SourceAccessRepository} from './access.js';
import {jobDeadlines,type BackgroundJobRepository} from './background-jobs.js';

export const machineSchema=`
CREATE TABLE IF NOT EXISTS machine_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO machine_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS machines (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 name text NOT NULL CHECK(name ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$'),
 address text NOT NULL CHECK(address ~ '^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$'),
 port integer NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535),
 login text NOT NULL CHECK(login ~ '^[a-z_][a-z0-9_-]{0,31}$'),
 key_ref text NOT NULL CHECK(key_ref ~ '^machines/[a-f0-9]{32}/key$'),
 public_key text NOT NULL CHECK(length(public_key) BETWEEN 1 AND 1000),
 host_key text CHECK(host_key ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
 enabled boolean NOT NULL DEFAULT true,
 tested_at timestamptz, test_error text,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS machines_name ON machines(lower(name));
-- Every command a job ran on a machine, and each test and cleanup. No foreign keys: the log outlives a removed machine and a reset job.
CREATE TABLE IF NOT EXISTS machine_commands (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 machine_id text NOT NULL, machine_name text NOT NULL,
 job_id text, run_event_id text,
 kind text NOT NULL CHECK(kind IN ('command','file','internal','cleanup','test')),
 command text NOT NULL CHECK(length(command)<=4000),
 script_sha256 text CHECK(script_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','done','failed','cancelled','ambiguous')),
 exit_code integer, output_sha256 text CHECK(output_sha256 ~ '^[a-f0-9]{64}$'), output_bytes bigint NOT NULL DEFAULT 0,
 error_code text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE INDEX IF NOT EXISTS machine_commands_time ON machine_commands(id DESC);
CREATE INDEX IF NOT EXISTS machine_commands_job ON machine_commands(job_id,id);
CREATE INDEX IF NOT EXISTS machine_commands_machine ON machine_commands(machine_id,id DESC);
-- The machine a job works on, pinned when it is asked: {id,name,address,port,login,host_key}; and the plan its card shows.
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS machine jsonb;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS steps jsonb;
-- Ending what a stopped machine job left on the machine: pending -> done | failed (after 3 tries).
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS machine_cleanup text CHECK(machine_cleanup IN ('pending','done','failed'));
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS machine_cleanup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_machine_box;
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_machine_box CHECK(machine IS NULL OR NOT box);
`;

/** What a machine command, test or cleanup may be refused or fail with, as nocheh-machines and services/hermes/machine_box.py
 *  name them: machine_key_missing when nocheh-machines has no key for the machine (after a restore, say), and
 *  machine_cleanup_failed when the cleanup ran there but did not end the programs (no ps, say). */
export const machineErrors=new Set(['invalid_machine_request','machine_not_allowed','machine_off','machine_changed','machine_time_up','machine_unavailable',
  'machine_unreachable','machine_auth_failed','machine_host_key_changed','machine_host_key_unknown','machine_script_too_long','machine_timeout',
  'machine_key_missing','machine_cleanup_failed']);
const NAME=/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/,ADDRESS=/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/,LOGIN=/^[a-z_][a-z0-9_-]{0,31}$/,ID=/^[a-f0-9]{32}$/,HOST_KEY=/^SHA256:[A-Za-z0-9+/]{43}$/;
// A command's script goes as one remote argument; what it reads comes on its stdin. Frames as tools/runtime/box_server.py writes them.
const SCRIPT_MAX=96*1024,STDIN_MAX=4*1024*1024,FRAME_MAX=1024*1024,COMMAND_MAX=4000,CLEANUP_TRIES=3;
// The broker relays a command for at most 15 minutes, so a command ends on the machine 30 seconds before that, with its exit code.
const COMMAND_SECONDS=870;
// A command quiet for a minute gets an empty O frame, so no hop to Hermes takes the stream for a dead one.
const KEEPALIVE_MS=60000;
/** A command request's JSON body: its stdin, its script and their JSON escapes. */
export const MACHINE_BODY=5*1024*1024;
const STOPPED='\n[nocheh: the job was stopped]\n';
// NUL and a lone surrogate, which PostgreSQL text refuses.
const unstorable=/[\0\ud800-\udfff]/gu;

/** Whether the machine token is set; without it no machine route works and no job may ask for a machine. */
export const machineTokenSet=(token=process.env.NOCHEH_MACHINE_TOKEN):token is string=>!!token&&token.length>=32;
/** POST to nocheh-machines with the machine token, which only it and this service hold. A refusal is a 502 with its code when
 *  the code is a machine code, else machine_unavailable; so is a service that cannot be reached. */
export async function machinesCall(path:string,body:unknown,signal:AbortSignal=AbortSignal.timeout(60000)):Promise<Response> {
  const token=process.env.NOCHEH_MACHINE_TOKEN;
  if(!machineTokenSet(token))throw new HttpError(502,'machine_unavailable');
  let response:Response;
  try{response=await fetch(machinesBase()+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal});}
  catch(error){if(cancelled(signal))throw error;throw new HttpError(502,'machine_unavailable');}
  if(!response.ok)throw refusal((await response.text()).slice(0,4096));
  return response;
}
const machinesBase=()=>(process.env.NOCHEH_MACHINES_URL||'http://nocheh-machines:8789').replace(/\/+$/,'');
/** Aborted by the caller, not by its own time running out. */
const cancelled=(signal:AbortSignal)=>signal.aborted&&!(signal.reason instanceof DOMException&&signal.reason.name==='TimeoutError');
/** nocheh-machines' refusal: its code when it is a machine code, else machine_unavailable. */
function refusal(text:string):HttpError {
  let code:unknown=null;try{code=(JSON.parse(text) as any)?.error;}catch{/* no code */}
  return new HttpError(502,typeof code==='string'&&machineErrors.has(code)?code:'machine_unavailable');
}
/** A command's stream from nocheh-machines, as machinesCall but over node:http: fetch ends a body that is quiet for 5 minutes,
 *  and a command may print nothing for longer. */
function machinesStream(path:string,body:unknown,signal:AbortSignal):Promise<IncomingMessage> {
  const token=process.env.NOCHEH_MACHINE_TOKEN;
  if(!machineTokenSet(token))return Promise.reject(new HttpError(502,'machine_unavailable'));
  const url=new URL(machinesBase()+path),payload=Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',signal,headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':payload.length}},response=>{
      if(response.statusCode!==undefined&&response.statusCode>=200&&response.statusCode<300)return resolve(response);
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{if(size<4096){chunks.push(chunk);size+=chunk.length;}});
      response.on('end',()=>reject(refusal(Buffer.concat(chunks).toString().slice(0,4096))));
      response.on('error',()=>reject(new HttpError(502,'machine_unavailable')));
    });
    req.on('error',error=>reject(cancelled(signal)?error:new HttpError(502,'machine_unavailable')));
    req.end(payload);
  });
}
/** A JSON answer of nocheh-machines; an answer that is not JSON is a service that cannot be used. */
async function machinesJson(path:string,body:unknown,signal?:AbortSignal):Promise<Record<string,unknown>> {
  const response=await machinesCall(path,body,signal);
  try{return object(await response.json());}catch{throw new HttpError(502,'machine_unavailable');}
}

/** The machine a job works on, pinned from its row when the job is asked: every command of the job goes to this pin. */
export type MachinePin={id:string;name:string;address:string;port:number;login:string;host_key:string};
export const machinePin=(row:any):MachinePin=>({id:String(row.id),name:String(row.name),address:String(row.address),port:Number(row.port),login:String(row.login),host_key:String(row.host_key)});
/** SQL over a machine row `m` and a job row `j`: whether the machine is still the one the job pinned. */
export const pinKept=`m.id=j.machine->>'id' AND m.address=j.machine->>'address' AND m.port=(j.machine->>'port')::integer AND m.login=j.machine->>'login'
  AND m.host_key=j.machine->>'host_key'`;
/** SQL over a machines row: whether a new job may ask for it. It is on, a test trusted its host key, and its last test passed;
 *  a failed test keeps new jobs off it until a test passes again. A job already asked keeps its pin's rules (`machineRun`). */
export const machineReady='enabled AND host_key IS NOT NULL AND test_error IS NULL';
const target=(pin:MachinePin)=>({id:pin.id,address:pin.address,port:pin.port,login:pin.login,host_key:pin.host_key});

/** Why a run may not work on its job's machine, or its job when it may: a run of a running job the owner asked for in their own
 *  message and approved, before its hard deadline, while machine control and the machine are on and the machine is still the
 *  one the job pinned. Unlike ownerApprovedJob it does not ask for the private chat: a project group's run qualifies too. */
async function machineRun(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{job?:string|null;logical_profile?:string|null}):Promise<{job:any|null;refusal:string}> {
  if(!owner||!turn.job||source.store!=='control')return {job:null,refusal:'machine_not_allowed'};
  const row=(await db.query(`SELECT j.*,s.enabled AS machines_on,m.id AS machine_row,m.enabled AS machine_on,(${pinKept}) AS machine_kept
    FROM background_runs t JOIN background_jobs j ON j.id=t.job_id JOIN machine_settings s ON s.singleton LEFT JOIN machines m ON m.id=j.machine->>'id'
    WHERE t.event_id=$1 AND j.id=$2 FOR SHARE OF j`,[source.id,turn.job])).rows[0];
  if(!row||!row.machine||row.state!=='running'||row.cancel_requested||row.requester!==null||row.decided_by!==owner||row.logical_profile!==(turn.logical_profile??null))
    return {job:null,refusal:'machine_not_allowed'};
  if(!row.started_at||Date.now()>=jobDeadlines(row).hard)return {job:null,refusal:'machine_time_up'};
  if(!row.machines_on||row.machine_row&&!row.machine_on)return {job:null,refusal:'machine_off'};
  if(!row.machine_row||!row.machine_kept)return {job:null,refusal:'machine_changed'};
  return {job:row,refusal:''};
}
/** A run's job when the run may work on the job's machine (`machineRun`); null otherwise. The job row is locked FOR SHARE. */
export async function machineJob(db:Pick<pg.PoolClient,'query'>,owner:string|null|undefined,source:{store:string;id:string},
  turn:{job?:string|null;logical_profile?:string|null}):Promise<any|null> {
  return (await machineRun(db,owner,source,turn)).job;
}

/** Withdraw the machine jobs `where` names that have not started, and stop those that run, so their programs on the machine
 *  are ended: in the caller's transaction, as Remove of a GitHub copy withdraws its jobs. A job already reporting is done with
 *  its machine: its report still goes out, and what it left running stays, as for any job that ended well. */
async function haltJobs(db:pg.PoolClient,where:string,params:unknown[]):Promise<{withdrawn:string[];halted:string[]}> {
  const withdrawn=(await db.query(`UPDATE background_jobs j SET state='stopped',cancel_requested=true,error_code='job_machine_off',finished_at=now(),revision=revision+1,updated_at=now()
    WHERE j.machine IS NOT NULL AND j.state IN ('proposed','approved') AND ${where} RETURNING id`,params)).rows.map(row=>row.id as string);
  const halted=(await db.query(`UPDATE background_jobs j SET cancel_requested=true,machine_cleanup=coalesce(machine_cleanup,'pending'),revision=revision+1,updated_at=now()
    WHERE j.machine IS NOT NULL AND j.state='running' AND ${where} RETURNING id`,params)).rows.map(row=>row.id as string);
  return {withdrawn,halted};
}
const noJobs={withdrawn:[] as string[],halted:[] as string[]};

const frame=(type:'O'|'X',payload:Buffer)=>{const head=Buffer.alloc(5);head.write(type,0,'latin1');head.writeUInt32BE(payload.length,1);return Buffer.concat([head,payload]);};
const exitFrame=(code:number)=>{const value=Buffer.alloc(4);value.writeInt32BE(code);return frame('X',value);};
/** A command as the log keeps it: as Hermes asked for it, cut to 4,000 characters with … */
const logged=(text:string)=>{const clean=text.replace(unstorable,'�');return clean.length>COMMAND_MAX?clean.slice(0,COMMAND_MAX-1).replace(/[\ud800-\udbff]$/,'')+'…':clean;};
// The log rows this process is working on, which the cleanup loop leaves to it, and the cleanups it runs, by job.
const live=new Set<string>(),cleaning=new Map<string,Promise<void>>();
/** Whether `promise` settles before `until`. */
const settlesBy=(promise:Promise<unknown>,until:number)=>new Promise<boolean>(resolve=>{
  const timer=setTimeout(()=>resolve(false),Math.max(0,until-Date.now()));
  void promise.then(()=>{clearTimeout(timer);resolve(true);},()=>{clearTimeout(timer);resolve(true);});
});

/** A command request, exactly: the script that runs, what it reads, its time, whether it runs in a login shell, and the
 *  command Hermes asked for and its kind, which the log keeps as claimed by the turn. */
function execRequest(input:unknown) {
  const body=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null,keys=['script','stdin','timeout','login','command','kind'];
  if(!body||Object.keys(body).length!==keys.length||!keys.every(key=>key in body)||typeof body.script!=='string'||body.script.includes('\0')||
    body.stdin!==null&&(typeof body.stdin!=='string'||Buffer.byteLength(body.stdin)>STDIN_MAX)||!Number.isSafeInteger(body.timeout)||(body.timeout as number)<1||(body.timeout as number)>3600||
    typeof body.login!=='boolean'||typeof body.command!=='string'||!['command','file','internal'].includes(body.kind as string))throw new HttpError(400,'invalid_machine_request');
  if(Buffer.byteLength(body.script)>SCRIPT_MAX)throw new HttpError(409,'machine_script_too_long');
  return body as {script:string;stdin:string|null;timeout:number;login:boolean;command:string;kind:'command'|'file'|'internal'};
}
const machineId=(value:unknown):string=>{if(typeof value!=='string'||!ID.test(value))throw new HttpError(404,'machine_not_found');return value;};
/** A machine's fields as the owner gives them: a name, an address that never starts with -, a port and a login. */
function machineFields(body:Record<string,unknown>,partial:boolean) {
  const invalid=new HttpError(400,'invalid_machine'),fields:{name?:string;address?:string;port?:number;login?:string}={};
  if(body.name!==undefined||!partial){const name=typeof body.name==='string'?body.name.trim():'';if(!NAME.test(name))throw invalid;fields.name=name;}
  if(body.address!==undefined||!partial){const address=typeof body.address==='string'?body.address.trim():'';if(!ADDRESS.test(address))throw invalid;fields.address=address;}
  if(body.port!==undefined||!partial){const port=body.port===undefined?22:body.port;if(!Number.isSafeInteger(port)||(port as number)<1||(port as number)>65535)throw invalid;fields.port=port as number;}
  if(body.login!==undefined||!partial){if(typeof body.login!=='string'||!LOGIN.test(body.login))throw invalid;fields.login=body.login;}
  return fields;
}
const taken=(error:unknown)=>(error as {code?:string})?.code==='23505';
/** A machine as the dashboard shows it: never its key, which only nocheh-machines holds. */
const shown=(row:any)=>({id:row.id,name:row.name,address:row.address,port:row.port,login:row.login,public_key:row.public_key,host_key:row.host_key,enabled:row.enabled,
  tested_at:row.tested_at,test_error:row.test_error,revision:row.revision,created_at:row.created_at,jobs:Number(row.jobs??0)});
const machineRows=`SELECT m.*,(SELECT count(*) FROM background_jobs j WHERE j.machine->>'id'=m.id AND j.state IN ('approved','running')) AS jobs FROM machines m`;

/**
 * The owner's machines (ADR-0231): an owner-approved job's terminal and file tools run on one of them over SSH. Nocheh makes
 * each machine's key in nocheh-machines, which alone holds it; this store holds the rows, the switch and the command log,
 * decides which run may use which machine, and relays each command to nocheh-machines with the machine token.
 */
export class MachineRepository {
  constructor(readonly access:SourceAccessRepository,readonly jobs?:BackgroundJobRepository){}
  private get control(){return this.access.stores.control;}
  private machine=async(id:string)=>{const row=(await this.control.query(machineRows+' WHERE m.id=$1',[id])).rows[0];if(!row)throw new HttpError(404,'machine_not_found');return shown(row);};
  async list(principal:Reader) {
    admin(principal);
    const settings=(await this.control.query('SELECT enabled,revision FROM machine_settings WHERE singleton')).rows[0];
    const machines=(await this.control.query(machineRows+' ORDER BY lower(m.name)')).rows.map(shown);
    return {available:machineTokenSet(),enabled:settings.enabled as boolean,revision:settings.revision as number,machines};
  }
  /** Add a machine: nocheh-machines makes its key and gives back only the public key, for the owner to add on the machine. */
  async create(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['name','address','port','login'].includes(key)))throw new HttpError(400,'invalid_machine');
    const fields=machineFields(body,false) as Required<ReturnType<typeof machineFields>>;
    if(!machineTokenSet())throw new HttpError(502,'machine_unavailable');
    if((await this.control.query('SELECT 1 FROM machines WHERE lower(name)=lower($1)',[fields.name])).rowCount)throw new HttpError(409,'machine_name_taken');
    const id=randomBytes(16).toString('hex'),key=(await machinesJson('/keys',{id,comment:'nocheh '+fields.name})).public_key;
    if(typeof key!=='string'||!/^ssh-[a-z0-9-]+ [A-Za-z0-9+/=]+(?: [^\n\r]*)?$/.test(key.trim())||key.trim().length>1000)throw new HttpError(502,'machine_unavailable');
    try{await this.control.query('INSERT INTO machines(id,name,address,port,login,key_ref,public_key) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id,fields.name,fields.address,fields.port,fields.login,'machines/'+id+'/key',key.trim()]);}
    catch(error){await machinesCall('/remove',{id}).catch(()=>{});if(taken(error))throw new HttpError(409,'machine_name_taken');throw error;}
    return this.machine(id);
  }
  /** Change a machine over the revision it was read at. A new address, port or login is another machine: its host key is
   *  trusted again on its next test. Turning it off, or moving it, withdraws the jobs pinned to it that have not started and
   *  stops those that have, whose programs there are ended first. */
  async update(principal:Reader,id:unknown,input:unknown) {
    admin(principal);const machine=machineId(id),body=object(input);
    if(Object.keys(body).some(key=>!['name','address','port','login','enabled','revision'].includes(key))||!Number.isSafeInteger(body.revision)||
      body.enabled!==undefined&&typeof body.enabled!=='boolean')throw new HttpError(400,'invalid_machine');
    const fields=machineFields(body,true),db=await this.control.connect();let moved=false,stopped=noJobs;
    try {
      await db.query('BEGIN');
      const current=(await db.query('SELECT * FROM machines WHERE id=$1 FOR UPDATE',[machine])).rows[0];
      if(!current)throw new HttpError(404,'machine_not_found');
      if(current.revision!==body.revision)throw new HttpError(409,'configuration_conflict');
      const next={name:fields.name??current.name,address:fields.address??current.address,port:fields.port??current.port,login:fields.login??current.login,
        enabled:body.enabled===undefined?current.enabled as boolean:body.enabled as boolean};
      moved=next.address!==current.address||next.port!==current.port||next.login!==current.login;
      await db.query(`UPDATE machines SET name=$2,address=$3,port=$4,login=$5,enabled=$6,host_key=CASE WHEN $7 THEN NULL ELSE host_key END,
        tested_at=CASE WHEN $7 THEN NULL ELSE tested_at END,test_error=CASE WHEN $7 THEN NULL ELSE test_error END,revision=revision+1,updated_at=now() WHERE id=$1`,
        [machine,next.name,next.address,next.port,next.login,next.enabled,moved]);
      if(moved||current.enabled&&!next.enabled)stopped=await haltJobs(db,"j.machine->>'id'=$1",[machine]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');if(taken(error))throw new HttpError(409,'machine_name_taken');throw error;}finally{db.release();}
    await this.stopped(stopped,moved?machine:null);
    if(moved)await machinesCall('/forget',{id:machine},AbortSignal.timeout(30000)).catch(()=>{});
    return this.machine(machine);
  }
  /** Connect to a machine once: its host key is trusted on the first success and must stay the same after it. A failure is
   *  kept as the machine's problem, and no new job may ask for it until a test passes again (`machineReady`). */
  async test(principal:Reader,id:unknown) {
    admin(principal);const row=(await this.control.query('SELECT * FROM machines WHERE id=$1',[machineId(id)])).rows[0];
    if(!row)throw new HttpError(404,'machine_not_found');
    if(!machineTokenSet())throw new HttpError(502,'machine_unavailable');
    const log=await this.log({machine_id:row.id,machine_name:row.name,kind:'test',command:'ssh test'});
    try {
      let answer:Record<string,unknown>;
      try{answer=await machinesJson('/test',{id:row.id,address:row.address,port:row.port,login:row.login,host_key:row.host_key},AbortSignal.timeout(90000));}
      catch(error){if(!(error instanceof HttpError)){await this.close(log,'failed',{error_code:'machine_unavailable'});throw error;}answer={ok:false,error:error.code};}
      const key=typeof answer.host_key==='string'&&HOST_KEY.test(answer.host_key)?answer.host_key:null;
      const error=answer.ok===true?!key?'machine_unavailable':row.host_key&&row.host_key!==key?'machine_host_key_changed':null:
        typeof answer.error==='string'&&machineErrors.has(answer.error)?answer.error:'machine_unreachable';
      const system=typeof answer.system==='string'?answer.system.replace(/[\0-\x1f\x7f]+/g,' ').trim().slice(0,200):'';
      // Saved only for the machine as it was tested: a change made meanwhile wins.
      if(!error)await this.control.query(`UPDATE machines SET host_key=coalesce(host_key,$3),tested_at=now(),test_error=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND revision=$2`,[row.id,row.revision,key]);
      else await this.control.query('UPDATE machines SET test_error=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2',[row.id,row.revision,error]);
      await this.close(log,error?'failed':'done',{exit_code:error?null:0,error_code:error});
      return {machine:await this.machine(row.id),result:error?{ok:false,error}:{ok:true,host_key:key,...(system?{system}:{})}};
    } finally {live.delete(log);}
  }
  /** Forget a machine's host key, for a machine that was set up again: its next test trusts the key it then finds, and the
   *  last test's problem goes with the key. The jobs pinned to the old key cannot run there any more, so they end as a move
   *  ends them. */
  async forgetHostKey(principal:Reader,id:unknown) {
    admin(principal);const machine=machineId(id),db=await this.control.connect();let stopped=noJobs;
    try {
      await db.query('BEGIN');
      if(!(await db.query('SELECT 1 FROM machines WHERE id=$1 FOR UPDATE',[machine])).rowCount)throw new HttpError(404,'machine_not_found');
      await db.query('UPDATE machines SET host_key=NULL,tested_at=NULL,test_error=NULL,revision=revision+1,updated_at=now() WHERE id=$1',[machine]);
      stopped=await haltJobs(db,"j.machine->>'id'=$1",[machine]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    await this.stopped(stopped,machine);
    await machinesCall('/forget',{id:machine},AbortSignal.timeout(30000)).catch(()=>{});
    return this.machine(machine);
  }
  /** Remove a machine: its jobs end as when it is turned off, their programs there are ended while its key still exists,
   *  then nocheh-machines deletes the key. Its log stays. */
  async remove(principal:Reader,id:unknown) {
    admin(principal);const machine=machineId(id),db=await this.control.connect();let stopped=noJobs;
    try {
      await db.query('BEGIN');
      if(!(await db.query('SELECT 1 FROM machines WHERE id=$1 FOR UPDATE',[machine])).rowCount)throw new HttpError(404,'machine_not_found');
      stopped=await haltJobs(db,"j.machine->>'id'=$1",[machine]);
      await db.query('DELETE FROM machines WHERE id=$1',[machine]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    await this.stopped(stopped,machine);
    await machinesCall('/remove',{id:machine},AbortSignal.timeout(30000)).catch(()=>{});
    return {id:machine,removed:true};
  }
  /** The one switch for machine control. Off stops every machine job that has not ended and withdraws those not started. */
  async saveSettings(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['enabled','revision'].includes(key))||typeof body.enabled!=='boolean'||!Number.isSafeInteger(body.revision))throw new HttpError(400,'invalid_settings');
    const db=await this.control.connect();let stopped=noJobs;
    try {
      await db.query('BEGIN');
      const row=(await db.query('SELECT revision FROM machine_settings WHERE singleton FOR UPDATE')).rows[0];
      if(row.revision!==body.revision)throw new HttpError(409,'configuration_conflict');
      await db.query('UPDATE machine_settings SET enabled=$1,revision=revision+1,updated_at=now() WHERE singleton',[body.enabled]);
      if(!body.enabled)stopped=await haltJobs(db,'true',[]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    await this.stopped(stopped,null);
    return this.list(principal);
  }
  /** After the jobs' rows changed: their live runs end, and their cards say how they ended. A machine about to lose its key
   *  or address (`machine`) first has the programs ended of every job of it whose cleanup is pending, not only those halted
   *  now, once their commands still running here have ended: each ends the programs its job started there. The owner's request waits for that at most 75 seconds, so with the call that follows it stays within the
   *  2 minutes the owner's API gives it. */
  private async stopped(jobs:{withdrawn:string[];halted:string[]},machine:string|null) {
    const until=Date.now()+75000;
    await Promise.all(jobs.halted.map(async id=>{
      const runs=(await this.control.query(`SELECT b.event_id FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id
        WHERE b.job_id=$1 AND r.state IN ('captured','running')`,[id])).rows;
      for(const run of runs)await this.jobs?.runs.end(run.event_id,'stopped');
    }));
    if(machine) {
      const pending=(await this.control.query(`SELECT id FROM background_jobs WHERE machine->>'id'=$1 AND machine_cleanup='pending' ORDER BY updated_at,id`,[machine])).rows.map(row=>row.id as string);
      await Promise.all(pending.map(id=>this.quiet(id).catch(()=>{})));
      for(const id of pending)await this.cleanJob(id,until).catch(()=>{});
    }
    // The cards say why, without holding up the answer.
    void Promise.all([...jobs.withdrawn,...jobs.halted].map(id=>this.jobs?.settled(id))).catch(()=>{});
  }
  /** The command log, newest first: commands, file work, cleanups and tests, and with `kind=all` also Hermes's own internal
   *  commands; one machine's or one job's, a page before `before`. */
  async commands(principal:Reader,query:{machine?:string;job?:string;kind?:string;before?:string;limit?:number}) {
    admin(principal);
    const machine=query.machine??'',job=query.job??'',kind=query.kind||'command',before=query.before??'',count=query.limit??50;
    if(machine&&!ID.test(machine)||job&&!/^[a-f0-9]{64}$/.test(job)||!['command','all'].includes(kind)||before&&!/^[1-9][0-9]{0,15}$/.test(before)||
      !Number.isSafeInteger(count)||count<1||count>100)throw new HttpError(400,'invalid_machine_query');
    const rows=(await this.control.query(`SELECT * FROM machine_commands WHERE ($1='' OR machine_id=$1) AND ($2='' OR job_id=$2) AND ($3 OR kind<>'internal')
      AND ($4::bigint IS NULL OR id<$4) ORDER BY id DESC LIMIT $5`,[machine,job,kind==='all',before||null,count+1])).rows;
    const titles=new Map<string,string|null>();
    for(const id of new Set(rows.slice(0,count).map(row=>row.job_id).filter((id):id is string=>!!id))) {
      const row=(await this.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
      let title:string|null=null;
      if(row&&this.jobs)try{title=(await this.jobs.proposal(row)).title;}catch(error){if(!(error instanceof HttpError))throw error;}
      titles.set(id,title);
    }
    return {commands:rows.slice(0,count).map(row=>({id:Number(row.id),machine_id:row.machine_id,machine_name:row.machine_name,job_id:row.job_id,
      job_title:row.job_id?titles.get(row.job_id)??null:null,kind:row.kind,command:row.command,script_sha256:row.script_sha256,state:row.state,exit_code:row.exit_code,output_sha256:row.output_sha256,
      output_bytes:Number(row.output_bytes),error_code:row.error_code,started_at:row.started_at,finished_at:row.finished_at})),
      next:rows.length>count?Number(rows[count-1].id):null};
  }
  /** The machine a run works on, for the launcher's binding: its job and the machine's name; null for any other run. */
  async binding(turn:Pick<TurnBinding,'job'|'logical_profile'|'reference'>):Promise<{job:string;machine:string}|null> {
    if(!turn.job||turn.reference?.store!=='control')return null;
    const job=await machineJob(this.control,this.access.policy().owner_id,turn.reference,turn);
    return job?{job:job.id,machine:String(job.machine.name)}:null;
  }
  private async log(entry:{machine_id:string;machine_name:string;job_id?:string;run_event_id?:string;kind:string;command:string;script_sha256?:string}):Promise<string> {
    const id=String((await this.control.query(`INSERT INTO machine_commands(machine_id,machine_name,job_id,run_event_id,kind,command,script_sha256) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [entry.machine_id,entry.machine_name,entry.job_id??null,entry.run_event_id??null,entry.kind,logged(entry.command),entry.script_sha256??null])).rows[0].id);
    live.add(id);return id;
  }
  private async close(id:string,state:'done'|'failed'|'cancelled'|'ambiguous',end:{exit_code?:number|null;output_sha256?:string|null;output_bytes?:number;error_code?:string|null}) {
    // Held until its row is closed, so the cleanup loop never takes a finished command for one a stopped process left.
    try{await this.control.query(`UPDATE machine_commands SET state=$2,exit_code=$3,output_sha256=$4,output_bytes=$5,error_code=$6,finished_at=now() WHERE id=$1 AND state='running'`,
      [id,state,end.exit_code??null,end.output_sha256??null,end.output_bytes??0,end.error_code??null]);}
    finally{live.delete(id);}
  }
  /** nocheh-machines has no key for the machine (after a restore, say): it is not ready until a test passes again, and its
   *  page says why. */
  private async keyMissing(id:string,code:string|null) {
    if(code==='machine_key_missing')await this.control.query(`UPDATE machines SET test_error=$2,revision=revision+1,updated_at=now()
      WHERE id=$1 AND test_error IS DISTINCT FROM $2`,[id,code]);
  }
  /**
   * Run one command of a run on its job's machine and stream its O and X frames back as they come. The run must still be
   * allowed to (`machineRun`), which is asked again every 2 seconds: when it no longer is, the command is ended and the
   * stream says so. Its time never passes the job's hard deadline less 30 seconds, nor the broker's 15 minutes less 30 seconds;
   * a quiet command's stream gets an empty O frame each minute. Each command is logged before it runs.
   * The answer is raw terminal output; the turn's next model request is secret-checked by the broker, as for the box.
   */
  async exec(principal:Reader,turn:TurnBinding,input:unknown,res:ServerResponse):Promise<void> {
    if(principal.admin)throw new HttpError(403,'machine_not_allowed');
    const body=execRequest(input),owner=this.access.policy().owner_id,source=turn.reference??{store:'',id:''};
    const controller=new AbortController(),hash=createHash('sha256');
    let ending:'gone'|'stopped'|null=null,bytes=0,exit:number|null=null,invalid=false,timer:NodeJS.Timeout|undefined;
    // The caller went away, also before the command started: the command ends with its connection to nocheh-machines.
    res.on('close',()=>{if(!res.writableEnded&&!ending){ending='gone';controller.abort();}});
    const check=async()=>(await machineRun(this.control,owner,source,turn)).job&&
      !!(await this.control.query("SELECT 1 FROM runtime_turns WHERE id=$1 AND state='open'",[source.id])).rowCount;
    const {job,refusal}=await machineRun(this.control,owner,source,turn);
    if(!job)throw new HttpError(409,refusal);
    if(!machineTokenSet())throw new HttpError(502,'machine_unavailable');
    const left=Math.floor((jobDeadlines(job).hard-Date.now())/1000)-30;
    if(left<=0)throw new HttpError(409,'machine_time_up');
    const pin=job.machine as MachinePin,timeout=Math.min(body.timeout,left,COMMAND_SECONDS);
    if(controller.signal.aborted)return;
    const log=await this.log({machine_id:pin.id,machine_name:pin.name,job_id:job.id,run_event_id:source.id,kind:body.kind,command:body.command,
      script_sha256:createHash('sha256').update(body.script).digest('hex')});
    // nocheh-machines ends the command at its time; this ends a stream that still goes on a minute later.
    const late=AbortSignal.timeout((timeout+60)*1000);
    try {
      // Asked again once logged: a Stop that came meanwhile refuses it here, or finds its row and waits for it before the cleanup.
      const again=await machineRun(this.control,owner,source,turn);
      if(!again.job){await this.close(log,'cancelled',{error_code:again.refusal});throw new HttpError(409,again.refusal);}
      let response:IncomingMessage;
      try{response=await machinesStream('/exec',{...target(pin),job:job.id,script:body.script,stdin:body.stdin,timeout,login_shell:body.login},AbortSignal.any([controller.signal,late]));}
      catch(error) {
        const code=error instanceof HttpError?error.code:'machine_unavailable';
        await this.close(log,ending?'cancelled':'failed',{error_code:ending?null:code});
        if(!ending)await this.keyMissing(pin.id,code);
        if(ending){res.destroy();return;}
        throw new HttpError(502,code);
      }
      // Asked again every 2 seconds: a job stopped or past its time, its run ended, a switch or machine turned off, or a
      // machine changed ends the command. Whole frames only are written, so a keepalive never splits one.
      let checking=false,written=Date.now();
      // The wait that did not end goes with its listeners, so a long stream leaves none behind.
      const write=async(chunk:Buffer)=>{written=Date.now();if(res.destroyed||res.write(chunk)||res.destroyed)return;const waited=new AbortController();
        await Promise.race([once(res,'drain',{signal:waited.signal}),once(res,'close',{signal:waited.signal})]).finally(()=>waited.abort());};
      timer=setInterval(()=>{
        if(!ending&&Date.now()-written>=KEEPALIVE_MS)void write(frame('O',Buffer.alloc(0)));
        if(checking||ending)return;checking=true;
        void check().then(allowed=>{if(!allowed&&!ending){ending='stopped';controller.abort();}},()=>{}).finally(()=>{checking=false;});
      },2000);
      // Headers go now, so no hop waits for a quiet command's first output to know it started.
      res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});res.flushHeaders();
      let pending=Buffer.alloc(0);
      try {
        reading: for await(const part of response) {
          pending=pending.length?Buffer.concat([pending,Buffer.from(part)]):Buffer.from(part);
          while(pending.length>=5&&!ending) {
            const type=pending[0],size=pending.readUInt32BE(1);
            if(type===0x4f&&size<=FRAME_MAX) {
              if(pending.length<5+size)break;
              hash.update(pending.subarray(5,5+size));bytes+=size;await write(pending.subarray(0,5+size));pending=pending.subarray(5+size);
            } else if(type===0x58&&size===4) {
              if(pending.length<9)break;
              exit=pending.readInt32BE(5);await write(pending.subarray(0,9));break reading;
            } else {invalid=true;break reading;}
          }
          if(ending)break;
        }
      // A stream that broke or ended without its exit code is a service that failed; one cut at its time limit, a timeout.
      }catch(error){if(!ending&&!late.aborted)invalid=true;}
      finally{clearInterval(timer);controller.abort();response.destroy();}
      const output=hash.digest('hex');
      if(exit!==null)await this.close(log,'done',{exit_code:exit,output_sha256:output,output_bytes:bytes});
      else if(ending==='stopped') {
        await write(frame('O',Buffer.from(STOPPED)));await write(exitFrame(137));
        await this.close(log,'cancelled',{exit_code:137,output_sha256:output,output_bytes:bytes,error_code:'job_stopped'});
      } else if(ending==='gone')await this.close(log,'cancelled',{output_sha256:output,output_bytes:bytes});
      // Ended without its exit code: whether the command finished is not known.
      else await this.close(log,'ambiguous',{output_sha256:output,output_bytes:bytes,error_code:late.aborted&&!invalid?'machine_timeout':'machine_unavailable'});
      if(ending==='gone')res.destroy();else res.end();
    } finally {clearInterval(timer);live.delete(log);}
  }
  /** Wait, at most 5 seconds, for a stopped job's commands still streaming here to end: each ends within about 2 seconds of
   *  the stop, so no program it starts outlives the cleanup that follows. */
  private async quiet(id:string):Promise<void> {
    for(const end=Date.now()+5000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,200)))
      if(!(await this.control.query(`SELECT 1 FROM machine_commands WHERE job_id=$1 AND state='running' AND kind IN ('command','file','internal') AND id=ANY($2::bigint[])`,
        [id,[...live]])).rowCount)return;
  }
  /** End what a stopped job left on its machine: the programs its commands started there, which carry its id, through the
   *  pin. Tried 3 times.
   *  A cleanup of the job already running here is waited for first, and tried again when it failed; none goes past `until`. */
  private async cleanJob(id:string,until=Date.now()+90000):Promise<void> {
    for(let running=cleaning.get(id);running;running=cleaning.get(id))if(!await settlesBy(running,until))return;
    if(!machineTokenSet()||until<=Date.now())return;
    const attempt:Promise<void>=this.cleanOnce(id,until-Date.now()).finally(()=>{if(cleaning.get(id)===attempt)cleaning.delete(id);});
    cleaning.set(id,attempt);await attempt;
  }
  private async cleanOnce(id:string,ms:number):Promise<void> {
    let log:string|undefined;
    try {
      const job=(await this.control.query("SELECT id,machine FROM background_jobs WHERE id=$1 AND machine_cleanup='pending'",[id])).rows[0];
      if(!job?.machine)return;
      const pin=job.machine as MachinePin;log=await this.log({machine_id:pin.id,machine_name:pin.name,job_id:id,kind:'cleanup',command:'end the programs this job started as '+pin.login});
      let code:string|null=null;
      try {
        const answer=await machinesJson('/cleanup',{...target(pin),job:id},AbortSignal.timeout(ms));
        if(answer.ok!==true)code=typeof answer.error==='string'&&machineErrors.has(answer.error)?answer.error:'machine_unreachable';
      }catch(error){code=error instanceof HttpError&&machineErrors.has(error.code)?error.code:'machine_unavailable';}
      await this.close(log,code?'failed':'done',{error_code:code});await this.keyMissing(pin.id,code);
      await this.control.query(`UPDATE background_jobs SET machine_cleanup=CASE WHEN $2::text IS NULL THEN 'done' WHEN machine_cleanup_attempts+1>=$3 THEN 'failed' ELSE 'pending' END,
        machine_cleanup_attempts=machine_cleanup_attempts+CASE WHEN $2::text IS NULL THEN 0 ELSE 1 END WHERE id=$1 AND machine_cleanup='pending'`,[id,code,CLEANUP_TRIES]);
    } finally {if(log)live.delete(log);}
  }
  /** Every 5 seconds: close log rows a stopped process left running, as ambiguous, once their job no longer runs or was
   *  stopped, or after 70 minutes; then end the programs of stopped machine jobs, without waiting for their turn to close,
   *  once none of their commands still runs. This process holds every command that streams, so a row it does not hold
   *  was left. */
  async cleanupTick():Promise<void> {
    await this.control.query(`UPDATE machine_commands c SET state='ambiguous',finished_at=now() WHERE c.state='running' AND NOT c.id=ANY($1::bigint[])
      AND (c.started_at<now()-interval '70 minutes' OR c.kind IN ('command','file','internal')
        AND NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.id=c.job_id AND j.state='running' AND NOT j.cancel_requested))`,[[...live]]);
    if(!machineTokenSet())return;
    const due=(await this.control.query(`SELECT j.id FROM background_jobs j WHERE j.machine_cleanup='pending' AND (j.cancel_requested OR NOT EXISTS (
      SELECT 1 FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=j.id AND r.state IN ('captured','running')))
      AND NOT EXISTS (SELECT 1 FROM machine_commands c WHERE c.job_id=j.id AND c.state='running' AND c.kind IN ('command','file','internal'))
      ORDER BY j.updated_at,j.id LIMIT 10`)).rows;
    await Promise.all(due.map(row=>this.cleanJob(row.id)));
  }
}
