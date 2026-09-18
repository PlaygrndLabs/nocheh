import {canonical} from '../archive.js';
import {conversationScope} from '../assistant-policy.js';
import {HttpError} from '../http.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {TelegramActionRepository} from './telegram-actions.js';
import type {ControlledActionRepository} from './controlled-actions.js';

/** Administrative commands use original owner-DM evidence, never editable text. */
export class ActionCommandRepository {
  constructor(readonly access:SourceAccessRepository,readonly telegram:TelegramActionRepository,readonly tools:ControlledActionRepository){}
  async controlReply(source:SourceReference):Promise<string|null> {
    const original=await this.access.archive.verify(source);
    if(original.kind!=='telegram_update'||original.origin!=='live')return null;
    const intake=(await this.access.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.id])).rows[0];
    if(intake?.transport==='import'||intake?.state==='pending')return null;
    const row=(await this.access.stores.archive.query('SELECT payload FROM events WHERE id=$1',[source.id])).rows[0],payload=JSON.parse(row.payload.toString()),text=payload.message?.text;
    const command=typeof text==='string'?text.trim().match(/^\/(actions|action|approve|deny|permissions|revoke)(?:\s+([a-f0-9]{64}))?$/):null;if(!command)return null;
    if(!conversationScope(this.access.policy(),payload,original.scope)?.owner)return 'Only the owner can review or approve actions in their private DM.';
    const owner={admin:true,scope:null},operation_id='telegram-command:'+source.id;
    if(command[1]==='actions') {
      const tools=(await this.tools.list(owner)).actions,telegram=await this.telegram.list(owner);
      const rows=[...tools,...telegram].filter(row=>['proposed','approved','running','ambiguous'].includes(row.state))
        .sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,10);
      return rows.length?rows.map(row=>`${row.id}\n${row.kind} · ${row.state}\nReview: /action ${row.id}`).join('\n\n').slice(0,3500):'No pending actions.';
    }
    if(command[1]==='permissions') {
      const permissions=(await this.tools.list(owner)).permissions;
      return permissions.length?permissions.slice(0,10).map(p=>`${p.id}\n${p.kind} · profile ${p.profile}\nRemaining: ${p.remaining}; expires ${p.expires_at}; revoked: ${!!p.revoked_at}\nRevoke: /revoke ${p.id}`).join('\n\n').slice(0,3500):'No standing permissions.';
    }
    if(!command[2])return command[1]==='revoke'?'Include the full permission ID.':'Include the full action ID.';
    try {
      if(command[1]==='revoke') {
        await this.tools.revoke(owner,{id:command[2],operation_id},source);
        return 'Permission revoked. Already-started operations cannot be undone.';
      }
      const controlled=!!(await this.access.stores.control.query('SELECT 1 FROM controlled_actions WHERE id=$1',[command[2]])).rowCount;
      const action=controlled?await this.tools.inspect(owner,command[2]):await this.telegram.inspect(owner,command[2]);
      const args=canonical(action.arguments);
      if(controlled&&args.length>2200&&['action','approve'].includes(command[1]!))return `${action.kind} · ${action.state}\nArguments are too long to review in Telegram. Open Nocheh Activity to review and approve this action in full.\nID: ${action.id}`;
      if(command[1]==='action')return controlled?
        `${action.kind} · ${action.state}\nProfile: ${action.logical_profile}\nExact arguments:\n${args}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`:
        `Telegram destination: ${action.arguments.destination}\nStatus: ${action.state}\nExact message:\n${action.arguments.text}\n\nApprove: /approve ${action.id}\nReject: /deny ${action.id}`;
      const body={id:action.id,fingerprint:action.fingerprint,decision:command[1],operation_id};
      const result=controlled?await this.tools.decide(owner,body,source):await this.telegram.decide(owner,body,source);
      return `Action ${result.id} ${result.state}.`;
    }catch(error) {
      if(error instanceof HttpError&&[400,403,404,409].includes(error.status))return error.code==='action_not_found'?'Action not found.':
        error.code==='permission_not_found'?'Permission not found.':'This action or permission cannot be changed in its current state. Review it in Nocheh Activity.';
      throw error;
    }
  }
}
