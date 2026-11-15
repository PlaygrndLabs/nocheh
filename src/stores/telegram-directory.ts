import type pg from 'pg';
import {admin,type Reader} from '../access.js';

type Person={id:string;name:string|null;username:string|null;state:'in'|'left'};
/** A group: its Nocheh chat id, its current Telegram id, its name, and the people Nocheh saw in it. */
type Group={id:string;external:string|null;name:string|null;users:Person[]};
const GROUPS=100,PEOPLE=5000;

/**
 * The people in the owner's groups (ADR-0251), from the chat records capture keeps: each group's people and bots
 * are chat_accounts, and who is in or left a group is chat_memberships (a person who wrote there, joined, or Telegram
 * said is a member). Bots, anonymous admins and chats posting as themselves are never people here. Names come only from
 * Telegram updates; an id remains the authority, and no message text is read.
 */
export async function telegramDirectory(control:pg.Pool,principal:Reader):Promise<{groups:Group[];truncated:boolean}> {
  admin(principal);
  // A group appears once Nocheh saw a message there or anyone in it, as when it was read from the archive.
  const groupRows=(await control.query(`SELECT c.id,c.title,d.username,i.external_id FROM chats c
    JOIN chat_connections n ON n.id=c.connection_id AND n.app='telegram'
    LEFT JOIN chat_ids i ON i.chat_id=c.id AND i.state='current' LEFT JOIN chat_details d ON d.chat_id=c.id
    WHERE c.kind='group' AND (d.seen_at IS NOT NULL OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.chat_id=c.id))
    ORDER BY c.id LIMIT ${GROUPS+1}`)).rows;
  const groups:Group[]=groupRows.slice(0,GROUPS).map(row=>({id:row.id,external:row.external_id??null,
    name:row.title??(row.username?'@'+row.username:null),users:[]}));
  if(!groups.length)return {groups,truncated:groupRows.length>GROUPS};
  const people=(await control.query(`SELECT m.chat_id,m.state,a.external_id,a.display_name,a.username FROM chat_memberships m
    JOIN chat_accounts a ON a.id=m.account_id WHERE a.kind='human' AND m.chat_id=ANY($1::text[])
    ORDER BY m.chat_id,a.external_id LIMIT ${PEOPLE+1}`,[groups.map(group=>group.id)])).rows;
  const byGroup=new Map(groups.map(group=>[group.id,group]));
  for(const row of people.slice(0,PEOPLE))byGroup.get(row.chat_id)?.users.push({id:row.external_id,name:row.display_name??null,
    username:row.username?'@'+row.username:null,state:row.state});
  for(const group of groups)group.users.sort((a,b)=>(a.name??a.username??a.id).localeCompare(b.name??b.username??b.id));
  return {groups,truncated:groupRows.length>GROUPS||people.length>PEOPLE};
}
