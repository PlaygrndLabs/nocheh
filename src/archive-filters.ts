import {HttpError} from './http.js';

export type ArchiveFilters={kind:''|'incoming'|'assistant';scope:string;reply:''|'pending'|'running'|'failed'|'done'|'ambiguous'|'suppressed'|'cancelled'|'not_started'};

export function archiveFilters(input:{get(name:string):string|null}):ArchiveFilters{
 const kind=input.get('kind')??'',scope=input.get('scope')??'',reply=input.get('reply')??'';
 if(!['','incoming','assistant'].includes(kind)||scope.length>256||!['','pending','running','failed','done','ambiguous','suppressed','cancelled','not_started'].includes(reply))
  throw new HttpError(400,'invalid_archive_filter');
 return {kind:kind as ArchiveFilters['kind'],scope,reply:reply as ArchiveFilters['reply']};
}

export function matchesArchiveFilters(row:{kind?:string;scope?:string},state:string|undefined,filters:ArchiveFilters){
 const incoming=row.kind==='telegram_update'||row.kind==='browser_input',assistant=row.kind?.endsWith('_delivered_message')===true;
 return (!filters.kind||filters.kind==='incoming'&&incoming||filters.kind==='assistant'&&assistant)
  &&(!filters.scope||row.scope===filters.scope)
  &&(!filters.reply||row.kind==='telegram_update'&&(filters.reply==='not_started'?!state:state===filters.reply));
}
