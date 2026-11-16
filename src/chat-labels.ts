import {cardName,likeOf,skeletonOf} from './action-text.js';
import {chatShortId,chats,type ChatDirectory} from './chats.js';
import type {ApprovalText} from './prompts.js';

/*
 * How a send card, a notice and a reminder name a chat or a person (ADR-0254, ADR-0255). The kind of chat is always in
 * fixed words the owner can edit; only the name someone chose is quoted, inside quotes and direction isolates that code
 * adds, so a name cannot close the quotes, pass for the fixed words, or turn the line around it. Pure: it reads the
 * chat directory's titles and nothing else.
 */

/** Text kept in its own direction: a right-to-left name cannot reorder the fixed words around it. */
export const isolate=(text:string)=>'\u2068'+text+'\u2069';
/** A name in the quotes code adds, isolated. */
export const quotedName=(name:string)=>isolate('\u201c'+name+'\u201d');

/** How a character a reader would not see, or a mark past the third, is written out. */
const written=(char:string)=>'[U+'+char.codePointAt(0)!.toString(16).toUpperCase().padStart(4,'0')+']';
/** At most three marks on one letter: more stack into a smear that can hide or fake the line above. The rest are
 * written out. A Persian shadda and a vowel, or a letter and two accents, stay as typed. */
export function calmMarks(text:string):string {
  return text.replace(/(^|\P{M})(\p{M}{4,})/gu,(_,base:string,marks:string)=>{const list=Array.from(marks);return base+list.slice(0,3).join('')+list.slice(3).map(written).join('');});
}

/** Quote, bracket and angle look-alikes, as a name shows them: plain ' [ ] < >, so a name never draws the quotes, the
 * brackets or the › that code puts around and between names. */
const angleRight=/^[\u203a\u276f\u1433\u3009\uff1e]$/u,angleLeft=/^[\u2039\u276e\u1438\u3008\uff1c]$/u;
// Quotes Unicode files as symbols or as brackets, such as the low quotes and the ornaments, count as quotes too.
const quoteMark=/^[\p{Pi}\p{Pf}"'`\u00b4\uff02\uff07\u02ba\u02dd\u02ee\u3003\u05f4\u201a\u201e\u2033\u2036\u275b-\u2760\u2e42\u301d-\u301f\u{1f676}-\u{1f678}]$/u;
const opening=/^\p{Ps}$/u,closing=/^\p{Pe}$/u;
const quoteLike=new Set(['"',"'","''",'`']),openLike=new Set(['(','[','{']),closeLike=new Set([')',']','}']);
function plainMark(char:string):string {
  const like=likeOf(char);
  if(like==='>'||angleRight.test(char))return '>';
  if(like==='<'||angleLeft.test(char))return '<';
  if(quoteMark.test(char)||quoteLike.has(like))return "'";
  if(opening.test(char)||openLike.has(like))return '[';
  if(closing.test(char)||closeLike.has(like))return ']';
  return char;
}

/** Whether nothing a reader would see is left of a shown name: only written-out characters and spaces. */
export const blankName=(name:string|null):boolean=>!name||!name.replace(/\[U\+[0-9A-F]{4,6}\]/g,'').replace(/\s/g,'');

/**
 * A name someone else chose (a chat's title, a person's name) as a label shows it: an ellipsis written as three dots,
 * so only a cut ends in one; at most three marks on a letter; quote, bracket and angle look-alikes made plain; then on
 * one line with its hidden characters written out, a Persian half-space and an emoji's joiners kept, and cut to
 * `length` characters without splitting one written out (cardName). Null when nothing a reader would see is left.
 */
export function labelName(value:unknown,length=64):string|null {
  if(typeof value!=='string')return null;
  const name=cardName(Array.from(calmMarks(value.replaceAll('\u2026','...')),plainMark).join(''),length);
  return blankName(name)?null:name;
}

/** A key that names reading alike share: the skeleton (UTS #39), lower-cased, and its skeleton again, so 'BiII' and
 * 'Bill', or 'Family' written with a Cyrillic a and 'family', meet. */
export const nameKey=(name:string):string=>skeletonOf(skeletonOf(name).toLowerCase());

/** One line filled in one pass: a value that holds {place} or another name stays as written, and the line is never
 * dropped, whatever is missing. A name with no value stays as it is. */
export const fillLine=(line:string,values:Readonly<Record<string,string>>):string=>
  line.replace(/\{([a-z_]+)\}/g,(whole,name:string)=>Object.hasOwn(values,name)?values[name]!:whole);

/** The owner's words for chats, from the approval texts: the one set every label uses. */
export type PlaceWords=Pick<Record<ApprovalText,string>,'private_chat'|'group_chat'|'topic'|'topic_name'|'unnamed_group'|'unnamed_topic'|'general_topic'|
  'unnamed_person'|'unknown_chat'|'not_served'|'person_chat_other'|'name_id'>;

/** The name keys of a directory's served groups, by group. */
const keys=new WeakMap<ChatDirectory,ReadonlyMap<string,string>>();
function servedKeys(directory:ChatDirectory):ReadonlyMap<string,string> {
  let found=keys.get(directory);
  if(!found) {
    const named=directory.all().filter(chat=>chat.kind==='group'&&directory.served(chat.id)).map(chat=>[chat.id,labelName(chat.title)] as const);
    found=new Map(named.filter((entry):entry is readonly [string,string]=>entry[1]!==null).map(([id,name])=>[id,nameKey(name)]));
    keys.set(directory,found);
  }
  return found;
}

/**
 * A chat in plain words from the directory's titles, for notices and reminder lines: the owner's private chat (or a
 * topic of it); a person's private chat; a group, quoted, with its short id when it has no name or reads like another
 * served group's; a topic after its group; and (not served now) after a group or topic Nocheh does not serve now, which
 * only a group can be. With `general`, a forum group itself is its General topic.
 */
export function placeLabel(space:string,words:PlaceWords,directory:ChatDirectory=chats(),at:{general?:boolean}={}):string {
  const chat=directory.get(space);
  if(!chat)return words.unknown_chat;
  if(directory.isOwner(space))return words.private_chat;
  const base=chat.kind==='topic'?directory.get(chat.parent_id)??chat:chat;
  if(base.kind==='private') {
    const name=labelName(base.title);
    return fillLine(words.person_chat_other,{name:name?quotedName(name):fillLine(words.unnamed_person,{id:chatShortId(base.id)})});
  }
  const name=labelName(base.title),key=name===null?null:nameKey(name);
  const twin=key!==null&&[...servedKeys(directory)].some(([id,other])=>id!==base.id&&other===key);
  const short=(label:string)=>fillLine(words.name_id,{name:label,id:chatShortId(base.id)});
  let label=name===null?short(words.unnamed_group):fillLine(words.group_chat,{name:twin?short(quotedName(name)):quotedName(name)});
  if(chat.kind==='topic') {
    const topic=labelName(chat.title);
    label+=' '+fillLine(words.topic,{topic:topic===null?words.unnamed_topic:fillLine(words.topic_name,{name:quotedName(topic)})});
  }else if(at.general&&base.is_forum)label+=' '+fillLine(words.topic,{topic:words.general_topic});
  return directory.served(base.id)?label:label+' '+words.not_served;
}
