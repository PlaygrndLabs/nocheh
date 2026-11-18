import {HttpError} from './http.js';
import {chats} from './chats.js';
import {archiveScopes,otherPrivate} from './spaces.js';

/**
 * `private_chats` (step 4) splits the private chats of people other than the owner (members' chats, and the chats of
 * people who wrote to Nocheh privately without being members) from the rest: `hide` leaves them out, `only` keeps only
 * them. The dashboard's Messages list asks for `hide` by default, so these chats never show when the owner shares their
 * screen, and for `only` under its "Members' chats" filter. Without it nothing changes. `private_scopes` is what it
 * resolved to: the events.scope values of those chats, from the chat directory when the filters were read.
 */
export type ArchiveFilters={kind:''|'incoming'|'assistant';scope:string;reply:''|'approval_pending'|'pending'|'running'|'failed'|'done'|'ambiguous'|'suppressed'|'cancelled'|'not_started';
 private_chats?:'hide'|'only';private_scopes?:readonly string[]};

/** The events.scope values of every known private chat that is not the owner's, and of their topics' chats. */
export function otherPrivateScopes():string[] {
 return archiveScopes(chats().all().filter(chat=>otherPrivate(chat.id)).map(chat=>chat.id));
}

export function archiveFilters(input:{get(name:string):string|null}):ArchiveFilters{
 const kind=input.get('kind')??'',scope=input.get('scope')??'',reply=input.get('reply')??'',privateChats=input.get('private_chats')??'';
 if(!['','incoming','assistant'].includes(kind)||scope.length>256||!['','approval_pending','pending','running','failed','done','ambiguous','suppressed','cancelled','not_started'].includes(reply)
  ||!['','hide','only'].includes(privateChats))
  throw new HttpError(400,'invalid_archive_filter');
 return {kind:kind as ArchiveFilters['kind'],scope,reply:reply as ArchiveFilters['reply'],
  ...(privateChats?{private_chats:privateChats as 'hide'|'only',private_scopes:otherPrivateScopes()}:{})};
}

export function matchesArchiveFilters(row:{kind?:string;scope?:string},state:string|undefined,filters:ArchiveFilters,actionState?:string){
 const incoming=row.kind==='telegram_update'||row.kind==='browser_input',assistant=row.kind?.endsWith('_delivered_message')===true;
 return (!filters.kind||filters.kind==='incoming'&&incoming||filters.kind==='assistant'&&assistant)
  &&(!filters.scope||row.scope===filters.scope)
  &&(!filters.private_chats||(filters.private_scopes??[]).includes(row.scope??'')===(filters.private_chats==='only'))
  &&(!filters.reply||row.kind==='telegram_update'&&(filters.reply==='approval_pending'?actionState==='proposed':filters.reply==='not_started'?!state:state===filters.reply));
}

/** The SQL parameters of the private-chat split for `(<p1>::text[] IS NULL OR (scope=ANY(<p1>))=<p2>)`. */
export function privateChatsParams(filters:ArchiveFilters):[readonly string[]|null,boolean] {
 return filters.private_chats?[filters.private_scopes??[],filters.private_chats==='only']:[null,false];
}
