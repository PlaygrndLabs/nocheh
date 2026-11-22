import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {conversationFields,type ChatDirectory} from '../chats.js';
import {telegramUsername} from '../chats-telegram.js';
import {HttpError} from '../http.js';
import {validateSpace} from '../spaces.js';
import {chatKinds,chatStates,type ConversationChatFields} from '../chat-wire.js';
import {chatLabel,type ChatRepository} from './chats.js';
import type {StorePools} from './connections.js';
import {carriesForward} from './guards.js';
import {foldedNames} from './entities.js';
import type {ProjectRepository} from './projects.js';
import type {ControlledActionRepository} from './controlled-actions.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {NativeMemoryRepository} from './native-memory.js';
import type {SharingContentRepository} from './sharing.js';
import type {MemoryAccessRepository} from './memory-access.js';
import {memberView,ownerAccount} from './members.js';

export const decisionKinds=['controlled_action','telegram_action','memory_access','entity','knowledge'] as const;
export type DecisionKind=typeof decisionKinds[number];
export interface ConversationDirectoryItem {
  space_id:string;name:string|null;kind:'private'|'group'|'topic'|'unknown';
  parent_space:string|null;parent_name:string|null;observed_at:string|null;configured:boolean;
  /** The owner's last explicit refresh from Telegram, when one exists. */
  telegram?:{state:string;migrate_to_chat_id:string|null;observed_at:string};
  /** Present for topics: whether its latest captured service message closed it. */
  closed?:boolean;
  /** The owner added this topic because the Bot API cannot list topics. */
  registered?:boolean;
  /** From the chat directory (ADR-0252, ConversationChatFields): the dashboard reads these instead of an id's shape. */
  topic_key:ConversationChatFields['topic_key'];app_ids:ConversationChatFields['app_ids'];is_forum:ConversationChatFields['is_forum'];
  state:ConversationChatFields['state'];owner:ConversationChatFields['owner'];short_id:ConversationChatFields['short_id'];
  /** A person's public Telegram username, checked by the one username rule (telegramUsername), so the dashboard can link it. */
  username?:string;
  /** Who last added Nocheh to the chat, as its row says (ADR-0253): the owner, someone else, an anonymous admin or a channel,
   * an adder the app does not name, a row the seeder or a restore made, or nobody recorded. A topic the owner registered
   * says owner; any other topic has none. */
  added_by:'owner'|'other'|'anonymous'|'unknown'|'seeded'|null;
  /** When Nocheh took that add in. */
  added_at:string|null;
  /** Whether Telegram ever said someone removed Nocheh from the chat (a removal Nocheh recorded, not one it was seeded with). */
  removed_event:boolean;
}
export interface OwnerSupervisionDependencies {
  stores:StorePools;projects:ProjectRepository;controlledActions:Pick<ControlledActionRepository,'inspect'>;
  telegramActions:Pick<TelegramActionRepository,'inspect'>;memory:Pick<NativeMemoryRepository,'status'>;
  shared:Pick<SharingContentRepository,'inspect'>;
  /** The chat records the directory is built from (ADR-0252). */
  chats:Pick<ChatRepository,'listing'>;
  knowledge:{proposal(principal:Reader,id:string):Promise<unknown>};
  memoryAccess?:Pick<MemoryAccessRepository,'describe'>;
}
/** A /v1/conversations page: a search, and optionally only chats of one kind or in one state (a topic is in its
 * group's), so a filtered list such as the served groups pages whole. */
type PageInput={q?:string;after?:string;limit?:number;kind?:string;state?:string};
type DecisionInput={kind?:string;after?:string;limit?:number};
const iso=(value:unknown):string|null=>value instanceof Date?value.toISOString():typeof value==='string'?value:null;
const clean=(value:unknown):string|null=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,200)||null:null;
const identity=(id:string)=>{if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_decision_id');return id;};
const kindOf=(kind:string):DecisionKind=>{if(!decisionKinds.includes(kind as DecisionKind))throw new HttpError(400,'invalid_decision_kind');return kind as DecisionKind;};
function pageLimit(value:number|undefined) {if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>100))throw new HttpError(400,'invalid_supervision_limit');return value??50;}
/**
 * A /v1/conversations search (ADR-0252): a chat's Nocheh id, name, its group's name, or any id it has had in its app,
 * such as a Telegram ID, so a chat first seen after step 2b, whose Nocheh id is a digest, is found by its Telegram ID.
 * A topic carries its group's app ids, so it is found with its group.
 */
export function conversationMatches(item:Pick<ConversationDirectoryItem,'space_id'|'name'|'parent_name'|'app_ids'>,q:string):boolean {
  const query=q.toLocaleLowerCase();
  return !query||[item.space_id,item.name,item.parent_name,...(item.app_ids??[]).map(label=>label.external)].some(value=>value?.toLocaleLowerCase().includes(query));
}
/** One line on what an action would do: the message, command, page or tool. */
export function actionSummary(kind:unknown,args:unknown):string|null {
  const value=args&&typeof args==='object'?args as Record<string,unknown>:{},text=(key:string)=>typeof value[key]==='string'?value[key] as string:null;
  if(kind==='telegram_message')return clean(text('text'));
  if(kind==='shell')return clean(text('command'));
  if(kind==='browser')return clean(text('url'));
  if(kind==='mcp'&&value.connection==='github')return `${(text('tool')??'A lookup').replaceAll('_',' ')} in GitHub ${String((value.input as Record<string,unknown>|undefined)?.repo??'')}`;
  if(kind==='mcp'&&value.connection==='notion'){const where=typeof value.project==='string'?'a project\'s Notion':'Notion';
    return value.operation==='list'?(where==='Notion'?'List the Notion tools':'List the tools of '+where):`${text('tool')??'A tool'} in ${where}`;}
  if(kind==='mcp')return value.operation==='list'?`List the tools at ${text('url')??'a connected service'}`:`${text('tool')??'A tool'} at ${text('url')??'a connected service'}`;
  return null;
}
// An unclear outcome waits until the owner closes it or, for a page read, until it closes itself (ADR-0218).
const decisionTables:Record<DecisionKind,string>={controlled_action:'controlled_actions',telegram_action:'telegram_action_requests',memory_access:'memory_access_requests',entity:'memory_entity_suggestions',knowledge:'knowledge_proposals'};
// A name folded into another card waits on that card, not as its own item.
const unionDecisions=`SELECT 'controlled_action'::text AS kind,id,state,revision,created_at,space_id AS source_scope,NULL::text AS destination,fingerprint,kind AS title,NULL::text AS note,NULL::text AS subject_kind FROM controlled_actions WHERE state='proposed' OR state='ambiguous' AND resolution IS NULL
  UNION ALL SELECT 'telegram_action',id,state,revision,created_at,space_id,destination,fingerprint,'Send Telegram message',NULL,NULL FROM telegram_action_requests WHERE state='proposed' OR state='ambiguous' AND resolution IS NULL
  UNION ALL SELECT 'memory_access',id,state,revision,created_at,source_scope,destination,NULL,'Share a specific fact',proposal_reference->>'id',NULL FROM memory_access_requests WHERE state='pending' AND expires_at>now()
  UNION ALL SELECT 'entity',id,status,revision,created_at,NULL,NULL,NULL,name,reason,kind FROM memory_entity_suggestions WHERE status='pending' AND merged_into IS NULL
  UNION ALL SELECT 'knowledge',id,state,revision,created_at,source_scope,NULL,NULL,kind,NULL,NULL FROM knowledge_proposals WHERE state IN ('review','stale','failed')`;

/** Owner projections read saved records only. They never reconcile, refresh a provider, or grant authority. */
export class OwnerSupervisionRepository {
  constructor(readonly services:OwnerSupervisionDependencies){}
  private get stores(){return this.services.stores;}

  private async assistantConfiguration() {
    const row=(await this.stores.control.query(`SELECT v.document,v.revision FROM runtime_configuration c
      JOIN runtime_configuration_versions v USING(name,revision) WHERE c.name='assistant'`)).rows[0];
    return row?{policy:row.document as AssistantPolicy,revision:Number(row.revision)}:null;
  }

  /**
   * Every chat Nocheh knows, from its chats rows (ADR-0252): each with what the directory says of it (kind, parent,
   * topic key, app ids, state, owner), the name and dates captures and the owner's refreshes saved, and whether
   * anything of the owner's names it. A topic is listed once a message was seen in it, the owner named it, or
   * something names it. A value with no chat row that something names is listed as unknown. No message text is read.
   */
  private async snapshot():Promise<{directory:ChatDirectory;items:ConversationDirectoryItem[]}> {
    const [listing,configured,configuration]=await Promise.all([
      this.services.chats.listing(),
      // A group the owner added Nocheh to is the owner's own, also once the owner turns it off (ADR-0253).
      this.stores.control.query(`SELECT space_id FROM project_assignments
        UNION SELECT destination FROM sharing_rules UNION SELECT jsonb_array_elements_text(sources) FROM sharing_rules
        UNION SELECT jsonb_array_elements_text(scopes) FROM organization_delegations
        UNION SELECT destination FROM memory_access_settings WHERE destination<>'*'
        UNION SELECT destination FROM memory_fact_grants UNION SELECT destination FROM memory_access_requests
        UNION SELECT id FROM chats WHERE kind='group' AND added_by_role='owner'`),
      this.assistantConfiguration(),
    ]);
    const {directory,rows}=listing,policy=configuration?.policy;
    // The policy names the owner by a Telegram id; the chat it names is configured. Which groups are on is the
    // directory's (chats.state), never the policy's: those are configured too.
    const configuredIds=new Set<string>([...configured.rows.map(row=>row.space_id).filter((id):id is string=>typeof id==='string'),
      ...(policy?.owner_id?[policy.owner_id]:[]).map(id=>directory.resolve('telegram',id)??id),
      ...directory.all().filter(chat=>chat.kind==='group'&&directory.served(chat.id)).map(chat=>chat.id)]);
    const items=new Map<string,ConversationDirectoryItem>();
    for(const chat of directory.all()) {
      const detail=rows.get(chat.id),configuredHere=configuredIds.has(chat.id);
      if(chat.kind==='topic'&&!detail?.seen_at&&detail?.title_source!=='owner'&&!configuredHere)continue;
      const name=chatLabel(chat,detail?.username,chat.app_ids[0]?.external);
      const value:ConversationDirectoryItem={space_id:chat.id,name,...conversationFields(directory,chat.id),parent_name:null,
        observed_at:iso(detail?.seen_at),configured:configuredHere,added_by:detail?.added_by??null,added_at:iso(detail?.added_at),removed_event:detail?.removed_event===true};
      if(chat.kind==='private'&&!chat.owner){const username=telegramUsername(detail?.username);if(username)value.username=username;}
      if(chat.kind==='topic'&&detail?.seen_at)value.closed=detail.closed===true;
      if(chat.kind==='topic'&&detail?.title_source==='owner')value.registered=true;
      if(chat.kind!=='topic'&&detail?.refreshed)value.telegram={state:detail.refreshed.state,migrate_to_chat_id:detail.refreshed.to,observed_at:iso(detail.refreshed.at)!};
      items.set(chat.id,value);
    }
    for(const raw of configuredIds) {
      if(items.has(raw))continue;
      let space:string;try{space=validateSpace(raw);}catch{continue;}
      items.set(space,{space_id:space,name:null,...conversationFields(directory,space),parent_name:null,observed_at:null,configured:true,
        added_by:null,added_at:null,removed_event:false});
    }
    for(const value of items.values())if(value.parent_space)value.parent_name=items.get(value.parent_space)?.name??null;
    return {directory,items:[...items.values()].sort((a,b)=>a.space_id<b.space_id?-1:a.space_id>b.space_id?1:0)};
  }
  private async directory():Promise<ConversationDirectoryItem[]> {return (await this.snapshot()).items;}

  /**
   * Live chats with someone Nocheh doesn't serve that nothing of the owner's brought in: no import,
   * project, sharing rule or setting. Their names are written by strangers, so the owner's own turns
   * never see them listed; the dashboard still does. Chats, not topics: a topic is its chat's. A chat
   * row with no original at all (from an owner record or an older refresh) has nothing the owner
   * brought in either, and is left out the same way.
   */
  async outsiders(policy:AssistantPolicy):Promise<Set<string>> {
    if(!policy.enabled||!policy.owner_id)return new Set();
    const {directory,items}=await this.snapshot();
    const candidates=items.filter(item=>(item.kind==='private'||item.kind==='group')&&!item.configured&&!directory.served(item.space_id)&&
      !directory.isOwner(item.space_id)&&directory.get(item.space_id)?.app==='telegram');
    const scopes=directory.rawScopes(candidates.map(item=>item.space_id),'telegram');
    if(!candidates.length)return new Set();
    // Only chats every original of which came live: an import is something the owner brought in.
    const live=new Map((await this.stores.archive.query(`SELECT scope,bool_and(origin='live') AS live FROM events
      WHERE channel='telegram' AND kind IN ('telegram_update','telegram_delivered_message') AND scope=ANY($1::text[]) GROUP BY scope`,[scopes])).rows
      .map(row=>[String(row.scope),row.live===true]));
    return new Set(candidates.filter(item=>{
      const found=directory.get(item.space_id)!.app_ids.map(label=>live.get(label.external)).filter(value=>value!==undefined);
      return found.every(Boolean);
    }).map(item=>item.space_id));
  }
  /** Whether a conversation is, or is a topic of, one of the outsiders. */
  async outsider(policy:AssistantPolicy,space:string):Promise<boolean> {
    const found=await this.outsiders(policy);
    if(!found.size)return false;
    const {directory}=await this.services.chats.listing();
    return found.has(directory.parentOf(space)??space);
  }

  async conversations(principal:Reader,input:PageInput={},hidden=new Set<string>()) {
    admin(principal);const limit=pageLimit(input.limit),after=input.after??'',q=input.q??'',kind=input.kind??'',state=input.state??'';
    if(after)validateSpace(after);if(typeof q!=='string'||q.length>200)throw new HttpError(400,'invalid_conversation_query');
    if(kind&&!(chatKinds as readonly string[]).includes(kind))throw new HttpError(400,'invalid_conversation_kind');
    if(state&&!(chatStates as readonly string[]).includes(state))throw new HttpError(400,'invalid_conversation_state');
    // Filtered before paging, so a page and its cursor follow only the chats asked for.
    const all=(await this.directory()).filter(item=>!hidden.has(item.parent_space??item.space_id)&&conversationMatches(item,q)&&
      (!kind||item.kind===kind)&&(!state||item.state===state));
    const remaining=all.filter(item=>item.space_id>after),items=remaining.slice(0,limit);
    return {items,total:all.length,next_cursor:remaining.length>limit?items.at(-1)!.space_id:null,observed_at:new Date().toISOString(),state:'current' as const};
  }

  private summary(row:any) {
    const kind=kindOf(row.kind),id=String(row.id),revision=Number(row.revision),state=String(row.state??row.status);
    const review=kind==='controlled_action'?{href:'#inbox?action='+id,api_path:'/v1/tools/actions/'+id}:
      kind==='telegram_action'?{href:'#inbox?action='+id,api_path:'/v1/tools/actions/'+id}:
      kind==='memory_access'?{href:'#inbox?kind=memory_access&decision='+id,api_path:'/v1/memory-access/requests/'+id+'/decide'}:
      kind==='entity'?{href:'#inbox?kind=entity&decision='+id,api_path:'/v1/entities/'+id+'/decide'}:
      {href:'#inbox?kind=knowledge&decision='+id,api_path:'/v1/knowledge/proposals/'+id};
    const fingerprint=row.fingerprint??null;
    return {kind,id,title:row.title??row.name??(kind==='knowledge'?'Knowledge change':kind.replaceAll('_',' ')),state,revision,
      source_scope:row.source_scope??row.space_id??null,destination:row.destination??null,fingerprint,summary:null as string|null,
      created_at:iso(row.created_at),review:{...review,expected_revision:revision,fingerprint},
      // A person or project card says which it is, and lists the other names folded into it.
      ...(kind==='entity'?{subject_kind:row.subject_kind??null,also_called:[] as string[]}:{})};
  }

  /** Fill each item's one-line summary from its saved record; an unreadable record leaves it empty. */
  private async describe(items:ReturnType<OwnerSupervisionRepository['summary']>[],rows:any[]) {
    const owner={admin:true,scope:null} as Reader;
    const proposals=rows.filter(row=>row.kind==='memory_access'&&row.note).map(row=>String(row.note));
    const wording=new Map(proposals.length?(await this.stores.derived.query('SELECT id,content FROM derived_artifacts WHERE id=ANY($1::text[])',[proposals])).rows
      .map(row=>[row.id,clean(row.content.toString())]):[]);
    const folded=await foldedNames(this.stores.control,items.filter(item=>item.kind==='entity').map(item=>item.id));
    await Promise.all(items.map(async(item,index)=>{
      const row=rows[index];
      if(item.kind==='entity'){item.summary=clean(row.note);item.also_called=(folded.get(item.id)??[]).map(name=>name.name);}
      else if(item.kind==='memory_access')item.summary=wording.get(String(row.note))??null;
      else if(item.kind==='controlled_action'||item.kind==='telegram_action') {
        const detail=await (item.kind==='controlled_action'?this.services.controlledActions:this.services.telegramActions).inspect(owner,item.id).catch(()=>null) as any;
        item.summary=detail?actionSummary(detail.kind,detail.arguments):null;
      }
    }));
  }

  async decisions(principal:Reader,input:DecisionInput={}) {
    admin(principal);const limit=pageLimit(input.limit),kind=input.kind?kindOf(input.kind):null,after=input.after??'';
    if(after&&!/^(controlled_action|telegram_action|memory_access|entity|knowledge):[a-f0-9]{64}$/.test(after))throw new HttpError(400,'invalid_decision_cursor');
    // Totals and the page share one control-database snapshot, independent of page limits and filters.
    const row=(await this.stores.control.query(`WITH decisions AS (${unionDecisions}),
      counts AS (SELECT kind,count(*)::int AS total FROM decisions GROUP BY kind),
      page AS (SELECT * FROM decisions WHERE ($1::text IS NULL OR kind=$1) AND kind||':'||id>$2 ORDER BY kind,id LIMIT $3)
      SELECT (SELECT count(*)::int FROM decisions WHERE $1::text IS NULL OR kind=$1) AS total,
        coalesce((SELECT jsonb_object_agg(kind,total) FROM counts),'{}'::jsonb) AS totals,
        coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY kind,id) FROM page),'[]'::jsonb) AS items`,[kind,after,limit+1])).rows[0];
    const all=row.items as any[],page=all.slice(0,limit),items=page.map(value=>this.summary(value));
    await this.describe(items,page);
    return {items,total:Number(row.total),totals:Object.fromEntries(decisionKinds.map(key=>[key,Number(row.totals[key]??0)])),
      next_cursor:all.length>limit?items.at(-1)!.kind+':'+items.at(-1)!.id:null,observed_at:new Date().toISOString(),state:'current' as const};
  }

  async decision(principal:Reader,kindValue:string,idValue:string) {
    admin(principal);const kind=kindOf(kindValue),id=identity(idValue);
    const row=(await this.stores.control.query(`SELECT * FROM ${decisionTables[kind]} WHERE id=$1`,[id])).rows[0];
    if(!row)throw new HttpError(404,'decision_not_found');
    let detail:unknown=row,changed=false;
    if(kind==='controlled_action')detail=await this.services.controlledActions.inspect(principal,id);
    else if(kind==='telegram_action')detail=await this.services.telegramActions.inspect(principal,id);
    else if(kind==='knowledge')detail=await this.services.knowledge.proposal(principal,id);
    else if(kind==='entity')detail={...row,also_called:(await foldedNames(this.stores.control,[id])).get(id)??[]};
    else if(kind==='memory_access') {
      const artifact=(await this.stores.derived.query('SELECT content,content_hash,provenance FROM derived_artifacts WHERE id=$1',[row.proposal_reference.id])).rows[0];
      if(!artifact||digest(artifact.content)!==artifact.content_hash||artifact.content_hash!==row.proposal_reference.input_hash)throw new HttpError(409,'memory_proposal_changed');
      const fact=(await this.stores.derived.query('SELECT active_revision FROM entity_claims WHERE id=$1',[row.fact_id])).rows[0];
      changed=fact?.active_revision!==row.fact_revision||new Date(row.expires_at).getTime()<=Date.now();
      // The card names where the fact came from and who will see it (ADR-0242).
      detail={...row,wording:artifact.content.toString(),provenance:artifact.provenance,current_fact_revision:fact?.active_revision??null,
        ...await this.services.memoryAccess?.describe(row,artifact.provenance)};
    }
    const guard=(await this.stores.control.query('SELECT g.epoch,g.mode,i.generation FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton')).rows[0];
    // A controlled action still carries across later quiet epochs (ADR-0200); the other kinds need their own epoch.
    const carried=kind==='controlled_action'&&!!guard&&!!row.binding&&await carriesForward(this.stores.control,row.binding,{generation:guard.generation,epoch:Number(guard.epoch),mode:guard.mode});
    // Organization revalidates relevant evidence at application; unrelated learning epochs do not invalidate that review.
    const stale=changed||row.binding&&!carried&&(!guard||row.binding.generation!==guard.generation||
      (row.binding.mode!==undefined&&row.binding.mode!==guard.mode)||kind!=='knowledge'&&Number(row.binding.epoch)!==Number(guard.epoch));
    return {...this.summary({...row,kind,title:kind==='knowledge'?row.kind:row.name,subject_kind:kind==='entity'?row.kind:null}),detail,observed_at:new Date().toISOString(),
      observation:stale?'stale':'current',note:'Review commands recheck the exact revision and current authorization before applying a decision.'};
  }

  async context(principal:Reader,spaceValue:string) {
    admin(principal);const space=validateSpace(spaceValue),{directory:chats,items:directory}=await this.snapshot(),parent=chats.parentOf(space)??space;
    const [configuration,effective,rules,grants,releases,permissions,security,delegations,memory]=await Promise.all([
      this.assistantConfiguration(),this.services.projects.effective(space),
      this.stores.control.query(`SELECT * FROM sharing_rules s WHERE s.destination=ANY($1::text[]) ORDER BY s.id`,[[...new Set([space,parent,...chats.topicsOf(parent)])]]),
      this.stores.control.query('SELECT id,fact_id,fact_revision,mode,state,revision,binding,expires_at,suspended_reason FROM memory_fact_grants WHERE destination=$1 ORDER BY id',[space]),
      this.stores.control.query(`SELECT r.id,r.preview_id,r.rule_id,r.rule_revision,r.state,r.revision,r.generation,r.guard_mode,r.guard_revision,r.text_hash,r.expires_at,p.revision AS current_rule_revision,p.enabled AS rule_enabled
        FROM sharing_releases r JOIN sharing_rules p ON p.id=r.rule_id WHERE p.destination=$1 ORDER BY r.id`,[space]),
      this.stores.control.query(`SELECT p.id,p.action_id,p.fingerprint,p.scope,p.profile,p.kind,p.job_id,p.expires_at,p.remaining,p.revision,p.revoked_at,p.binding,a.space_id AS source_space
        FROM action_permissions p JOIN controlled_actions a ON a.id=p.action_id WHERE p.scope=$1 ORDER BY p.id`,[parent]),
      this.stores.control.query('SELECT p.revision,v.document FROM security_policy p JOIN security_policy_versions v USING(revision) WHERE p.singleton'),
      this.stores.control.query('SELECT * FROM organization_delegations WHERE scopes ? $1 ORDER BY id',[space]),
      this.services.memory.status(),
    ]);
    // Who may use Nocheh in the group is its members (step 3): each member with a switch for it, or whom Telegram has a
    // row for there, with the switch (on with no row), what Telegram last said and whether it is new to them. The owner's
    // private chat is the directory's, and so is whether the group is on (chats.state).
    const guard=memory.guard,policy=configuration?.policy,owner=space===chats.ownerChat();
    const members=chats.kind(parent)==='group'?(await memberView(this.stores.control,policy?ownerAccount(policy):null,null,false)).members.flatMap(member=>{
      const group=member.groups.find(item=>item.chat_id===parent);
      return group?[{id:member.id,account_id:member.account_id,name:member.name,username:member.username,telegram_id:member.telegram_id,state:member.state,
        talk:member.permissions.talk,on:group.on,telegram:group.telegram,new:group.new}]:[];
    }):[];
    // While a group's topics share memory, a turn there reads the rules into the group and every one of its topics too.
    const groupWide=(policy?.topic_memory??'group')==='group'&&chats.kind(parent)==='group';
    const sharingRules=rules.rows.filter(row=>row.destination===space||groupWide).map(row=>row.destination===space?row:{...row,through_group:true});
    const conversation=directory.find(item=>item.space_id===space)??{space_id:space,name:null,...conversationFields(chats,space),
      parent_name:directory.find(item=>item.space_id===parent)?.name??null,observed_at:null,configured:false,added_by:null,added_at:null,removed_event:false};
    const currentBinding=(binding:any)=>binding?.generation===guard.generation&&Number(binding?.epoch)===Number(guard.epoch);
    const factIds=grants.rows.map(row=>row.fact_id),facts=factIds.length?(await this.stores.derived.query('SELECT id,active_revision FROM entity_claims WHERE id=ANY($1::text[])',[factIds])).rows:[];
    const factRevisions=new Map(facts.map(row=>[row.id,row.active_revision]));
    // One Honcho workspace serves every audience; a conversation reads only its own sessions unless it is the owner's.
    const sessions=memory.sessions.filter(item=>owner||item.audience===space),connection=memory.connection,workspace=memory.workspace;
    const attached=connection?.attached===true;
    const ready=attached&&!!workspace&&(workspace.state==='ready'||!!workspace.last_ready_at)&&(owner||sessions.length>0);
    const syncing=attached&&sessions.some(item=>item.pending>0);
    const sharingReleases=[];
    for(const row of releases.rows){
      let current=row.state==='active'&&row.generation===guard.generation&&row.guard_mode===guard.mode&&row.rule_enabled&&row.rule_revision===row.current_rule_revision&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now());
      if(current)try{
        const preview=await this.services.shared.inspect(principal,row.preview_id);
        current=preview.current&&preview.guard_revision===row.guard_revision&&preview.text_hash===row.text_hash;
      }catch(error){if(!(error instanceof HttpError)||![403,404,409].includes(error.status))throw error;current=false;}
      sharingReleases.push({...row,current,authorization:'rechecked_on_use'});
    }
    return {conversation,observed_at:new Date().toISOString(),state:configuration&&security.rows[0]?'current':'partial',
      addressing:{state:configuration?'current':'unavailable',enabled:policy?.enabled??false,owner_id:policy?.owner_id??null,
        group_enabled:!!policy?.enabled&&chats.kind(parent)==='group'&&chats.served(parent),members,revision:configuration?.revision??null},
      knowledge_access:{source_scope:space,owner_access:owner,sharing_rules:sharingRules,
        fact_grants:grants.rows.map(({binding,...row})=>({...row,current:currentBinding(binding)&&factRevisions.get(row.fact_id)===row.fact_revision&&row.state==='active'&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now()),authorization:'rechecked_on_use'})),
        sharing_releases:sharingReleases,
        note:'Only the sources of a sharing rule and valid published sharing or fact grants can be used; a project grants no access in a group; stored grants are rechecked on use.'},
      // A permission is used with its action's own binding, which carries across quiet epochs (ADR-0200).
      external_actions:{policy:security.rows[0]??null,permissions:await Promise.all(permissions.rows.map(async({binding,...row})=>({...row,
        current:await carriesForward(this.stores.control,binding,guard)&&!row.revoked_at&&row.remaining>0&&new Date(row.expires_at).getTime()>Date.now()}))),
        note:'External actions require exact approval or a matching unexpired permission, and remain subject to the security policy. Authorization is not evidence of execution.'},
      organization:{effective,delegations:delegations.rows,note:'A project decides its role and skills, its task board and what an Answer privately answer may add; it grants no knowledge access in a group, and no participant permission or external-action authority. Organizing never moves a group or topic into or out of a project by itself.'},
      memory:{connection:{attached:connection?.attached??false,verified:connection?.verified??false,revision:connection?.revision??null},
        availability:ready?'available':attached?'limited':'unavailable',syncing,workspace,sessions,note:'Stored readiness is not a live retrieval test. Current context and permitted archive search remain separate.'}};
  }

  async projectContext(principal:Reader,idValue:string) {
    admin(principal);const id=identity(idValue),project=(await this.stores.control.query('SELECT * FROM projects WHERE id=$1',[id])).rows[0];
    if(!project)throw new HttpError(404,'project_not_found');
    const directory=await this.directory(),all=await Promise.all(directory.map(async conversation=>({...conversation,effective:await this.services.projects.effective(conversation.space_id)}))),conversations=all.filter(item=>item.effective.project?.id===id);
    const entityIds=(await this.stores.control.query('SELECT id FROM memory_entities WHERE project_id=$1',[id])).rows.map(row=>row.id);
    const knowledge=(await this.stores.derived.query(`WITH knowledge AS (
      SELECT 'learned'::text AS type,e.id,e.subject,e.kind,e.active_revision AS revision,v.author,v.retired,
        NULL::text AS content,NULL::text AS attribution,NULL::text AS uncertainty,v.evidence
      FROM learned_entries e JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
      WHERE e.scope_kind='project' AND e.scope_id=$1 AND NOT v.retired
      UNION ALL SELECT 'claim',c.id,c.predicate,'fact',v.revision,v.author,v.retired,v.content,v.attribution,v.uncertainty,v.evidence
      FROM entity_claims c JOIN entity_claim_versions v ON v.claim_id=c.id AND v.revision=c.active_revision
      WHERE (c.subject_entity_id=ANY($2::text[]) OR c.object_entity_id=ANY($2::text[])) AND NOT v.retired
      ) SELECT *,count(*) OVER()::int AS total FROM knowledge ORDER BY type,id LIMIT 51`,[id,entityIds])).rows;
    const scopes=conversations.map(item=>item.space_id);
    const decisions=(await this.stores.control.query(`WITH decisions AS (${unionDecisions}) SELECT *,count(*) OVER()::int AS total FROM decisions
      WHERE source_scope=ANY($1::text[]) OR destination=ANY($1::text[]) OR id IN (
        SELECT id FROM memory_entity_suggestions WHERE candidate_entity_id IN (SELECT id FROM memory_entities WHERE project_id=$2)) OR id IN (
        SELECT id FROM knowledge_proposals WHERE dependencies->'projects' @> jsonb_build_array(jsonb_build_object('id',$2::text))) ORDER BY kind,id LIMIT 51`,[scopes,id])).rows;
    const decisionItems=decisions.slice(0,50).map(row=>this.summary(row));await this.describe(decisionItems,decisions.slice(0,50));
    return {project,conversations,observed_at:new Date().toISOString(),state:'current',knowledge:{items:knowledge.slice(0,50).map(({total,...row})=>({...row,
      href:row.type==='learned'?'#memory?view=learned&project='+id+'&entry='+row.id:'#memory?view=relations'})),total:knowledge[0]?.total??0,next_cursor:knowledge.length>50?knowledge[49].type+':'+knowledge[49].id:null},
      decisions:{items:decisionItems,total:decisions[0]?.total??0,next_cursor:decisions.length>50?decisionItems.at(-1)!.kind+':'+decisionItems.at(-1)!.id:null}};
  }
}
