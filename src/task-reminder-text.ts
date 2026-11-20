import {canonical,digest} from './archive.js';
import {cardName,visible} from './action-text.js';
import {blankName,calmMarks,fillLine,labelName,nameKey,placeLabel,quotedName,type PlaceWords} from './chat-labels.js';
import {chatShortId,type ChatDirectory} from './chats.js';
import {telegramUsername} from './chats-telegram.js';
import {fillTemplate,type MemberReminderText,type ReminderText} from './prompts.js';

/*
 * The text of a task reminder (ADR-0255). A reminder the owner set in their private chat or the dashboard, on a task
 * nobody else wrote, reads exactly as before. Any other carries lines code writes first and never cuts: who set it and
 * where, who last wrote the task's title, notes or due day elsewhere, and who closed it. Then its task, with a title on
 * one line and notes whose every line carries the note mark, so nothing a person typed can pass for a line code wrote.
 * People's reminders that come due together in one group are merged into one message. Every cut keeps whole characters,
 * and every message stays within Telegram's limit, so no reminder is ever refused for its length. Pure: it reads the
 * chat directory and what it is given.
 */

const ellipsis='\u2026';
/** At most `max` UTF-16 units, one fewer when the cut would split a character in two: the gateway refuses half a
 * character, and a refused reminder never arrives. No ellipsis, so text that fits reads exactly as before. */
export function unitCut(text:string,max:number):string {
  if(text.length<=max)return text;
  if(max<=0)return '';
  const unit=text.charCodeAt(max-1);
  return text.slice(0,unit>=0xd800&&unit<=0xdbff?max-1:max);
}
/** The text with any half character written as U+FFFD (String.prototype.toWellFormed, which ES2022 does not type). */
export const wellFormed=(text:string):string=>text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,'\ufffd');
/** At most `max` characters, ending in an ellipsis when cut, never inside a character written out as [U+XXXX]. */
export function shownCut(text:string,max:number):string {
  const chars=Array.from(text);
  if(chars.length<=max)return text;
  return chars.slice(0,Math.max(0,max-1)).join('').replace(/\[(?:U(?:\+[0-9A-F]{0,6})?)?$/,'')+ellipsis;
}

/**
 * A person's notes as a reminder shows them: hidden characters written out, at most three marks on a letter, runs of
 * spaces as one, lines with nothing to see left out, one empty line between paragraphs, and every line, the empty ones
 * too, after the note mark (`mark`, the note_line text), so a planted line never reads as one code wrote. At most 20
 * lines and 500 characters.
 */
export function noteLines(notes:string,mark:string):string {
  const kept:string[]=[];let gap=false;
  for(const raw of calmMarks(visible(notes.replace(/\r\n/g,'\n'),true)).split('\n')) {
    const line=raw.replace(/[ \t]{2,}/g,' ').trim();
    if(blankName(line)){gap=kept.length>0;continue;}
    if(gap){kept.push('');gap=false;}
    kept.push(line);
  }
  const marked=kept.map(line=>line?fillLine(mark,{line}):fillLine(mark,{line:''}).trimEnd());
  const shown=marked.length>20?[...marked.slice(0,19),fillLine(mark,{line:ellipsis})]:marked;
  return shownCut(shown.join('\n'),500);
}

/** Who set a reminder or wrote a field: the owner, or a person by their account (null when Nocheh could not tell
 * which) and the name Telegram showed for them then. */
export interface Who {by:'owner'|'person';account:string|null;name:string|null}
/** Who last wrote one field of a task anywhere but the owner's private chat or the dashboard, and where: a chat, or the
 * members' app (`via` 'app', step 5), which has no chat. */
export interface Writer extends Who {field:'title'|'notes'|'due'|'closed';chat:string|null;via?:'chat'|'app'}
/** What Telegram last told of an account: its name and public username. */
export interface Person {display_name:string|null;username:string|null}
/** What labels read: the chat directory, the members who reach a served group now (null when not known, so nobody
 * reads as no longer a member), and each account as Telegram last showed it. */
export interface Names {directory:ChatDirectory;allowed:ReadonlyMap<string,readonly string[]>|null;people:ReadonlyMap<string,Person>}
/** The owner's words: the reminder lines, the one set of chat words (the approval texts) and the reminder template. */
export interface Words {lines:Record<ReminderText,string>;places:PlaceWords;template:string}
/** One reminder with its task as a reminder shows it. `chat` is where it was set (null: the owner's private chat, the
 * dashboard, the API or a card, or, with `via` 'app', the members' app, step 5); `due` is the due day in words, `list` the
 * project's name. */
export interface ReminderRow {id:string;at:number;setter:Who;chat:string|null;via?:'chat'|'app';title:string;notes:string;due:string|null;list:string|null;
  closed:boolean;writers:readonly Writer[]}
/** Name keys by who holds them: members now and people in the message, the owner's chat and the served groups and topics. */
export type NameKeys=ReadonlyMap<string,ReadonlySet<string>>;

/** A person's name as labels show it: the name Telegram shows now, then the one it showed when they set the reminder,
 * then their @username. */
function shownName(who:Who,names:Names):{name:string|null;username:string|null;byUsername:boolean} {
  const person=who.account?names.people.get(who.account):undefined,username=telegramUsername(person?.username);
  const name=labelName(person?.display_name)??labelName(who.name);
  if(name!==null)return {name,username,byUsername:false};
  return {name:username?labelName('@'+username):null,username,byUsername:true};
}
const whoKey=(who:Who)=>who.by==='owner'?'owner':who.account?'account:'+who.account:'name:'+(who.name??'');
/** whoKey in SQL over a reminder's stored columns (`alias` such as 'r.'), so the rows read for a merge are chosen by
 * the same turns the merge takes them in. */
export const whoKeySql=(alias:string)=>`CASE WHEN ${alias}set_by='owner' THEN 'owner' WHEN ${alias}set_by_account_id IS NOT NULL
  THEN 'account:'||${alias}set_by_account_id ELSE 'name:'||coalesce(${alias}set_by_name,'') END`;
/** The keys of every name a person's name must not read like: the members now and the people in this message, the
 * owner's chat and every served group and topic. */
export function nameKeys(names:Names,people:Iterable<Who>):NameKeys {
  const keys=new Map<string,Set<string>>(),add=(name:string|null,holder:string)=>{
    if(name===null)return;const key=nameKey(name);keys.set(key,(keys.get(key)??new Set()).add(holder));};
  for(const account of names.allowed?.keys()??[])add(shownName({by:'person',account,name:null},names).name,'person:'+account);
  for(const who of people)if(who.by==='person'&&who.account)add(shownName(who,names).name,'person:'+who.account);
  const directory=names.directory;
  add(labelName(directory.get(directory.ownerChat())?.title),'owner');
  for(const chat of directory.all())if(directory.groupOf(chat.id)!==null&&directory.served(chat.id))add(labelName(chat.title),'chat:'+chat.id);
  return keys;
}
/** A person's short label: their private chat's, the one the dashboard's chat list shows, or one of their account's. */
const personShortId=(account:string,directory:ChatDirectory)=>{
  const chat=directory.all().find(item=>item.kind==='private'&&item.account_id===account);
  return chat?chatShortId(chat.id):digest(canonical(['account-label-v1',account])).slice(0,4);
};
/**
 * Who, in the owner's words: `you`, or a person by the name Telegram shows now, quoted and isolated, as one the owner
 * allowed, or no longer allows. A name that reads like another person's, the owner's chat's or a served chat's gets
 * the person's @username, or else a short id. A person with no account, or nothing left of a name, is unnamed_person.
 */
export function whoLabel(who:Who,words:Words,names:Names,keys:NameKeys):string {
  const line=words.lines;
  if(who.by==='owner')return line.you;
  const shown=who.account?shownName(who,names):null;
  if(!who.account||!shown?.name)return line.unnamed_person;
  const twin=[...keys.get(nameKey(shown.name))??[]].some(holder=>holder!=='person:'+who.account);
  const name=!twin?quotedName(shown.name):shown.username&&!shown.byUsername?quotedName(shown.name)+' @'+shown.username:
    fillLine(words.places.name_id,{name:quotedName(shown.name),id:personShortId(who.account,names.directory)});
  return fillLine(names.allowed&&!names.allowed.has(who.account)?line.person_gone:line.person,{name});
}
/** A chat in the owner's chat words; the members' app (no chat, step 5) as place_app. */
export const placeOf=(chat:string|null,words:Words,names:Names)=>chat===null?words.lines.place_app:placeLabel(chat,words.places,names.directory);
/** Whether a reminder or a write came from the members' app (step 5): a person with no chat. */
const fromApp=(row:{chat:string|null;via?:'chat'|'app'})=>row.via==='app'&&row.chat===null;
/** "Set by {who} in {place}", for a reminder set anywhere but the owner's private chat or the dashboard ("in the members'
 * app" for one a member set there, step 5); else null. */
export function setByLine(row:{setter:Who;chat:string|null;via?:'chat'|'app'},words:Words,names:Names,keys:NameKeys):string|null {
  return row.chat===null&&!fromApp(row)?null:fillLine(words.lines.set_by,{who:whoLabel(row.setter,words,names,keys),place:placeOf(row.chat,words,names)});
}

const fieldLines={title:'field_title',notes:'field_notes',due:'field_due'} as const;
/**
 * One reminder's code lines and body. The lines: who set it (with `setBy`), who last wrote its fields elsewhere, one
 * line per writer and place other than the setter where it was set, and who closed its task. A reminder with any such
 * line, or set anywhere but the owner's private chat, shows its title on one line and its notes marked; any other is
 * the owner's template exactly as before.
 */
function parts(row:ReminderRow,words:Words,names:Names,keys:NameKeys,setBy:boolean):{lines:string[];body:string} {
  const line=words.lines,lines:string[]=[],who=(value:Who)=>whoLabel(value,words,names,keys);
  const set=setBy?setByLine(row,words,names,keys):null;if(set)lines.push(set);
  const writers=new Map<string,{who:Who;chat:string|null;fields:string[]}>();
  for(const field of ['title','notes','due'] as const)for(const writer of row.writers.filter(item=>item.field===field)) {
    if(writer.chat===row.chat&&fromApp(writer)===fromApp(row)&&whoKey(writer)===whoKey(row.setter))continue;
    const key=whoKey(writer)+'\n'+(writer.chat??'app'),entry=writers.get(key)??{who:writer,chat:writer.chat,fields:[]};
    entry.fields.push(line[fieldLines[field]]);writers.set(key,entry);
  }
  for(const entry of writers.values())lines.push(fillLine(line.written_by,{who:who(entry.who),place:placeOf(entry.chat,words,names),fields:entry.fields.join(', ')}));
  const closer=row.closed?row.writers.find(item=>item.field==='closed'):undefined;
  if(closer)lines.push(fillLine(line.closed_by,{who:who(closer),place:placeOf(closer.chat,words,names)}));
  const body=row.chat!==null||fromApp(row)||lines.length
    ?fillTemplate(words.template,{title:cardName(calmMarks(row.title),300),due:row.due,list:row.list,notes:row.notes?noteLines(row.notes,line.note_line)||null:null})
    :fillTemplate(words.template,{title:row.title,due:row.due,list:row.list,notes:row.notes?unitCut(row.notes,500):null});
  return {lines,body};
}

/** A message of code lines and a body within `limit` UTF-16 units: the lines are kept whole and the body is cut, with an
 * ellipsis. Only lines that alone pass the limit, which only an owner's very long line can make, are cut too. */
export function fitMessage(lines:readonly string[],body:string,limit=4000):string {
  const head=lines.length?lines.join('\n')+'\n':'';
  if(head.length+body.length<=limit)return wellFormed(head+body);
  const room=limit-head.length-1;
  return wellFormed(room>0?head+unitCut(body,room)+ellipsis:unitCut(head+body,limit-1)+ellipsis);
}
/** The owner's own reminder (one message per reminder): its code lines, then its task. */
export function reminderText(row:ReminderRow,words:Words,names:Names,limit=4000):string {
  const {lines,body}=parts(row,words,names,nameKeys(names,[row.setter,...row.writers]),true);
  return fitMessage(lines,body,limit);
}

const byDue=(a:ReminderRow,b:ReminderRow)=>a.at-b.at||(a.id<b.id?-1:a.id>b.id?1:0);
/** Each setter's first reminder, setters in the order of their first due one; then each one's second; and so on. */
function roundRobin(rows:readonly ReminderRow[]):ReminderRow[] {
  const lists=new Map<string,ReminderRow[]>();
  for(const row of [...rows].sort(byDue)){const key=whoKey(row.setter),list=lists.get(key);if(list)list.push(row);else lists.set(key,[row]);}
  const order:ReminderRow[]=[],all=[...lists.values()];
  for(let round=0;order.length<rows.length;round++)for(const list of all)if(round<list.length)order.push(list[round]!);
  return order;
}
/**
 * People's reminders due in one group (`group`) as one message within `limit`: taken round-robin by who set them, so
 * one person's many never hold back another's, as many as fit and always at least one (its body cut to fit). The
 * message has the `merged` header when it holds more than one, then for each setter and place, in order of the first
 * due, one set_by line and their reminders, and the more_waiting line when `waiting` more, or rows left out, wait.
 */
export function mergedReminder(rows:readonly ReminderRow[],words:Words,names:Names,group:string,waiting=0,limit=4000):{text:string;taken:ReminderRow[]} {
  if(!rows.length)return {text:'',taken:[]};
  const line=words.lines,ordered=roundRobin(rows),keys=nameKeys(names,rows.flatMap(row=>[row.setter,...row.writers]));
  const blocks=new Map(ordered.map(row=>[row.id,parts(row,words,names,keys,false)] as const)),place=placeOf(group,words,names),setBy=new Map<string,string>();
  const compose=(taken:readonly ReminderRow[],body?:string)=>{
    const sections=new Map<string,{row:ReminderRow;blocks:string[]}>();
    for(const row of [...taken].sort(byDue)) {
      const key=whoKey(row.setter)+'\n'+(row.chat??(fromApp(row)?'app':'')),part=blocks.get(row.id)!,section=sections.get(key)??{row,blocks:[]};
      section.blocks.push([...part.lines,body??part.body].join('\n'));sections.set(key,section);
    }
    const rest=rows.length-taken.length+waiting;
    return [taken.length>1?fillLine(line.merged,{count:String(taken.length),place}):'',
      ...[...sections].map(([key,section])=>{
        if(!setBy.has(key))setBy.set(key,setByLine(section.row,words,names,keys)??'');
        const head=setBy.get(key)!;return (head?head+'\n':'')+section.blocks.join('\n\n');
      }),
      rest>0?fillLine(line.more_waiting,{count:String(rest),place}):''].filter(Boolean).join('\n\n');
  };
  let count=1;
  while(count<ordered.length&&compose(ordered.slice(0,count+1)).length<=limit)count++;
  const taken=ordered.slice(0,count),text=compose(taken);
  if(text.length<=limit)return {text:wellFormed(text),taken};
  // One reminder alone is too long: its body is cut so the lines around it stay whole.
  const room=limit-compose(taken,'').length-1,body=blocks.get(taken[0]!.id)!.body;
  return {text:wellFormed(room>0?compose(taken,unitCut(body,room)+ellipsis):unitCut(text,limit-1)+ellipsis),taken};
}

/** A member's words for a reminder of their own (step 5, ADR-0265 D9): the members.reminder template and the
 * members.reminder_texts lines, which the owner edits like every bot text. */
export interface MemberWords {template:string;lines:Record<MemberReminderText,string>}
/**
 * The reminder a member set, as it goes to their own private chat with Nocheh (step 5, ADR-0265 D9): the task's title on
 * one line, its due day (written in the tasks' one time zone, as the task holds it), its project's name and its notes,
 * every line of them marked, then the set_by line ("Set by you"), never cut. Nothing else: no line says who else wrote or
 * closed the task or where, and no chat, group or person is named, because who last wrote a task is kept for the owner
 * without regard to what this member sees now or when the task joined their board. Within `limit` UTF-16 units, the
 * body cut with an ellipsis when it must be.
 */
export function memberReminderText(row:Pick<ReminderRow,'title'|'notes'|'due'|'list'>,words:MemberWords,limit=4000):string {
  const body=fillTemplate(words.template,{title:cardName(calmMarks(row.title),300),due:row.due,list:row.list,
    notes:row.notes?noteLines(row.notes,words.lines.note_line)||null:null});
  const tail='\n\n'+words.lines.set_by;
  if(body.length+tail.length<=limit)return wellFormed(body+tail);
  const room=limit-tail.length-1;
  return wellFormed(room>0?unitCut(body,room)+ellipsis+tail:unitCut(words.lines.set_by,limit));
}
