import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {SourceAccessRepository} from './access.js';
import type {SourcePortabilityRepository} from './source-portability.js';
import {OwnerCommands} from './owner-commands.js';
import type {SourceReference} from './archive.js';
import type {RuntimeCall} from '../runtime.js';
import {fillTemplate,importReady,ownerPrompts} from '../prompts.js';
import {importProgress,preparedImports} from '../workflows/imports.js';

export const storageImportSchema=`
CREATE TABLE IF NOT EXISTS import_sources (
 job_id uuid NOT NULL REFERENCES workflow_imports(id),event_id text NOT NULL,
 source_reference jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,event_id)
);
`;

/** Live batch leases are held by the HTTP boundary through every repository write. */
export class ImportRepository {
  constructor(readonly sources:SourcePortabilityRepository,readonly access:SourceAccessRepository,
    private delivery?:{call:RuntimeCall;owner:()=>string|null|undefined}){}
  private get control(){return this.access.stores.control;}
  async record(principal:Reader,input:unknown,job?:any){
    admin(principal);const body=object(input);
    if(job&&object(body.event).origin!=='import')throw new HttpError(403,'import_original_required');
    const result=await this.sources.import(principal,body);
    if(job){
      await this.control.query(`INSERT INTO import_sources(job_id,event_id,source_reference) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[job.id,result.id,result.reference]);
      const saved=(await this.control.query('SELECT source_reference FROM import_sources WHERE job_id=$1 AND event_id=$2',[job.id,result.id])).rows[0];
      if(canonical(saved.source_reference)!==canonical(result.reference))throw new HttpError(409,'import_source_conflict');
    }
    // The export repeats a message the bot already saved live: kept as evidence, counted as a duplicate.
    return (await this.access.retirements?.liveCopies([result.id]))?.has(result.id)?{...result,live_copy:true}:result;
  }
  async upload(principal:Reader,id:string,input:unknown,job?:any){
    admin(principal);
    if(job){
      const artifact=(await this.access.stores.archive.query('SELECT event_id FROM artifacts WHERE id=$1',[id])).rows[0];
      if(!artifact||!(await this.control.query('SELECT 1 FROM import_sources WHERE job_id=$1 AND event_id=$2',[job.id,artifact.event_id])).rowCount)
        throw new HttpError(403,'import_source_denied');
    }
    return this.sources.upload(principal,id,input);
  }
  /** Mark written imports ready once all their messages are prepared, then tell the owner once in Telegram. */
  async settle():Promise<number>{
    for(const job of await preparedImports(this.control))
      await this.control.query('UPDATE workflow_imports SET ready_at=now() WHERE id=$1 AND ready_at IS NULL',[job.id]);
    const ready=(await this.control.query('SELECT id,label,total FROM workflow_imports WHERE ready_at IS NOT NULL AND ready_notice IS NULL ORDER BY ready_at,id LIMIT 5')).rows;
    const owner=this.delivery?.owner();let told=0;
    for(const job of ready){
      if(!this.delivery||!owner){await this.control.query("UPDATE workflow_imports SET ready_notice='off' WHERE id=$1",[job.id]);continue;}
      const failed=(await importProgress(this.control,job.id)).failed;
      const text=fillTemplate((await ownerPrompts(this.control))['imports.ready']??importReady,{chats:job.label||'Telegram export',
        messages:job.total.toLocaleString('en-US'),failed:failed?failed.toLocaleString('en-US'):null}).slice(0,4000);
      let result:Record<string,unknown>;
      try{result=await this.delivery.call('telegram.notice',{id:digest('import-ready:'+job.id),chat_id:owner,text},30000);}catch{return told;}
      // Telegram not connected yet: try again on a later pass. An unclear send is never repeated.
      if(result.state==='not_started')return told;
      await this.control.query('UPDATE workflow_imports SET ready_notice=$2 WHERE id=$1',[job.id,result.state==='done'?'sent':'uncertain']);told++;
    }
    return told;
  }
  async approveLearning(principal:Reader,input:unknown,job?:any){
    admin(principal);const body=object(input),batch=string(body.batch,200),ids=body.event_ids;
    if(body.approved!==true||!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||new Set(ids).size!==ids.length)
      throw new HttpError(400,'invalid_import_review');
    if(job&&(!job.review_approved||batch!==job.id))throw new HttpError(403,'import_consent_required');
    if(job&&(await this.control.query('SELECT 1 FROM import_sources WHERE job_id=$1 AND event_id=ANY($2::text[])',[job.id,ids])).rowCount!==ids.length)
      throw new HttpError(403,'import_source_denied');
    const references:SourceReference[]=[];for(const id of [...ids].sort())references.push((await this.access.archive.captured(id)).reference);
    const operation='import-review:'+digest(canonical([batch,references]));
    return new OwnerCommands(this.control).run(principal,operation,{kind:'import_review',batch,references},async db=>{
      let changed=0;
      for(const source of references){
        // A replay or another import cannot override a later explicit owner
        // revocation. Subsequent changes use revision-checked consent controls.
        changed+=(await db.query(`INSERT INTO learning_consent(event_id,enabled,reason,revision) VALUES($1,true,'owner',1)
          ON CONFLICT DO NOTHING`,[source.id])).rowCount??0;
      }
      return {approved:true,accepted:references.length,newly_enabled:changed,telegram_replies:0};
    });
  }
}
