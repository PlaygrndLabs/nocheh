import type pg from 'pg';
import {admin,type Reader} from '../access.js';

/** A person in a group: their Telegram user id, name and state there, and whether the group's own messages show them. */
type Person={id:string;name:string|null;username:string|null;state:'in'|'left';seen:boolean};
/** A group: its Nocheh chat id, its current Telegram id, every Telegram id it has had (current first, then older ones,
 *  such as its id before Telegram upgraded it), its name, and the people Nocheh saw in it. A group is always named by its
 *  Nocheh id: the Telegram ids are only for matching TELEGRAM_GROUP_IDS and asking Telegram. */
type Group={id:string;external:string|null;telegram_ids:string[];name:string|null;users:Person[]};
type Db=Pick<pg.Pool,'query'>;
const GROUPS=100,PEOPLE=5000,AUTHORS=5000,ARRIVALS=1000;

/**
 * The people in the owner's groups (ADR-0252), from the chat records capture keeps: each group's people and bots
 * are chat_accounts, and who is in or left a group is chat_memberships (a person who wrote there, joined, or Telegram
 * said is a member). Bots, anonymous admins and chats posting as themselves are never people here. Names come only from
 * Telegram updates; an id remains the authority, and no message text is read.
 *
 * `seen` says whether the group's own messages show the person, under any Telegram id the group has had: they wrote
 * there, or a message there says they joined. Those are the people the owner's People list shows, as it did before
 * step 2b; someone whose only record is that they left, or a member update, keeps their state here but is not listed.
 * It is read from the archive's author relations and the ids in join messages, as before step 2b, when `archive` is
 * given; without it every person counts as seen.
 */
export async function telegramDirectory(control:Db,principal:Reader,archive:Db|null=null):Promise<{groups:Group[];truncated:boolean}> {
  admin(principal);
  // A group appears once Nocheh saw a message there or anyone in it, as when it was read from the archive.
  const groupRows=(await control.query(`SELECT c.id,c.title,d.username,i.external_id FROM chats c
    JOIN chat_connections n ON n.id=c.connection_id AND n.app='telegram'
    LEFT JOIN chat_ids i ON i.chat_id=c.id AND i.state='current' LEFT JOIN chat_details d ON d.chat_id=c.id
    WHERE c.kind='group' AND (d.seen_at IS NOT NULL OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.chat_id=c.id))
    ORDER BY c.id LIMIT ${GROUPS+1}`)).rows;
  const groups:Group[]=groupRows.slice(0,GROUPS).map(row=>({id:row.id,external:row.external_id??null,telegram_ids:[],
    name:row.title??(row.username?'@'+row.username:null),users:[]}));
  if(!groups.length)return {groups,truncated:groupRows.length>GROUPS};
  const byGroup=new Map(groups.map(group=>[group.id,group]));
  const people=(await control.query(`SELECT m.chat_id,m.state,a.external_id,a.display_name,a.username FROM chat_memberships m
    JOIN chat_accounts a ON a.id=m.account_id WHERE a.kind='human' AND m.chat_id=ANY($1::text[])
    ORDER BY m.chat_id,a.external_id LIMIT ${PEOPLE+1}`,[groups.map(group=>group.id)])).rows;
  const ids=(await control.query(`SELECT i.chat_id,i.external_id FROM chat_ids i JOIN chat_connections n ON n.id=i.connection_id AND n.app='telegram'
    WHERE i.chat_id=ANY($1::text[]) ORDER BY i.chat_id,i.state='current' DESC,i.external_id`,[groups.map(group=>group.id)])).rows as {chat_id:string;external_id:string}[];
  for(const row of ids)byGroup.get(row.chat_id)?.telegram_ids.push(row.external_id);
  const shown=archive?await seenPeople(archive,ids):null;
  for(const row of people.slice(0,PEOPLE))byGroup.get(row.chat_id)?.users.push({id:row.external_id,name:row.display_name??null,
    username:row.username?'@'+row.username:null,state:row.state,seen:!shown||shown.people.has(row.chat_id+'\n'+row.external_id)});
  for(const group of groups)group.users.sort((a,b)=>(a.name??a.username??a.id).localeCompare(b.name??b.username??b.id));
  return {groups,truncated:groupRows.length>GROUPS||people.length>PEOPLE||!!shown?.truncated};
}

/** Who each group's own live messages show, as `chat id + "\n" + Telegram user id`: the authors of its messages (not of
 *  its reactions) and the people its join messages name, under every Telegram id the group has had. Only ids and which
 *  kind of update it is are read. */
async function seenPeople(archive:Db,ids:{chat_id:string;external_id:string}[]):Promise<{people:Set<string>;truncated:boolean}> {
  const chatOf=new Map<string,string>(ids.map(row=>[row.external_id,row.chat_id])),scopes=[...chatOf.keys()],people=new Set<string>();
  if(!scopes.length)return {people,truncated:false};
  const authors=(await archive.query(`SELECT DISTINCT e.scope,o.external_id FROM source_relations r JOIN source_objects o ON o.id=r.target_id
    JOIN events e ON e.id=r.event_id WHERE r.kind='authored_by' AND o.platform='telegram' AND o.namespace='bot-api' AND o.kind='actor'
      AND e.channel='telegram' AND e.origin='live' AND e.kind='telegram_update' AND e.scope=ANY($1::text[])
      AND convert_from(e.payload,'UTF8')::jsonb ?| ARRAY['message','edited_message','channel_post','edited_channel_post'] LIMIT ${AUTHORS+1}`,[scopes])).rows;
  for(const row of authors.slice(0,AUTHORS))people.add(chatOf.get(row.scope)+'\n'+row.external_id);
  const arrivals=(await archive.query(`SELECT e.scope,convert_from(e.payload,'UTF8')::jsonb #> '{message,new_chat_members}' AS members FROM events e
    WHERE e.channel='telegram' AND e.origin='live' AND e.kind='telegram_update' AND e.scope=ANY($1::text[])
      AND (convert_from(e.payload,'UTF8')::jsonb #> '{message,new_chat_members}') IS NOT NULL
    ORDER BY e.received_at DESC,e.id DESC LIMIT ${ARRIVALS+1}`,[scopes])).rows;
  for(const row of arrivals.slice(0,ARRIVALS))for(const member of Array.isArray(row.members)?row.members.slice(0,100):[]) {
    const id=member&&typeof member==='object'&&member.is_bot!==true?member.id:null;
    if(Number.isSafeInteger(id)&&id>0)people.add(chatOf.get(row.scope)+'\n'+String(id));
  }
  return {people,truncated:authors.length>AUTHORS||arrivals.length>ARRIVALS};
}
