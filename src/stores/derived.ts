import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {ArchiveRepository,type SourceReference,type FileReference} from './archive.js';

export interface DerivativeInput {
  operation_id:string;source:SourceReference;file?:FileReference;kind:string;content:Buffer;
  producer:string;producer_version:string;configuration:Record<string,unknown>;
  provenance?:Record<string,unknown>;
}
export interface DerivativeReference {store:'derived';kind:'artifact';id:string;input_hash:string}

export class DerivedRepository {
  constructor(readonly pool:pg.Pool,readonly archive:ArchiveRepository){}

  async record(input:DerivativeInput):Promise<DerivativeReference> {
    if(!input.operation_id||input.operation_id.length>1024||!input.kind||!input.producer||!input.producer_version)
      throw new HttpError(400,'invalid_derivative');
    await this.archive.verify(input.source);
    let inputHash=input.source.input_hash;
    if(input.file) {
      if(input.file.store!=='archive'||input.file.kind!=='file'||canonical(input.file.event)!==canonical(input.source))throw new HttpError(400,'invalid_file_reference');
      const file=(await this.archive.pool.query('SELECT event_id,file_hash,byte_size FROM artifacts WHERE id=$1',[input.file.id])).rows[0];
      if(!file||file.event_id!==input.source.id||file.file_hash!==input.file.input_hash||Number(file.byte_size)!==input.file.byte_size)
        throw new HttpError(409,'file_reference_conflict');
      inputHash=input.file.input_hash;
    }
    const id=digest(`derivative:${input.operation_id}`),contentHash=digest(input.content),configurationHash=digest(canonical(input.configuration));
    const provenance={...input.provenance,source:input.source,...(input.file?{file:input.file}:{}),configuration:input.configuration};
    await this.pool.query(`INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,content_hash,provenance,
      source_revision,input_hash,producer,producer_version,configuration_hash,operation_id,search_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(operation_id) DO NOTHING`,
    [id,input.source.id,input.file?.id??null,input.kind,input.content,contentHash,JSON.stringify(provenance),input.source.revision,
      inputHash,input.producer,input.producer_version,configurationHash,input.operation_id,input.content.toString('utf8').replaceAll('\0','')]);
    const stored=(await this.pool.query('SELECT * FROM derived_artifacts WHERE operation_id=$1',[input.operation_id])).rows[0];
    if(!stored||stored.content_hash!==contentHash||stored.input_hash!==inputHash||stored.event_id!==input.source.id||
      stored.artifact_id!==(input.file?.id??null)||stored.kind!==input.kind||stored.source_revision!==input.source.revision||
      stored.producer!==input.producer||stored.producer_version!==input.producer_version||stored.configuration_hash!==configurationHash||
      canonical(stored.provenance)!==canonical(provenance))throw new HttpError(409,'derivative_identity_conflict');
    return {store:'derived',kind:'artifact',id,input_hash:contentHash};
  }
}
