import type {Reader} from '../access.js';
import {admin} from '../access.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {parentSpace} from '../spaces.js';
import type {StorePools} from './connections.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {RelationshipRepository} from './relationships.js';
import {OwnerCommands} from './owner-commands.js';

/** Source access is independent of project membership and sharing configuration. */
export class SourceAccessRepository {
  readonly relationships:RelationshipRepository;
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository,readonly guards:GuardRepository,readonly policy:()=>AssistantPolicy) {
    this.relationships=new RelationshipRepository(archive);
  }
  async canRead(principal:Reader,reference:SourceReference,binding:GuardBinding):Promise<boolean> {
    await this.guards.assertCurrent(binding);const source=await this.archive.verify(reference);
    if(principal.admin||principal.scope===null){await this.guards.assertCurrent(binding);return true;}
    if(source.channel!=='telegram'||source.scope!==principal.scope)return false;
    const observed=(await this.relationships.describe(reference)).audience,space=principal.space??principal.scope;
    const allowed=!!observed&&observed.chat_id===principal.scope&&(observed.topic_state==='known'?space===observed.chat_id+'/topic/'+observed.topic_id:
      observed.topic_state==='none'&&space===observed.chat_id);
    await this.guards.assertCurrent(binding);return allowed;
  }
  async canLearn(reference:SourceReference,binding:GuardBinding):Promise<boolean> {
    await this.guards.assertCurrent(binding);const source=await this.archive.verify(reference);
    const intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[reference.id])).rows[0];
    if(intake?.state==='pending')return false;
    const consent=(await this.stores.control.query('SELECT enabled FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    if(consent){await this.guards.assertCurrent(binding);return consent.enabled===true;}
    if(intake?.transport==='import')return false;
    if(source.origin!=='live'||source.kind==='telegram_wire')return false;
    const policy=this.policy();if(!policy.enabled||!policy.owner_id)return false;
    if(source.channel==='browser')return source.scope===policy.owner_id;
    if(source.channel!=='telegram'||!['telegram_update','telegram_delivered_message'].includes(source.kind))return false;
    if(!policy.group_ids.includes(source.scope)&&source.scope!==policy.owner_id)return false;
    const observed=(await this.relationships.describe(reference)).audience;
    // A reaction to an unseen forum message waits for context, never learns at group scope.
    if(!observed||observed.topic_state==='unknown')return false;
    await this.guards.assertCurrent(binding);return true;
  }
  async space(reference:SourceReference):Promise<string|null> {
    const source=await this.archive.verify(reference);
    if(source.channel==='browser'&&source.scope===this.policy().owner_id)return source.scope;
    const observed=(await this.relationships.describe(reference)).audience;
    return !observed||observed.topic_state==='unknown'?null:observed.topic_state==='known'?observed.chat_id+'/topic/'+observed.topic_id:observed.chat_id;
  }
  async setConsent(principal:Reader,reference:SourceReference,input:unknown) {
    admin(principal);await this.archive.verify(reference);const body=object(input);
    if(Object.keys(body).some(k=>!['enabled','expected_revision','operation_id'].includes(k))||typeof body.enabled!=='boolean'||
      !Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)throw new HttpError(400,'invalid_learning_consent');
    return new OwnerCommands(this.stores.control).run(principal,string(body.operation_id,200),{kind:'learning_consent',reference,...body},async db=>{
      const current=(await db.query('SELECT revision FROM learning_consent WHERE event_id=$1 FOR UPDATE',[reference.id])).rows[0];
      if((current?.revision??0)!==body.expected_revision)throw new HttpError(409,'learning_consent_conflict');
      const revision=Number(body.expected_revision)+1;
      await db.query(`INSERT INTO learning_consent(event_id,enabled,reason,revision) VALUES($1,$2,'owner',$3)
        ON CONFLICT(event_id) DO UPDATE SET enabled=$2,reason='owner',revision=$3,updated_at=now()`,[reference.id,body.enabled,revision]);
      return {event_id:reference.id,enabled:body.enabled,revision};
    });
  }
  async consent(principal:Reader,reference:SourceReference) {
    admin(principal);const source=await this.archive.verify(reference),binding=await this.guards.state();
    const saved=(await this.stores.control.query('SELECT enabled,revision,updated_at FROM learning_consent WHERE event_id=$1',[reference.id])).rows[0];
    const intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[reference.id])).rows[0];
    const effective=await this.canLearn(reference,binding);await this.guards.assertCurrent(binding);
    return {source:reference,enabled:saved?.enabled??null,revision:saved?.revision??0,effective,
      authority:saved?'owner':'capture_policy',transport:intake?.transport??source.origin,intake_state:intake?.state??null,updated_at:saved?.updated_at??null};
  }
  principal(space:string):Reader {
    return {admin:false,scope:space===this.policy().owner_id?null:parentSpace(space)??space,space};
  }
}
