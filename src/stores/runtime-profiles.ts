import {admin,adminOrAgent,type AgentLogin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {memberAssistant,validateSpace} from '../spaces.js';
import {ownerChat} from '../assistant-policy.js';
import {chats} from '../chats.js';
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
// A chat's own profile is listed as private-chat, group-<its name>-<its code> or, for a member's own chat,
// member-<their name>-<its code>; those names stay reserved for chats.
const reserved=(value:string)=>/^(private-chat$|group-|member-)/i.test(value);
const name=(value:unknown)=>{const result=string(value,64);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(result)||result.startsWith('nocheh-')||/^profile-[a-f0-9]{48}$/.test(result)||['default','current','all'].includes(result)||reserved(result))
    throw new HttpError(400,'invalid_profile_name');return result;};
/** A chat name as a profile name's letters, digits, - and _; empty when it has none (for example, a Persian name). */
const slug=(value:unknown)=>typeof value==='string'?value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/[^a-z0-9_-]+/g,'-').replace(/^[-_]+/,'').slice(0,32).replace(/[-_]+$/,''):'';
type Label={name:string;display_name:string};

/** Stable configuration identity is separate from generation-bound native state. */
export class RuntimeProfileRepository {
  constructor(readonly access:SourceAccessRepository){}
  private get control(){return this.access.stores.control;}
  /** The owner's account, which owns the named profiles. */
  private owner(){const id=this.access.policy().owner_id;if(!id)throw new HttpError(409,'owner_profile_unavailable');return id;}
  /** The owner's private chat, whose profile is the default (ADR-0252: its chat id, not the owner's account). */
  private ownerChat(){const id=ownerChat(this.access.policy());if(!id)throw new HttpError(409,'owner_profile_unavailable');return id;}
  /** The served groups, by chat id, in the directory's order: the active groups (chats.state, ADR-0253). */
  private groups():string[] {
    const directory=chats();
    return directory.all().map(chat=>chat.id).filter(id=>directory.kind(id)==='group'&&directory.served(id));
  }
  /** Members' own private chats whose member has Personal assistant on (memberAssistant): their schedules live there. */
  private assistants():string[] {
    const directory=chats();
    return directory.all().map(chat=>chat.id).filter(id=>memberAssistant(id,directory));
  }
  private entry(space:string,binding:GuardBinding,custom?:any,label?:Label){
    // A profile's name and session are made from its chat id, unchanged for a chat stored before step 2b (ADR-0252).
    const owner=this.ownerChat(),directory=chats(),chat=directory.parentOf(space)??space;
    // A member's own chat with Personal assistant on has a profile of its own, for its schedules; it has no topics.
    if(chat!==owner&&!(directory.kind(chat)==='group'&&directory.served(chat))&&!(chat===space&&memberAssistant(chat,directory)))
      throw new HttpError(403,'profile_scope_denied');
    const audience:Reader={admin:false,scope:chat===owner?null:chat,space,revision:binding.epoch};
    const principal:Reader={...audience,logical_profile:custom?.id??defaultLogicalProfile(audience)};
    return {name:custom?.name??label?.name??'nocheh-'+digest(space).slice(0,24),display_name:custom?'':label?.display_name??'',logical_profile:principal.logical_profile,
      native_profile:runtimeProfile(principal,binding),preference_profile:custom?.id??'nocheh-'+digest(space).slice(0,24),
      scope:chat,space,owner:chat===owner,managed:!custom,is_default:!custom&&chat===owner,
      revision:custom?.revision??0,policy_revision:binding.epoch,generation:binding.generation,guard_epoch:binding.epoch,guard_mode:binding.mode};
  }
  /** Readable names for the owner's chat and each group. The name is only how the dashboard finds a
   * profile; the chat link stays its logical_profile, so a renamed group keeps its profile. */
  private async labels(owner:string,groups:string[],taken:Set<string>):Promise<Map<string,Label>>{
    // A group is named once the owner has refreshed it and Telegram answered, as before step 2b: by the name and public
    // username that refresh answered, never one a later update shows (ADR-0252; the old refresh table is only the
    // seeder's now). A group never refreshed keeps its code.
    const seen=new Map((await this.control.query(`SELECT chat_id,refreshed_title,refreshed_username FROM chat_details
      WHERE chat_id=ANY($1::text[]) AND refreshed_state='available'`,[groups])).rows
      .map(row=>[row.chat_id as string,{title:row.refreshed_title as string|null,username:row.refreshed_username as string|null}]));
    const labels=new Map<string,Label>([[owner,{name:'private-chat',display_name:'Private chat'}]]);taken.add('private-chat');
    for(const group of groups){if(group===owner)continue;
      const chat=seen.get(group),code=digest(group),readable=slug(chat?.title)||slug(chat?.username);
      // The chat's own code ends the name, so a renamed group never takes over another group's name.
      const label=[6,12,24].map(size=>'group-'+(readable?readable+'-':'')+code.slice(0,size)).find(value=>!taken.has(value))??'nocheh-'+code.slice(0,24);
      taken.add(label);
      labels.set(group,{name:label,display_name:chat?.title||(chat?.username?'@'+chat.username:'')});}
    return labels;
  }
  /** Readable names for members' own chats: member-<their name>-<the chat's code>, shown with their name. */
  private async memberLabels(members:string[],labels:Map<string,Label>,taken:Set<string>):Promise<void>{
    const names=new Map((await this.control.query(`SELECT c.id,a.display_name,a.username FROM chats c JOIN chat_accounts a ON a.id=c.account_id
      WHERE c.id=ANY($1::text[])`,[members])).rows.map(row=>[row.id as string,{name:row.display_name as string|null,username:row.username as string|null}]));
    for(const member of members){
      const person=names.get(member),code=digest(member),readable=slug(person?.name)||slug(person?.username);
      const label=[6,12,24].map(size=>'member-'+(readable?readable+'-':'')+code.slice(0,size)).find(value=>!taken.has(value))??'nocheh-'+code.slice(0,24);
      taken.add(label);labels.set(member,{name:label,display_name:person?.name||(person?.username?'@'+person.username:'')});}
  }
  async list(principal:Reader|AgentLogin){adminOrAgent(principal);const owner=this.owner(),chat=this.ownerChat(),binding=await this.access.guards.state();
    const rows=(await this.control.query("SELECT * FROM runtime_profiles WHERE owner_id=$1 AND state='active' ORDER BY name LIMIT 101",[owner])).rows;
    if(rows.length>100)throw new HttpError(409,'profile_limit');
    const members=this.assistants(),spaces=[...new Set([chat,...this.groups(),...members])],taken=new Set(rows.map(row=>String(row.name).toLowerCase()));
    const labels=await this.labels(chat,spaces.filter(space=>!members.includes(space)),taken);
    await this.memberLabels(members,labels,taken);
    const profiles=spaces.map(space=>this.entry(space,binding,undefined,labels.get(space)));
    profiles.push(...rows.map(row=>this.entry(chat,binding,row)));await this.access.guards.assertCurrent(binding);
    return {profiles,revision:binding.epoch,generation:binding.generation};
  }
  async resolve(principal:Reader|AgentLogin,input:unknown){adminOrAgent(principal);const body=object(input),selected=string(body.profile??'',64);
    if(Object.keys(body).some(k=>!['profile','space'].includes(k)))throw new HttpError(400,'invalid_profile_request');
    const listed=await this.list(principal),alias=!selected||['default','current'].includes(selected)?listed.profiles.find(p=>p.is_default):
      listed.profiles.find(p=>[p.name,p.logical_profile,p.native_profile].includes(selected));
    if(alias){if(body.space!==undefined&&body.space!==alias.space)throw new HttpError(403,'profile_scope_denied');return alias;}
    // An explicit topic binding remains exactly that topic. It grants no parent
    // access; each source is independently checked by the archive repository.
    if(body.space!==undefined){const space=validateSpace(body.space);if(!chats().parentOf(space))throw new HttpError(403,'profile_scope_denied');
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
    },{notes:'all'});
  }
}
