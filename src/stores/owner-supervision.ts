import {admin,type Reader} from '../access.js';
import {digest} from '../archive.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {graphChatType,graphGroupLabel} from '../graph-labels.js';
import {HttpError} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';
import type {TelegramChatRepository} from './telegram-chats.js';
import type {TelegramTopicRepository} from './telegram-topics.js';
import type {StorePools} from './connections.js';
import type {ProjectRepository} from './projects.js';
import type {ControlledActionRepository} from './controlled-actions.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {NativeMemoryRepository} from './native-memory.js';
import type {SharingContentRepository} from './sharing.js';

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
}
export interface OwnerSupervisionDependencies {
  stores:StorePools;projects:ProjectRepository;controlledActions:Pick<ControlledActionRepository,'inspect'>;
  telegramActions:Pick<TelegramActionRepository,'inspect'>;memory:Pick<NativeMemoryRepository,'status'>;
  shared:Pick<SharingContentRepository,'inspect'>;telegramChats?:Pick<TelegramChatRepository,'observations'>;
  telegramTopics?:Pick<TelegramTopicRepository,'registrations'>;
  knowledge:{proposal(principal:Reader,id:string):Promise<unknown>};
}
type PageInput={q?:string;after?:string;limit?:number};
type DecisionInput={kind?:string;after?:string;limit?:number};
const iso=(value:unknown):string|null=>value instanceof Date?value.toISOString():typeof value==='string'?value:null;
const clean=(value:unknown):string|null=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,200)||null:null;
const identity=(id:string)=>{if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_decision_id');return id;};
const kindOf=(kind:string):DecisionKind=>{if(!decisionKinds.includes(kind as DecisionKind))throw new HttpError(400,'invalid_decision_kind');return kind as DecisionKind;};
function pageLimit(value:number|undefined) {if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>100))throw new HttpError(400,'invalid_supervision_limit');return value??50;}
const decisionTables:Record<DecisionKind,string>={controlled_action:'controlled_actions',telegram_action:'telegram_action_requests',memory_access:'memory_access_requests',entity:'memory_entity_suggestions',knowledge:'knowledge_proposals'};
const unionDecisions=`SELECT 'controlled_action'::text AS kind,id,state,revision,created_at,space_id AS source_scope,NULL::text AS destination,fingerprint,kind AS title FROM controlled_actions WHERE state IN ('proposed','ambiguous')
  UNION ALL SELECT 'telegram_action',id,state,revision,created_at,space_id,destination,fingerprint,'Send Telegram message' FROM telegram_action_requests WHERE state IN ('proposed','ambiguous')
  UNION ALL SELECT 'memory_access',id,state,revision,created_at,source_scope,destination,NULL,'Share a specific fact' FROM memory_access_requests WHERE state='pending' AND expires_at>now()
  UNION ALL SELECT 'entity',id,status,revision,created_at,NULL,NULL,NULL,name FROM memory_entity_suggestions WHERE status='pending'
  UNION ALL SELECT 'knowledge',id,state,revision,created_at,source_scope,NULL,NULL,kind FROM knowledge_proposals WHERE state IN ('review','stale','failed')`;

/** Owner projections read saved records only. They never reconcile, refresh a provider, or grant authority. */
export class OwnerSupervisionRepository {
  constructor(readonly services:OwnerSupervisionDependencies){}
  private get stores(){return this.services.stores;}

  private async assistantConfiguration() {
    const row=(await this.stores.control.query(`SELECT v.document,v.revision FROM runtime_configuration c
      JOIN runtime_configuration_versions v USING(name,revision) WHERE c.name='assistant'`)).rows[0];
    return row?{policy:row.document as AssistantPolicy,revision:Number(row.revision)}:null;
  }

  private async directory():Promise<ConversationDirectoryItem[]> {
    // Extract only presentation metadata in SQL: no message text, captions, or source bodies leave the archive.
    const [observed,configured,configuration]=await Promise.all([
      this.stores.archive.query(`WITH originals AS (
        SELECT id,capture_sequence,received_at,scope,
          CASE WHEN pg_input_is_valid(convert_from(payload,'UTF8'),'jsonb') THEN convert_from(payload,'UTF8')::jsonb ELSE '{}'::jsonb END AS presentation
        FROM events WHERE channel='telegram' AND kind IN ('telegram_update','telegram_delivered_message')
      ), observations AS (
        SELECT e.id,e.capture_sequence,e.received_at,e.scope,o.metadata->'audience' AS audience,
          coalesce(e.presentation->'message',e.presentation->'edited_message',e.presentation->'channel_post',e.presentation->'edited_channel_post',e.presentation) AS message
        FROM originals e LEFT JOIN source_observations o ON o.event_id=e.id
      ), scopes AS (
        SELECT *,scope AS space_id FROM observations
        UNION ALL SELECT *,scope||'/topic/'||(audience->>'topic_id') AS space_id FROM observations
          WHERE audience->>'topic_state'='known' AND audience->>'chat_id'=scope AND audience->>'topic_id' ~ '^[1-9][0-9]{0,15}$'
      ), topics AS (SELECT DISTINCT ON (space_id) space_id,topic_name FROM (
        -- A topic's name comes from its creation or edit service message. Every
        -- forum topic message also carries that root message as reply_to_message.
        SELECT space_id,capture_sequence,id,coalesce(message#>>'{forum_topic_edited,name}',message#>>'{forum_topic_created,name}',
          CASE WHEN message#>>'{reply_to_message,message_id}'=message#>>'{message_thread_id}'
            THEN coalesce(message#>>'{reply_to_message,forum_topic_edited,name}',message#>>'{reply_to_message,forum_topic_created,name}') END) AS topic_name
        FROM scopes WHERE space_id LIKE '%/topic/%') named
        WHERE topic_name IS NOT NULL ORDER BY space_id,(topic_name IS NOT NULL) DESC,capture_sequence DESC,id DESC),
      states AS (SELECT DISTINCT ON (space_id) space_id,(message ? 'forum_topic_closed') AS closed FROM scopes
        WHERE space_id LIKE '%/topic/%' AND (message ? 'forum_topic_closed' OR message ? 'forum_topic_reopened')
        ORDER BY space_id,capture_sequence DESC,id DESC)
      SELECT DISTINCT ON (s.space_id) s.space_id,s.message->'chat' AS chat,t.topic_name,s.received_at AS observed_at,st.closed
        FROM scopes s LEFT JOIN topics t ON t.space_id=s.space_id LEFT JOIN states st ON st.space_id=s.space_id
        ORDER BY s.space_id,(s.message->'chat' ? 'title') DESC,s.capture_sequence DESC,s.id DESC`),
      this.stores.control.query(`SELECT space_id FROM project_assignments
        UNION SELECT destination FROM sharing_rules UNION SELECT jsonb_array_elements_text(sources) FROM sharing_rules
        UNION SELECT jsonb_array_elements_text(scopes) FROM organization_delegations
        UNION SELECT destination FROM memory_access_settings WHERE destination<>'*'
        UNION SELECT destination FROM memory_fact_grants UNION SELECT destination FROM memory_access_requests`),
      this.assistantConfiguration(),
    ]);
    const items=new Map<string,ConversationDirectoryItem>();
    const item=(space:string):ConversationDirectoryItem=>({space_id:space,name:null,kind:parentSpace(space)?'topic':space.startsWith('-')?'group':/^[1-9]\d*$/.test(space)?'private':'unknown',
      parent_space:parentSpace(space),parent_name:null,observed_at:null,configured:false});
    for(const row of observed.rows) {
      let space:string;try{space=validateSpace(row.space_id);}catch{continue;}
      const value=item(space),parent=value.parent_space??space,type=graphChatType({chat:row.chat},parent);
      value.name=value.parent_space?clean(row.topic_name):graphGroupLabel({chat:row.chat},space)??null;
      value.kind=value.parent_space?'topic':type==='private'?'private':type?'group':value.kind;
      value.observed_at=iso(row.observed_at);if(value.parent_space)value.closed=row.closed===true;items.set(space,value);
    }
    const configuredIds=[...configured.rows.map(row=>row.space_id),...(configuration?.policy.group_ids??[]),configuration?.policy.owner_id].filter(Boolean);
    for(const raw of configuredIds) {
      let space:string;try{space=validateSpace(raw);}catch{continue;}
      const value=items.get(space)??item(space);value.configured=true;items.set(space,value);
      if(value.parent_space&&!items.has(value.parent_space))items.set(value.parent_space,item(value.parent_space));
    }
    // Topics the owner added: the Bot API cannot list topics without a message.
    for(const topic of await this.services.telegramTopics?.registrations()??[]) {
      let space:string;try{space=validateSpace(topic.chat_id+'/topic/'+topic.topic_id);}catch{continue;}
      const value=items.get(space)??item(space);value.name??=topic.name;value.registered=true;items.set(space,value);
      if(value.parent_space&&!items.has(value.parent_space))items.set(value.parent_space,item(value.parent_space));
    }
    // A group with no captured message is named by the owner's last Telegram refresh.
    const refreshed=await this.services.telegramChats?.observations()??new Map();
    for(const value of items.values()) {
      const chat=value.parent_space?undefined:refreshed.get(value.space_id);if(!chat)continue;
      value.name??=chat.title;value.telegram={state:chat.state,migrate_to_chat_id:chat.migrate_to_chat_id,observed_at:chat.observed_at};
    }
    for(const value of items.values())if(value.parent_space)value.parent_name=items.get(value.parent_space)?.name??null;
    return [...items.values()].sort((a,b)=>a.space_id<b.space_id?-1:a.space_id>b.space_id?1:0);
  }

  async conversations(principal:Reader,input:PageInput={}) {
    admin(principal);const limit=pageLimit(input.limit),after=input.after??'',q=input.q??'';
    if(after)validateSpace(after);if(typeof q!=='string'||q.length>200)throw new HttpError(400,'invalid_conversation_query');
    const query=q.toLocaleLowerCase(),all=(await this.directory()).filter(item=>!query||[item.space_id,item.name,item.parent_name].some(value=>value?.toLocaleLowerCase().includes(query)));
    const remaining=all.filter(item=>item.space_id>after),items=remaining.slice(0,limit);
    return {items,total:all.length,next_cursor:remaining.length>limit?items.at(-1)!.space_id:null,observed_at:new Date().toISOString(),state:'current' as const};
  }

  private summary(row:any) {
    const kind=kindOf(row.kind),id=String(row.id),revision=Number(row.revision),state=String(row.state??row.status);
    const review=kind==='controlled_action'?{href:'#activity?action='+id,api_path:'/v1/tools/actions/'+id}:
      kind==='telegram_action'?{href:'#activity?action='+id,api_path:'/v1/tools/actions/'+id}:
      kind==='memory_access'?{href:'#memoryMap?request='+id,api_path:'/v1/memory-access/requests/'+id+'/decide'}:
      kind==='entity'?{href:'#activity?kind=entity&decision='+id,api_path:'/v1/entities/'+id+'/decide'}:
      {href:'#activity?kind=knowledge&decision='+id,api_path:'/v1/knowledge/proposals/'+id};
    return {kind,id,title:row.title??row.name??(kind==='knowledge'?'Knowledge change':kind.replaceAll('_',' ')),state,revision,
      source_scope:row.source_scope??row.space_id??null,destination:row.destination??null,fingerprint:row.fingerprint??null,
      created_at:iso(row.created_at),review:{...review,expected_revision:revision,fingerprint:row.fingerprint??null}};
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
    const all=row.items as any[],items=all.slice(0,limit).map(value=>this.summary(value));
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
    else if(kind==='memory_access') {
      const artifact=(await this.stores.derived.query('SELECT content,content_hash,provenance FROM derived_artifacts WHERE id=$1',[row.proposal_reference.id])).rows[0];
      if(!artifact||digest(artifact.content)!==artifact.content_hash||artifact.content_hash!==row.proposal_reference.input_hash)throw new HttpError(409,'memory_proposal_changed');
      const fact=(await this.stores.derived.query('SELECT active_revision FROM entity_claims WHERE id=$1',[row.fact_id])).rows[0];
      changed=fact?.active_revision!==row.fact_revision||new Date(row.expires_at).getTime()<=Date.now();
      detail={...row,wording:artifact.content.toString(),provenance:artifact.provenance,current_fact_revision:fact?.active_revision??null};
    }
    const guard=(await this.stores.control.query('SELECT g.epoch,g.mode,i.generation FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton')).rows[0];
    // Organization revalidates relevant evidence at application; unrelated learning epochs do not invalidate that review.
    const stale=changed||row.binding&&(!guard||row.binding.generation!==guard.generation||
      (row.binding.mode!==undefined&&row.binding.mode!==guard.mode)||kind!=='knowledge'&&Number(row.binding.epoch)!==Number(guard.epoch));
    return {...this.summary({...row,kind,title:kind==='knowledge'?row.kind:row.name}),detail,observed_at:new Date().toISOString(),
      observation:stale?'stale':'current',note:'Review commands recheck the exact revision and current authorization before applying a decision.'};
  }

  async context(principal:Reader,spaceValue:string) {
    admin(principal);const space=validateSpace(spaceValue),parent=parentSpace(space)??space;
    const [directory,configuration,effective,rules,grants,releases,permissions,security,delegations,memory]=await Promise.all([
      this.directory(),this.assistantConfiguration(),this.services.projects.effective(space),
      this.stores.control.query('SELECT * FROM sharing_rules WHERE destination=$1 ORDER BY id',[space]),
      this.stores.control.query('SELECT id,fact_id,fact_revision,mode,state,revision,binding,expires_at,suspended_reason FROM memory_fact_grants WHERE destination=$1 ORDER BY id',[space]),
      this.stores.control.query(`SELECT r.id,r.preview_id,r.rule_id,r.rule_revision,r.state,r.revision,r.generation,r.guard_mode,r.guard_revision,r.text_hash,r.expires_at,p.revision AS current_rule_revision,p.enabled AS rule_enabled
        FROM sharing_releases r JOIN sharing_rules p ON p.id=r.rule_id WHERE p.destination=$1 ORDER BY r.id`,[space]),
      this.stores.control.query(`SELECT p.id,p.action_id,p.fingerprint,p.scope,p.profile,p.kind,p.job_id,p.expires_at,p.remaining,p.revision,p.revoked_at,p.binding,a.space_id AS source_space
        FROM action_permissions p JOIN controlled_actions a ON a.id=p.action_id WHERE p.scope=$1 ORDER BY p.id`,[parent]),
      this.stores.control.query('SELECT p.revision,v.document FROM security_policy p JOIN security_policy_versions v USING(revision) WHERE p.singleton'),
      this.stores.control.query('SELECT * FROM organization_delegations WHERE scopes ? $1 ORDER BY id',[space]),
      this.services.memory.status(),
    ]);
    const guard=memory.guard,policy=configuration?.policy,access=policy?.group_access?.[parent],owner=space===policy?.owner_id;
    const conversation=directory.find(item=>item.space_id===space)??{space_id:space,name:null,kind:parentSpace(space)?'topic':space.startsWith('-')?'group':'private',parent_space:parentSpace(space),parent_name:directory.find(item=>item.space_id===parent)?.name??null,observed_at:null,configured:false};
    const currentBinding=(binding:any)=>binding?.generation===guard.generation&&Number(binding?.epoch)===Number(guard.epoch);
    const factIds=grants.rows.map(row=>row.fact_id),facts=factIds.length?(await this.stores.derived.query('SELECT id,active_revision FROM entity_claims WHERE id=ANY($1::text[])',[factIds])).rows:[];
    const factRevisions=new Map(facts.map(row=>[row.id,row.active_revision]));
    const generations=memory.generations.filter(g=>g.audience===(owner?'owner':space)),connection=memory.connection;
    const attached=connection?.attached===true&&connection?.verified===true;
    const ready=attached&&generations.some(g=>g.state==='ready'||!!g.last_ready_at),syncing=generations.some(g=>g.state==='building');
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
        group_enabled:!!policy?.enabled&&!!policy.group_ids.includes(parent),granted:access?.granted??[],denied:access?.denied??[],revision:configuration?.revision??null},
      knowledge_access:{source_scope:space,owner_access:owner,sharing_rules:rules.rows,
        fact_grants:grants.rows.map(({binding,...row})=>({...row,current:currentBinding(binding)&&factRevisions.get(row.fact_id)===row.fact_revision&&row.state==='active'&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now()),authorization:'rechecked_on_use'})),
        sharing_releases:sharingReleases,
        note:'Only exact conversation sources and valid published sharing or fact grants can be used. Project membership is not access; stored grants are rechecked on use.'},
      external_actions:{policy:security.rows[0]??null,permissions:permissions.rows.map(({binding,...row})=>({...row,current:currentBinding(binding)&&!row.revoked_at&&row.remaining>0&&new Date(row.expires_at).getTime()>Date.now()})),
        note:'External actions require exact approval or a matching unexpired permission, and remain subject to the security policy. Authorization is not evidence of execution.'},
      organization:{effective,delegations:delegations.rows,note:'Organization affects project context only. It grants no knowledge access, participant permission, or external-action authority.'},
      memory:{connection:{attached:connection?.attached??false,verified:connection?.verified??false,revision:connection?.revision??null},
        availability:ready?'available':attached?'limited':'unavailable',syncing,generations,note:'Stored readiness is not a live retrieval test. Current context and permitted archive search remain separate.'}};
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
    const decisionItems=decisions.slice(0,50).map(row=>this.summary(row));
    return {project,conversations,observed_at:new Date().toISOString(),state:'current',knowledge:{items:knowledge.slice(0,50).map(({total,...row})=>({...row,
      href:row.type==='learned'?'#memory?view=learned&project='+id+'&entry='+row.id:'#memory?view=relations'})),total:knowledge[0]?.total??0,next_cursor:knowledge.length>50?knowledge[49].type+':'+knowledge[49].id:null},
      decisions:{items:decisionItems,total:decisions[0]?.total??0,next_cursor:decisions.length>50?decisionItems.at(-1)!.kind+':'+decisionItems.at(-1)!.id:null}};
  }
}
