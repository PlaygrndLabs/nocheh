import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';
import type {SourceAccessRepository} from './access.js';
import type {GuardBinding} from './guards.js';
import {OwnerCommands} from './owner-commands.js';
import {defaultLogicalProfile,runtimeProfile} from './runtime-profile.js';

export const runtimeProfileSchema=`
CREATE TABLE IF NOT EXISTS runtime_profiles (
 id text PRIMARY KEY,name text NOT NULL,owner_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','retired')),revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS active_runtime_profile_name ON runtime_profiles(owner_id,name) WHERE state='active';
`;
const name=(value:unknown)=>{const result=string(value,64);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result)||result.startsWith('nocheh-')||/^profile-[a-f0-9]{48}$/.test(result)||['default','current','all'].includes(result))
    throw new HttpError(400,'invalid_profile_name');return result;};

/** Stable configuration identity is separate from generation-bound native state. */
export class RuntimeProfileRepository {
  constructor(readonly access:SourceAccessRepository){}
  private get control(){return this.access.stores.control;}
  private owner(){const id=this.access.policy().owner_id;if(!id)throw new HttpError(409,'owner_profile_unavailable');return id;}
  private entry(space:string,binding:GuardBinding,custom?:any){
    const owner=this.owner(),chat=parentSpace(space)??space;
    if(chat!==owner&&!this.access.policy().group_ids.includes(chat))throw new HttpError(403,'profile_scope_denied');
    const audience:Reader={admin:false,scope:chat===owner?null:chat,space,revision:binding.epoch};
    const principal:Reader={...audience,logical_profile:custom?.id??defaultLogicalProfile(audience)};
    return {name:custom?.name??'nocheh-'+digest(space).slice(0,24),logical_profile:principal.logical_profile,
      native_profile:runtimeProfile(principal,binding),preference_profile:custom?.id??'nocheh-'+digest(space).slice(0,24),
      scope:chat,space,owner:chat===owner,managed:!custom,is_default:!custom&&chat===owner,
      revision:custom?.revision??0,policy_revision:binding.epoch,generation:binding.generation,guard_epoch:binding.epoch,guard_mode:binding.mode};
  }
  async list(principal:Reader){admin(principal);const owner=this.owner(),binding=await this.access.guards.state();
    const rows=(await this.control.query("SELECT * FROM runtime_profiles WHERE owner_id=$1 AND state='active' ORDER BY name LIMIT 101",[owner])).rows;
    if(rows.length>100)throw new HttpError(409,'profile_limit');
    const profiles=[...new Set([owner,...this.access.policy().group_ids])].map(space=>this.entry(space,binding));
    profiles.push(...rows.map(row=>this.entry(owner,binding,row)));await this.access.guards.assertCurrent(binding);
    return {profiles,revision:binding.epoch,generation:binding.generation};
  }
  async resolve(principal:Reader,input:unknown){admin(principal);const body=object(input),selected=string(body.profile??'',64);
    if(Object.keys(body).some(k=>!['profile','space'].includes(k)))throw new HttpError(400,'invalid_profile_request');
    const listed=await this.list(principal),alias=!selected||['default','current'].includes(selected)?listed.profiles.find(p=>p.is_default):
      listed.profiles.find(p=>[p.name,p.logical_profile,p.native_profile].includes(selected));
    if(alias){if(body.space!==undefined&&body.space!==alias.space)throw new HttpError(403,'profile_scope_denied');return alias;}
    // An explicit topic binding remains exactly that topic. It grants no parent
    // access; each source is independently checked by the archive repository.
    if(body.space!==undefined){const space=validateSpace(body.space);if(!parentSpace(space))throw new HttpError(403,'profile_scope_denied');
      const binding=await this.access.guards.state(),entry=this.entry(space,binding);
      if([entry.name,entry.logical_profile,entry.native_profile].includes(selected)){await this.access.guards.assertCurrent(binding);return entry;}}
    throw new HttpError(404,'profile_not_found');
  }
  async save(principal:Reader,input:unknown){admin(principal);const body=object(input),owner=this.owner();
    if(Object.keys(body).some(k=>!['id','name','state','expected_revision','operation_id'].includes(k))||!Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0||
      !['active','retired'].includes(String(body.state)))throw new HttpError(400,'invalid_profile_request');
    const operation=string(body.operation_id,200),id=body.id===undefined?'profile-'+digest('runtime-profile:'+operation).slice(0,48):string(body.id,64),label=name(body.name),expected=Number(body.expected_revision);
    if(!/^profile-[a-f0-9]{48}$/.test(id))throw new HttpError(400,'invalid_profile_id');
    return new OwnerCommands(this.control).run(principal,operation,{kind:'runtime_profile',id,name:label,state:body.state,expected,owner},async db=>{
      const prior=(await db.query('SELECT * FROM runtime_profiles WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if((prior?.revision??0)!==expected||prior&&prior.owner_id!==owner)throw new HttpError(409,'profile_revision_conflict');
      if(prior?.state==='retired'||!prior&&body.state!=='active')throw new HttpError(409,'profile_retired');
      if((await db.query("SELECT 1 FROM runtime_profiles WHERE owner_id=$1 AND name=$2 AND state='active' AND id<>$3",[owner,label,id])).rowCount)throw new HttpError(409,'profile_name_conflict');
      if(!prior&&Number((await db.query("SELECT count(*) FROM runtime_profiles WHERE owner_id=$1 AND state='active'",[owner])).rows[0].count)>=100)throw new HttpError(409,'profile_limit');
      const result={id,name:label,state:body.state,revision:expected+1,owner_id:owner};
      await db.query(`INSERT INTO runtime_profiles(id,name,owner_id,state,revision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET name=$2,state=$4,revision=$5,updated_at=now()`,[id,label,owner,body.state,result.revision]);
      return result;
    });
  }
}
