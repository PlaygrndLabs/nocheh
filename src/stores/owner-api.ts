import type {IncomingMessage,ServerResponse} from 'node:http';
import {admin,type Reader} from '../access.js';
import {HttpError,json,object,readJson,string} from '../http.js';
import {limit} from '../retrieval.js';
import {requestWorkflow} from '../workflows/store.js';
import type {StorageServices} from './services.js';

const identity=(value:unknown):string=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_identity');return id;};
const exact=(body:unknown,keys:string[])=>{const value=object(body);if(Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_operation_field');return value;};
export const ownerStoragePath=(path:string):boolean=>/^\/v1\/(?:projects(?:\/assignments|\/effective)?|sharing\/(?:rules|preview|previews(?:\/[a-f0-9]{64}(?:\/approve)?)?|releases(?:\/[a-f0-9]{64}\/revoke)?)|learned(?:\/[a-f0-9]{64}(?:\/history|\/correct)?)?|sources\/[a-f0-9]{64}\/(?:derivatives|reprocess|prepare)|derivatives\/[a-f0-9]{64}(?:\/activate)?|derivation-engines|reprocessing\/[a-f0-9]{64}|guards\/(?:events|artifacts|derived_artifacts)\/[a-f0-9]{64}(?:\/history|\/revisions\/\d+)?|memory\/provenance)$/.test(path);

export class OwnerStorageApi {
  constructor(readonly services:StorageServices){}
  owns(path:string):boolean {
    return ownerStoragePath(path);
  }
  async request(principal:Reader,method:string,url:URL,input?:unknown):Promise<unknown> {
    admin(principal);const path=url.pathname,s=this.services,q=url.searchParams;
    if(!this.owns(path))throw new HttpError(404,'not_found');
    if(!['GET','POST'].includes(method))throw new HttpError(405,'method_not_allowed');
    if(path==='/v1/projects')return method==='GET'?s.projects.list(principal,q.get('after')??''):s.projects.save(principal,input);
    if(path==='/v1/projects/assignments')return method==='GET'?s.projects.assignments(principal,q.get('after')??''):s.projects.assign(principal,input);
    if(path==='/v1/projects/effective'&&method==='GET')return s.projects.effective(q.get('space')??'');
    if(path==='/v1/sharing/rules')return method==='GET'?s.sharing.list(principal,q.get('after')??''):s.sharing.save(principal,input);
    if(path==='/v1/sharing/preview'&&method==='POST')return s.shared.preview(principal,input);
    if(path==='/v1/sharing/previews'&&method==='GET')return s.shared.previews(principal,q.get('after')??'');
    if(path==='/v1/sharing/releases'&&method==='GET')return s.shared.list(principal,q.get('after')??'');
    const preview=path.match(/^\/v1\/sharing\/previews\/([a-f0-9]{64})(?:\/(approve))?$/);
    if(preview) {
      if(method==='GET'&&!preview[2])return s.shared.inspect(principal,preview[1]!);
      if(method==='POST'&&preview[2])return s.shared.approve(principal,preview[1]!,input);
    }
    const release=path.match(/^\/v1\/sharing\/releases\/([a-f0-9]{64})\/revoke$/);
    if(release&&method==='POST')return s.shared.revoke(principal,release[1]!,input);
    if(path==='/v1/learned'&&method==='GET') {
      const kind=q.get('scope_kind'),id=q.get('scope_id');
      if(!!kind!==!!id||kind&&!['conversation','project'].includes(kind))throw new HttpError(400,'invalid_memory_scope');
      return s.learned.list(principal,kind&&id?{kind,id}:undefined,q.get('after')??'');
    }
    const memory=path.match(/^\/v1\/learned\/([a-f0-9]{64})(?:\/(history|correct))?$/);
    if(memory) {
      if(method==='POST'&&memory[2]==='correct')return s.learned.correct(principal,memory[1]!,input,s.detect);
      if(method==='GET'&&memory[2]==='history')return s.learned.history(principal,memory[1]!,q.has('before')?Number(q.get('before')):undefined);
      if(method==='GET'&&!memory[2]) {
        const result=await s.learned.history(principal,memory[1]!);
        if(!result.versions.length)throw new HttpError(404,'learned_memory_not_found');
        const active=(await s.stores.derived.query('SELECT active_revision FROM learned_entries WHERE id=$1',[memory[1]])).rows[0]?.active_revision;
        return {id:memory[1],active_revision:active,...result};
      }
    }
    const source=path.match(/^\/v1\/sources\/([a-f0-9]{64})\/(derivatives|reprocess|prepare)$/);
    if(source) {
      const captured=await s.archive.captured(source[1]!);
      if(method==='GET'&&source[2]==='derivatives')return s.selections.versions(source[1]!,q.get('after')??'',limit(q.get('limit'),50,100));
      if(method==='POST'&&source[2]==='prepare') {
        exact(input,[]);const binding=await s.guards.state(),client=await s.stores.control.connect();
        try {await client.query('BEGIN');const id=await requestWorkflow(client,'preparation',captured.reference.id,binding.epoch);await client.query('COMMIT');return {workflow_id:id};}
        catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      }
      if(method==='POST'&&source[2]==='reprocess') {
        const body=exact(input,['artifact_id','input_hash','producer','producer_version','configuration','operation_id']);
        const file=await s.attachments.file(identity(body.artifact_id));
        if(file.event.id!==source[1]||file.input_hash!==body.input_hash)throw new HttpError(409,'file_reference_conflict');
        const id=await s.reprocessing.request(file,string(body.producer,100),string(body.producer_version,200),object(body.configuration??{}),string(body.operation_id,200));
        const job=(await s.stores.control.query('SELECT state FROM reprocess_jobs WHERE id=$1',[id])).rows[0];
        return {id,state:job.state,status_url:'/v1/reprocessing/'+id};
      }
    }
    if(path==='/v1/derivation-engines'&&method==='GET')return {engines:s.reprocessing.engines.map(e=>({producer:e.name,producer_version:e.version,kind:e.outputKind}))};
    const job=path.match(/^\/v1\/reprocessing\/([a-f0-9]{64})$/);
    if(job&&method==='GET') {
      const row=(await s.stores.control.query('SELECT * FROM reprocess_jobs WHERE id=$1',[job[1]])).rows[0];
      if(!row)throw new HttpError(404,'reprocess_job_missing');return row;
    }
    const derivative=path.match(/^\/v1\/derivatives\/([a-f0-9]{64})(?:\/(activate))?$/);
    if(derivative) {
      const row=(await s.stores.derived.query('SELECT * FROM derived_artifacts WHERE id=$1',[derivative[1]])).rows[0];
      if(!row)throw new HttpError(404,'derivative_not_found');
      if(method==='GET'&&!derivative[2])return {...row,content:undefined,content_base64:row.content.toString('base64'),
        source:row.event_id?'nocheh:event:'+row.event_id:null,guarded:'/v1/guards/derived_artifacts/'+row.id};
      if(method==='POST'&&derivative[2]==='activate') {
        const body=exact(input,['expected_revision','operation_id']);
        return s.selections.activate({store:'derived',kind:'artifact',id:row.id,input_hash:row.content_hash},body.expected_revision as number|null,string(body.operation_id,200));
      }
    }
    const guard=path.match(/^\/v1\/guards\/(events|artifacts|derived_artifacts)\/([a-f0-9]{64})(?:\/(history)|\/revisions\/(\d+))?$/);
    if(guard) {
      const id=guard[1]+':'+guard[2];
      if(method==='GET'&&guard[3])return s.guards.history(id,q.has('before')?Number(q.get('before')):undefined);
      if(method==='GET'&&guard[4]) {
        const revision=Number(guard[4]);if(!Number.isInteger(revision)||revision<1||revision>2147483647)throw new HttpError(400,'invalid_revision');
        const row=(await s.stores.derived.query('SELECT * FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,revision])).rows[0];
        if(!row)throw new HttpError(404,'guard_revision_missing');return {...row,content:JSON.parse(row.content.toString()),search_text:undefined};
      }
      if(method==='GET') {
        const row=(await s.stores.derived.query(`SELECT s.*,r.content,r.author FROM guard_sources s LEFT JOIN guard_revisions r
          ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.id=$1`,[id])).rows[0];
        return row?{...row,input:JSON.parse(row.input.toString()),content:row.content?JSON.parse(row.content.toString()):null}:{id,state:'pending',active_revision:null};
      }
      if(method==='POST'&&!guard[3]&&!guard[4]) {
        const body=exact(input,['expected_revision','operation_id','content','restore_revision']);
        if(('content' in body)===('restore_revision' in body))throw new HttpError(400,'guard_change_required');
        return 'restore_revision' in body?s.guards.restore(id,body.expected_revision as number|null,Number(body.restore_revision),string(body.operation_id,200)):
          s.guards.edit(id,body.expected_revision as number|null,body.content,string(body.operation_id,200));
      }
    }
    if(path==='/v1/memory/provenance'&&method==='POST') {
      const body=exact(input,['workspace','audience','conclusion_ids']);
      return s.provenance.read(identity(body.workspace),string(body.audience,256),body.conclusion_ids as string[],await s.guards.state());
    }
    throw new HttpError(405,'method_not_allowed');
  }
  async handle(principal:Reader,req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
    if(!this.owns(url.pathname))return false;
    admin(principal); // Reject scoped callers before parsing any mutation body.
    const result=await this.request(principal,req.method??'GET',url,req.method==='POST'?await readJson(req,8*1024*1024):undefined);
    json(res,200,result);return true;
  }
}
