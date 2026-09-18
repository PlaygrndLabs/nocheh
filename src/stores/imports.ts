import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {SourceAccessRepository} from './access.js';
import type {SourcePortabilityRepository} from './source-portability.js';
import {OwnerCommands} from './owner-commands.js';
import type {SourceReference} from './archive.js';

export const storageImportSchema=`
CREATE TABLE IF NOT EXISTS import_sources (
 job_id uuid NOT NULL REFERENCES workflow_imports(id),event_id text NOT NULL,
 source_reference jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,event_id)
);
`;

/** Live batch leases are held by the HTTP boundary through every repository write. */
export class ImportRepository {
  constructor(readonly sources:SourcePortabilityRepository,readonly access:SourceAccessRepository){}
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
    return result;
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
