/**
 * Where each note or past conversation that the owner's recall of Hermes's own notes finds comes from (ADR-0251), in
 * Nocheh's fixed words: the owner's private chat, a group or topic by its name, or a private answer by where it was
 * asked, the same name that answer's first line gave it (ADR-0249). Hermes says whose profile a hit is in, by its Nocheh
 * chat id; Nocheh names it here from the chat directory, never from the id's shape (ADR-0252), and no chat ID goes on. Only the owner recalls across chats, and the owner can already list every
 * chat by name, so a label shows nothing new; it only stops a group's note from reading as the owner's own.
 */
import type pg from 'pg';
import {chats} from '../chats.js';
import {graphGroupLabel} from '../graph-labels.js';

type Pools={archive:Pick<pg.Pool,'query'>;control:Pick<pg.Pool,'query'>};
/** What Hermes says about the profile a hit is in. */
export type RecallWhere={space?:unknown;owner?:unknown;answer?:unknown;answer_group?:unknown};

/** The label words, in one place. A private answer is told apart before the owner's own chat, since its profile names
 *  the owner's private chat but is never the owner's; anything Nocheh cannot name never gets the owner's label. */
export const recallPlaceWords={owner:'Your private chat',answer:'Private answer asked in {group}',answerUnknown:'A private answer',
  group:'A Telegram group',topic:'a topic',unknown:'A chat Nocheh can’t name'} as const;

// Control, format, separator, private-use and lone surrogate characters could end a label or hide text inside it. The
// joiners and directional marks that Persian and Arabic names need (U+200C to U+200F) stay.
const hidden=/[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|(?![\u200c-\u200f])\p{Cf}/gu;
// Brackets, quotes and their look-alikes, so a name cannot close its own quotes or pass for Nocheh's own marks.
const framing=/[[\]\uff3b\uff3d"\u201c-\u201f\u2033\u2036\u02ee\u275d\u275e\u301d-\u301f\uff02\u05f4]/gu;
const tidy=(text:string,size:number)=>Array.from(text.replace(hidden,' ').replace(/\s+/g,' ').trim()).slice(0,size).join('').trim();
/** A chat or topic name for a label: at most `size` characters (64 by default), without the characters above, on one
 *  line. A person's name in a source tag is cleaned the same way (tagName). */
export const placeName=(value:unknown,size=64):string=>typeof value==='string'?tidy(value.replace(framing,' '),size):'';

/** The label for one hit. `names` holds each group's and topic's name by its ID, from recallNames. */
export function recallPlace(where:RecallWhere,names:ReadonlyMap<string,string>):string {
  if(where.answer===true) {
    // The receipt keeps the answer's first-line wording, quotes included; only brackets and hidden characters go.
    const group=typeof where.answer_group==='string'?tidy(where.answer_group.replace(/[[\]]/g,' '),300):'';
    return group?recallPlaceWords.answer.replace('{group}',()=>group):recallPlaceWords.answerUnknown;
  }
  if(where.owner===true)return recallPlaceWords.owner;
  // The group itself, or a group topic's group; a private chat, its topics and a chat with no row name no group.
  const space=typeof where.space==='string'?where.space:'',chat=chats().groupOf(space);
  if(chat===null)return recallPlaceWords.unknown;
  const group=names.get(chat),title=group?`“${group}”`:recallPlaceWords.group;
  return chat===space?title:title+' › '+(names.get(space)||recallPlaceWords.topic);
}

/**
 * The names of the groups and topics among `spaces` (Nocheh chat ids), from what Nocheh already saved: a group's from
 * its latest captured message under any Telegram id it has had, else from its chat row (the name its updates showed, or
 * the one the owner's last Telegram refresh recorded while that refresh found the chat); a topic's from its latest
 * creation, edit or reply to its first message among the group's recent messages, else from its topic row (the name the
 * owner gave it, or the one Telegram last showed).
 * A failed lookup leaves names out, so a hit is labelled by its kind and recall never fails over a name.
 * `shownOnly` keeps only names Telegram showed, for a group member's tags (ADR-0259): a chat row's name counts only when
 * Telegram showed it (observed or refreshed), so a topic only the owner named reads as a topic with no name.
 */
export async function recallNames(stores:Pools,spaces:string[],options:{shownOnly?:boolean}={}):Promise<Map<string,string>> {
  const names=new Map<string,string>(),directory=chats();
  const known=spaces.filter(space=>directory.groupOf(space)!==null);
  const groups=[...new Set(known.map(space=>directory.groupOf(space)!))],topics=[...new Set(known.filter(space=>directory.kind(space)==='topic'))];
  if(!groups.length)return names;
  const set=(id:string,value:unknown)=>{const name=placeName(value);if(name)names.set(id,name);};
  const newer=(a:{received_at:Date;id:string},b:{received_at:Date;id:string})=>
    a.received_at.getTime()!==b.received_at.getTime()?a.received_at.getTime()>b.received_at.getTime():a.id>b.id;
  try {
    // A name the owner's refresh recorded counts only while that refresh found the chat, as before step 2b.
    for(const row of (await stores.control.query(`SELECT c.id,c.title FROM chats c LEFT JOIN chat_details d ON d.chat_id=c.id
      WHERE c.id=ANY($1::text[]) AND c.title IS NOT NULL AND (c.title_source IS DISTINCT FROM 'refreshed' OR d.refreshed_state='available')
        AND (NOT $2::boolean OR c.title_source IN ('observed','refreshed'))`,
      [[...groups,...topics],options.shownOnly===true])).rows)set(String(row.id),row.title);
  }catch{}
  try {
    // A captured message names its group as the chat list does; it wins over the chat row. The archive keeps each
    // original under the Telegram id the group had then, so every one it has had is read, and the latest message wins.
    const pairs=groups.flatMap(group=>directory.rawScopes([group],'telegram').map(scope=>[group,scope] as const)),latest=new Map<string,any>();
    for(const row of (await stores.archive.query(`SELECT c.chat,c.scope,e.payload,e.received_at,e.id FROM unnest($1::text[],$2::text[]) AS c(chat,scope)
      CROSS JOIN LATERAL (
      SELECT payload,received_at,id FROM events WHERE scope=c.scope AND channel='telegram' AND kind IN ('telegram_update','telegram_delivered_message')
        AND CASE WHEN pg_input_is_valid(convert_from(payload,'UTF8'),'jsonb')
          THEN convert_from(payload,'UTF8')::jsonb ?| ARRAY['message','edited_message','channel_post','edited_channel_post'] ELSE false END
      ORDER BY received_at DESC,id DESC LIMIT 1) e`,[pairs.map(pair=>pair[0]),pairs.map(pair=>pair[1])])).rows) {
      const seen=latest.get(String(row.chat));if(!seen||newer(row,seen))latest.set(String(row.chat),row);
    }
    for(const [chat,row] of latest)set(chat,graphGroupLabel(row.payload,String(row.scope)));
  }catch{}
  if(topics.length)try {
    // Only the group's latest 500 messages under each of its Telegram ids are read; a topic named nowhere there keeps its
    // row's name or none. The directory gives the topic's group and its key, Telegram's thread id.
    const triples=topics.flatMap(topic=>{const key=directory.get(topic)?.topic_key;
      return key?directory.rawScopes([topic],'telegram').map(scope=>[topic,scope,key] as const):[];}),best=new Map<string,any>();
    for(const row of (await stores.archive.query(`SELECT c.chat,t.name,t.edited,t.received_at,t.id FROM unnest($1::text[],$2::text[],$3::text[]) AS c(chat,scope,topic)
      CROSS JOIN LATERAL (
      SELECT name,edited,received_at,id FROM (SELECT received_at,id,m ? 'forum_topic_edited' AS edited,coalesce(m#>>'{forum_topic_edited,name}',m#>>'{forum_topic_created,name}',
          CASE WHEN m#>>'{reply_to_message,message_id}'=c.topic THEN m#>>'{reply_to_message,forum_topic_created,name}' END) AS name
        FROM (SELECT received_at,id,coalesce(p->'message',p->'edited_message',p) AS m FROM (
          SELECT received_at,id,CASE WHEN pg_input_is_valid(convert_from(payload,'UTF8'),'jsonb') THEN convert_from(payload,'UTF8')::jsonb ELSE '{}'::jsonb END AS p
          FROM events WHERE scope=c.scope AND channel='telegram' AND kind IN ('telegram_update','telegram_delivered_message')
          ORDER BY received_at DESC,id DESC LIMIT 500) recent) messages
        WHERE m->>'message_thread_id'=c.topic) named
      WHERE name IS NOT NULL ORDER BY edited DESC,received_at DESC,id DESC LIMIT 1) t`,
      [triples.map(item=>item[0]),triples.map(item=>item[1]),triples.map(item=>item[2])])).rows) {
      // As within one Telegram id: an edit's name first, then the latest.
      const seen=best.get(String(row.chat));
      if(!seen||(row.edited!==seen.edited?row.edited===true:newer(row,seen)))best.set(String(row.chat),row);
    }
    for(const [topic,row] of best)set(topic,row.name);
  }catch{}
  return names;
}

/** Recall's result with each hit's place in words in place of what Hermes said about its profile. */
export async function withRecallPlaces(stores:Pools,result:unknown):Promise<unknown> {
  const value=result as {hits?:unknown};
  if(!value||typeof value!=='object'||!Array.isArray(value.hits))return result;
  const hits=value.hits.filter((hit):hit is Record<string,unknown>=>!!hit&&typeof hit==='object'&&!Array.isArray(hit));
  const spaces=hits.filter(hit=>hit.answer!==true&&hit.owner!==true&&typeof hit.space==='string').map(hit=>hit.space as string);
  const names=await recallNames(stores,spaces);
  return {...value,hits:hits.map(hit=>{
    const {space,owner,answer,answer_group,...rest}=hit;
    return {profile:rest.profile,place:recallPlace({space,owner,answer,answer_group},names),...rest};
  })};
}
