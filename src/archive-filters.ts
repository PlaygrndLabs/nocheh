import {HttpError} from './http.js';

/**
 * `private_chats` (step 4) splits the private chats of people other than the owner (members' chats, and the chats of
 * people who wrote to Nocheh privately without being members) from the rest: `hide` leaves them out, `only` keeps only
 * them. The dashboard's Messages list asks for `hide` by default, so these chats never show when the owner shares their
 * screen, and for `only` under its "Members' chats" filter. Without it nothing changes. `private_scopes` is what it
 * resolved to: the events.scope values of those chats, read from the control store's chat rows (otherPrivateScopes in
 * src/stores/chats.ts), never from a chat directory this process may not have loaded. Until they are resolved, the split
 * shows nothing either way (fail closed).
 */
export type ArchiveFilters={kind:''|'incoming'|'assistant';scope:string;reply:''|'approval_pending'|'pending'|'running'|'failed'|'done'|'ambiguous'|'suppressed'|'cancelled'|'not_started';
 private_chats?:'hide'|'only';private_scopes?:readonly string[]};

export function archiveFilters(input:{get(name:string):string|null}):ArchiveFilters{
 const kind=input.get('kind')??'',scope=input.get('scope')??'',reply=input.get('reply')??'',privateChats=input.get('private_chats')??'';
 if(!['','incoming','assistant'].includes(kind)||scope.length>256||!['','approval_pending','pending','running','failed','done','ambiguous','suppressed','cancelled','not_started'].includes(reply)
  ||!['','hide','only'].includes(privateChats))
  throw new HttpError(400,'invalid_archive_filter');
 return {kind:kind as ArchiveFilters['kind'],scope,reply:reply as ArchiveFilters['reply'],
  ...(privateChats?{private_chats:privateChats as 'hide'|'only'}:{})};
}

export function matchesArchiveFilters(row:{kind?:string;scope?:string},state:string|undefined,filters:ArchiveFilters,actionState?:string){
 const incoming=row.kind==='telegram_update'||row.kind==='browser_input',assistant=row.kind?.endsWith('_delivered_message')===true;
 return (!filters.kind||filters.kind==='incoming'&&incoming||filters.kind==='assistant'&&assistant)
  &&(!filters.scope||row.scope===filters.scope)
  &&(!filters.private_chats||!!filters.private_scopes&&filters.private_scopes.includes(row.scope??'')===(filters.private_chats==='only'))
  &&(!filters.reply||row.kind==='telegram_update'&&(filters.reply==='approval_pending'?actionState==='proposed':filters.reply==='not_started'?!state:state===filters.reply));
}

/** The SQL parameters of the private-chat split for `(<p1>::text[] IS NULL OR (scope=ANY(<p1>))=<p2>)`; a split whose
 * scopes are not resolved matches nothing. */
export function privateChatsParams(filters:ArchiveFilters):[readonly string[]|null,boolean] {
 if(!filters.private_chats)return [null,false];
 return filters.private_scopes?[filters.private_scopes,filters.private_chats==='only']:[[],true];
}
