import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';

export interface OperationReference {
  store:'control';kind:'operation';id:string;generation:string;input_hash:string;
}

/** Identity and execution state live in control; content lives in derived. */
export class OperationRepository {
  constructor(readonly pool:pg.Pool){}
  async record(input:{key:string;kind:string;scope:string;input_hash:string}):Promise<OperationReference> {
    if(!input.key||input.key.length>4096||!input.kind||input.kind.length>100||input.scope.length>1024||
      !/^[a-f0-9]{64}$/.test(input.input_hash))throw new HttpError(400,'invalid_operation');
    const generation=(await this.pool.query('SELECT generation FROM installation WHERE singleton')).rows[0]?.generation;
    if(!generation)throw new HttpError(503,'installation_unavailable');
    const id=digest(canonical(['operation',generation,input.key]));
    await this.pool.query(`INSERT INTO content_operations(id,generation,operation_key,kind,scope,input_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,generation,input.key,input.kind,input.scope,input.input_hash]);
    const row=(await this.pool.query('SELECT * FROM content_operations WHERE id=$1',[id])).rows[0];
    if(!row||row.imported||row.generation!==generation||row.operation_key!==input.key||row.kind!==input.kind||
      row.scope!==input.scope||row.input_hash!==input.input_hash)throw new HttpError(409,'operation_identity_conflict');
    return {store:'control',kind:'operation',id,generation,input_hash:input.input_hash};
  }
  async verify(reference:OperationReference):Promise<void> {
    if(reference.store!=='control'||reference.kind!=='operation')throw new HttpError(400,'invalid_operation_reference');
    const row=(await this.pool.query(`SELECT o.input_hash FROM content_operations o JOIN installation i ON i.generation=o.generation
      WHERE o.id=$1 AND o.generation=$2 AND i.singleton AND NOT o.imported`,[reference.id,reference.generation])).rows[0];
    if(!row||row.input_hash!==reference.input_hash)throw new HttpError(409,'operation_reference_conflict');
  }
}

export const controlOperationSchema=`
CREATE TABLE IF NOT EXISTS content_operations (
 id text PRIMARY KEY,generation uuid NOT NULL,operation_key text NOT NULL,kind text NOT NULL,
 scope text NOT NULL,input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(generation,operation_key)
);
CREATE TABLE IF NOT EXISTS capture_effect_receipts (
 operation_id text PRIMARY KEY REFERENCES content_operations(id),derived_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('recorded','attempting','delivered','rejected','ambiguous')),
 sources jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE content_operations ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;
`;
