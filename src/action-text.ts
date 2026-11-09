import {canonical} from './archive.js';
import {confusables} from './confusables.js';
import {fillTemplate,lineKept} from './prompts.js';

/** While a card is filled, \u0001K\u0002text\u0003 marks text for one Telegram entity: K is the number of
 * a link's address, or b (bold), c (a quote shown whole), q (a quote that opens on a tap) or p (preformatted).
 * \u0004 and \u0005 open and close the part that folds into one quote, which opens on a tap; it holds only bold
 * text. These control characters are removed from owner text and escaped in every argument and summary, so
 * nothing else can make one. */
export const controls=/[\u0001-\u0005]/g;
export const marked=/\u0001(\d+|[bcqp])\u0002([^\u0001-\u0005]*)\u0003/g;
const pieces=new RegExp(marked.source+'|[\\u0004\\u0005]','g');
const mark=(kind:'b'|'c'|'q'|'p',text:string)=>text?`\u0001${kind}\u0002${text}\u0003`:'';
/** Bold text on a card, such as a change's name on a list card. */
export const heading=(text:string)=>mark('b',text);
/** Telegram's limit of entities on one message. */
export const entityLimit=100;
/** A Telegram entity on a card's plain text: a t.me link over a name, or the formatting of an operation's arguments. */
export type Link={offset:number;length:number;url:string}|{type:'bold'|'blockquote'|'expandable_blockquote'|'pre';offset:number;length:number};
const formats={b:'bold',c:'blockquote',q:'expandable_blockquote',p:'pre'} as const;

/** Plain card text with its Telegram entities; offsets count UTF-16 units, as Telegram's do. */
export function linked(text:string,urls:string[]=[]):{text:string;links:Link[]} {
  let shown='',last=0,fold:{type:'expandable_blockquote';offset:number;length:number}|null=null;const links:Link[]=[];
  for(const match of text.matchAll(pieces)) {
    shown+=text.slice(last,match.index);last=match.index+match[0].length;
    if(match[0]==='\u0004'){fold??={type:'expandable_blockquote',offset:shown.length,length:0};links.push(fold);continue;}
    if(match[0]==='\u0005'){if(fold)fold.length=shown.length-fold.offset;fold=null;continue;}
    const [key,label]=[match[1]!,match[2]!];
    if(label)links.push(key in formats?{type:formats[key as keyof typeof formats],offset:shown.length,length:label.length}:
      {offset:shown.length,length:label.length,url:urls[Number(key)]!});
    shown+=label;
  }
  shown+=text.slice(last);
  if(fold)fold.length=shown.length-fold.offset;
  return {text:shown,links:links.filter(link=>link.length>0)};
}
/** A card cut to `room` units, its entities cut to what is left; never between the two units of one character. */
export function cut(card:{text:string;links:Link[]},room:number):{text:string;links:Link[]} {
  if(card.text.length<=room)return card;
  const high=(unit:number)=>unit>=0xd800&&unit<=0xdbff,end=room-1-(high(card.text.charCodeAt(room-2))?1:0);
  return {text:card.text.slice(0,end)+'…',links:card.links.filter(link=>link.offset<end).map(link=>({...link,length:Math.min(link.length,end-link.offset)}))};
}
/** An operation is shown in words while it stays this short and plain; otherwise as its exact JSON. */
const wordsLimit=3000,wordsEntities=90;

/** The owner-editable words an operation's name is made of, and the heading of its folded exact arguments. */
export type OperationWords={kind_shell:string;kind_browser:string;kind_tools:string;details:string};
/** An operation as an approval card shows it: its name, what the asker says it does, and its exact arguments. */
export type OperationText={title:string;summary:string|null;body:string};

/** Characters a reader cannot see, or that change how the text around them reads: controls such as a tab,
 * format characters such as zero-width and direction marks, private-use and unassigned code points, lone
 * surrogates, separators, default-ignorable characters such as variation selectors and blank fillers,
 * spaces other than the plain one, and signs drawn blank, such as the blank braille pattern. */
const unseenClass='[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\u2800\\u2d7f\\ufffc\\u{16fe4}\\u{1d159}]';
const unseen=new RegExp(unseenClass,'u'),unseenAll=new RegExp(unseenClass,'gu');
/** A whole emoji as Unicode recommends it: its joiners and selectors make one picture, so they show. */
const emoji=new RegExp('\\p{RGI_Emoji}','gv');
/** Persian and Arabic letters that join on both sides, and those that join only the letter before them: a
 * non-joiner after the first and before either visibly breaks the word, as inside many Persian words;
 * anywhere else it shows nothing. */
const joinsBoth='\u0626\u0628\u062a-\u062e\u0633-\u063a\u0640-\u0647\u0649\u064a\u066e\u066f\u0678-\u0687\u069a-\u06bf\u06c1\u06c2\u06cc\u06ce\u06d0\u06d1\u06fa-\u06fc\u06ff';
const joinsBefore='\u0622-\u0625\u0627\u0629\u062f-\u0632\u0648\u0671-\u0673\u0675-\u0677\u0688-\u0699\u06c0\u06c3-\u06cb\u06cd\u06cf\u06d2\u06d3\u06d5\u06ee\u06ef';
const joinsAfter=new RegExp(`^[${joinsBoth}]$`,'u'),joined=new RegExp(`^[${joinsBoth}${joinsBefore}]$`,'u');
/** Arabic marks, such as a shadda or a kasra, which the joining of the letter they sit on passes through. */
const transparent=/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/u;
/** Whether the hidden character at a UTF-16 offset of text shows as intended: a joiner or selector inside a
 * whole emoji, or a non-joiner after a Persian or Arabic letter that joins on both sides, with any marks it
 * carries, and before one that joins the letter before it. */
function shows(text:string):(offset:number)=>boolean {
  const pictures=new Set<number>();
  for(const match of text.matchAll(emoji))for(let unit=match.index;unit<match.index+match[0].length;unit++)pictures.add(unit);
  return offset=>{
    if(pictures.has(offset))return true;
    let letter=offset-1;
    while(transparent.test(text[letter]??''))letter--;
    return text[offset]==='\u200c'&&joinsAfter.test(text[letter]??'')&&joined.test(text[offset+1]??'');
  };
}
/** Whether text is in its composed Unicode form, but for the order of the marks on one letter, which reads the
 * same and is how Arabic and Persian with a shadda and a vowel are often typed. */
const sortedChars=(text:string)=>Array.from(text).sort().join('');
const composed=(text:string)=>{const form=text.normalize('NFC');return form===text||sortedChars(form)===sortedChars(text);};
/** Whether text holds a character a reader would not see, or reads the same as other text, as a letter and
 * its accent written apart do. Where `breaks` is true, line breaks count as seen, but a space at the end of a
 * line does not show, as in a command whose `\ ` reads as a line continuation. */
function hidden(text:string,breaks:boolean):boolean {
  if(!composed(text)||breaks&&/ (?=\n|$)/.test(text))return true;
  if(!unseen.test(text))return false;
  const kept=shows(text);
  return [...text.matchAll(unseenAll)].some(match=>!(breaks&&match[0]==='\n')&&!kept(match.index));
}
/** JSON with every character a reader would not see written as its \u code, except those that show as
 * intended; when it reads the same as other text, every character beyond plain ASCII is written so. */
const code=(char:string)=>Array.from({length:char.length},(_,index)=>'\\u'+char.charCodeAt(index).toString(16).padStart(4,'0')).join('');
const ascii=(json:string)=>json.replace(/[^\x20-\x7e]/gu,code);
function escaped(json:string):string {
  // Whether text is composed, and what of it shows, is judged on the text itself, never on the escapes JSON
  // writes into it: the last digit of \\u0001 and a selector after it would make a keycap emoji.
  const text=json.replace(/\\(?:u[0-9a-fA-F]{4}|[^])/g,escape=>' '.repeat(escape.length));
  if(!composed(text))return ascii(json);
  const kept=shows(text);
  return json.replace(unseenAll,(char,offset:number)=>kept(offset)?char:code(char));
}
const exact=(text:string)=>escaped(JSON.stringify(text));
/** Arguments as their exact JSON, every character a reader would not see written out. */
export const exactJson=(args:unknown)=>escaped(canonical(args));
/** Text as written, or quoted, with its hidden characters written out, when it has any or could pass for
 * text quoted that way. */
const shown=(text:string,breaks=false)=>hidden(text,breaks)||text.startsWith('"')?exact(text):text;

// A value that starts a new line, or is long, goes in a quote, so a label's own line never breaks. Only text
// longer than this opens on a tap; shorter text is shown whole, so nothing short hides below its first lines.
const quoteLimit=200;
const lineBreak=/[\n\r\v\f\u0085\u2028\u2029]/;
const isLong=(value:unknown)=>typeof value==='string'&&(value.length>quoteLimit||lineBreak.test(value));
const isScalar=(value:unknown)=>value===null||typeof value!=='object';
const isShort=(value:unknown)=>isScalar(value)&&!isLong(value);
const isObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const plain=(text:string)=>text.replace(controls,'');
/** Whether text reads as another JSON value, such as 5, true, null or []. */
const json=(text:string)=>{try{JSON.parse(text);return true;}catch{return false;}};

/** A key or a list item's number; the keys that lead to a value make its label, joined by ›. */
type Step=string|number;
type Leaf={path:Step[];value:unknown};
type Group={name:string;leaves:Leaf[];groups:Group[]};

/** A key as written when it is made only of letters and marks of one script, digits, spaces and a few plain
 * signs, so it cannot hold the › and : of a label or a look-alike of them; otherwise, or when it is a number,
 * has spaces at either end or hides a character, quoted. */
const plainKey=/^[\p{L}\p{M}0-9\u0660-\u0669\u06f0-\u06f9\u200c _\-.()/&'+#%@,]+$/u,digits=/^[0-9\u0660-\u0669\u06f0-\u06f9]+$/u;
/** The scripts a plain key's letters, marks and Persian or Arabic digits all belong to one of; any other
 * script, or a mix, can hold a look-alike of a letter, a digit, › or :. A mark used with any script is allowed. */
const scripts=[/\p{scx=Latin}/u,/\p{scx=Greek}/u,/\p{scx=Cyrillic}/u,/\p{scx=Hebrew}/u,/\p{scx=Arabic}/u,
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u];
const scripted=/^[\p{L}\p{M}\u0660-\u0669\u06f0-\u06f9]$/u,anyScript=/^\p{scx=Zinh}$/u;
const oneScript=(name:string)=>{const chars=Array.from(name).filter(char=>scripted.test(char)&&!anyScript.test(char));
  return scripts.some(script=>chars.every(char=>script.test(char)));};
/** A mark drawn over a letter, which makes it read as another letter, as o and a stroke read as ø. */
const overlay=/[\u0334-\u0338\u1cd4\u1ce2-\u1ce8\u20d2\u20d3\u20d8-\u20da\u20e5\u20e6\u20ea\u20eb\u{10a39}\u{16af0}-\u{16af4}\u{1bc9e}\u{1d167}-\u{1d169}]/u;
/** A dot over an i or a j, which fonts draw as its own dot, found once each character is drawn as Unicode's
 * prototype for it, so a dotless i or a dot drawn by another mark count too. */
const dotted=/[\p{Soft_Dotted}\u0131\u0237]\p{M}*\u0307/u;
/** A key is also quoted when another form of it, such as a ligature or a letter and its accent written apart,
 * would read the same, or when a mark over a letter makes it read as another. */
const key=(name:Step)=>typeof name==='number'?String(name):
  name.trim()===name&&name.normalize('NFKC')===name&&plainKey.test(name)&&!digits.test(name)&&oneScript(name)&&!overlay.test(name)&&!dotted.test(drawn(name))&&!hidden(name,false)?name:exact(name);
const label=(path:Step[])=>path.map(key).join(' › ');
/** A short value as it reads on its label's line: text as written, quoted when it could read as another
 * value, as the start of a change on a list card (⚙), or hides a character, and anything else as JSON. */
const value=(item:unknown)=>typeof item==='string'?
  (item&&item.trim()===item&&!item.startsWith('"')&&!item.includes('⚙')&&!json(item)&&!hidden(item,false)?item:exact(item)):
  escaped(JSON.stringify(item)??'null');

/** Every value of an input, under the keys that lead to it. A one-item list adds no step; a list of short
 * values stays one value; any other list's items each get a numbered group, so their fields stay together. */
function walk(item:unknown,path:Step[],group:Group) {
  if(Array.isArray(item)&&item.length===1)return walk(item[0],path,group);
  if(Array.isArray(item)&&item.length>1&&!item.every(isShort)) {
    item.forEach((entry,index)=>{
      const inner:Group={name:label([...path,index+1]),leaves:[],groups:[]};
      walk(entry,[],inner);group.groups.push(inner);
    });
    return;
  }
  if(isObject(item)&&Object.keys(item).length) {
    for(const [name,entry] of Object.entries(item))walk(entry,[...path,name],group);
    return;
  }
  group.leaves.push({path,value:item});
}

/** A long value's lines in a fold, where Telegram allows no quote of its own: each one indented, so none of
 * them starts a line as a label or a name does. */
const indent='  ';
/** A group's lines: each short value on one line after its bold label, then each long value under its
 * label in a quote, which opens on a tap only when it is long, or indented when the lines are folded, then
 * the groups inside it under their names. */
function lines(group:Group,header:string,folded:boolean):string[] {
  const out:string[]=header?[mark('b',header)]:[];
  for(const leaf of group.leaves.filter(leaf=>!isLong(leaf.value))) {
    const head=label(leaf.path)?mark('b',label(leaf.path)+':'):'';
    if(Array.isArray(leaf.value)&&leaf.value.length)out.push(...(head?[head]:[]),...leaf.value.map((entry,index)=>`${index+1}. ${value(entry)}`));
    else out.push(head?head+' '+value(leaf.value):value(leaf.value));
  }
  for(const leaf of group.leaves.filter(leaf=>isLong(leaf.value))) {
    // Blank lines before the text and spaces or line breaks after it are left out; text with a space at the end
    // of an inner line, which never shows, is quoted with its line breaks written out.
    const text=leaf.value as string,trimmed=text.replace(/^(?:[ \t]*\n)+|[ \t\n]+$/g,''),quoted=trimmed&&!trimmed.startsWith('"')&&!hidden(trimmed,true)?trimmed:exact(text);
    if(label(leaf.path))out.push(mark('b',label(leaf.path)+':'));
    if(folded)out.push(...quoted.split('\n').map(line=>indent+line));
    else out.push(mark(quoted.length>quoteLimit?'q':'c',quoted));
  }
  for(const inner of group.groups)out.push(...(out.length?['']:[]),...lines(inner,header?header+' › '+inner.name:inner.name,folded));
  return out;
}

/** Each character drawn as another, mapped to the one Unicode takes as its prototype (UTS #39). */
const likeness=new Map(confusables.split(';').flatMap(group=>{
  const [prototype,drawn]=group.split(':') as [string,string],target=String.fromCodePoint(...prototype.split('.').map(code=>parseInt(code,16)));
  return drawn.split(' ').map(code=>[String.fromCodePoint(parseInt(code,16)),target] as const);
}));
// Unicode makes one of Persian پ and ث, whose three dots sit below and above; the letters with three dots
// below, and those made of them, stay apart, with پ in their prototype.
for(const char of '\u067e\u0752\u06d1\u08b7\u08be')likeness.set(char,'\u067e'+likeness.get(char)!.slice(2));
// A dot above on its left is a dot over an i or a j too, as the one on its right is in Unicode's data.
likeness.set('\u1df8','\u0307');
/** Text drawn as Unicode's prototypes (UTS #39), from its compatibility form, so a ligature reads as its letters. */
const drawn=(name:string)=>Array.from(name.normalize('NFKD').replace(/\p{Default_Ignorable_Code_Point}/gu,''),char=>likeness.get(char)??char)
  .join('').normalize('NFKD');
/** Text's skeleton, as Unicode defines it to find text that reads alike, without a dot over an i or a j, which
 * fonts draw as its own. */
const skeleton=(name:string)=>drawn(name).replace(/(?<=\p{Soft_Dotted}\p{M}*)\u0307/gu,'');
/** Whether two keys of one object have one skeleton. Such an input is shown as its JSON in code, where each
 * letter keeps its own shape, with every character beyond plain ASCII written as its code, so the two keys
 * never read as one. */
function alike(item:unknown):boolean {
  if(Array.isArray(item))return item.some(alike);
  if(!isObject(item))return false;
  const names=Object.keys(item).map(skeleton);
  return new Set(names).size<names.length||Object.values(item).some(alike);
}

/** Every field of an input in words, with nothing left out. */
export function fields(input:unknown,folded=false):string {
  const group:Group={name:'',leaves:[],groups:[]};
  walk(input,[],group);
  return lines(group,'',folded).join('\n');
}

/** A connected service's name: notion → Notion. */
const service=(slug:string)=>slug.split(/[-_\s]+/).filter(Boolean).map(word=>word[0]!.toUpperCase()+word.slice(1)).join(' ')||slug;
/** A connected service's tool in words when it has the service's usual form, notion-create-pages → create
 * pages, so no two names read alike; any other name exactly, quoted. */
function tool(name:string,slug:string):string {
  const usual=name.startsWith(slug+'-')&&/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.slice(slug.length+1));
  return usual?name.slice(slug.length+1).replaceAll('-',' '):exact(name);
}
/** An address's authority as the tool that opens it reads it: after its scheme's //, up to its path, query or
 * fragment, once the tabs and line breaks that every reader of an address drops, and leading spaces, are gone. */
const written=(address:string)=>/^[^:/?#]+:\/\/([^/?#]*)/.exec(address.replace(/[\t\n\r]/g,'').replace(/^[\x00-\x20]+/,''))?.[1]??'';
/** The host an address opens, when the browser and the tool that opens it read one host: written in plain
 * ASCII, and read by the browser as written but for its case. A host written any other way, such as an
 * internationalized name, an address in another form or with a %, they can read as different hosts. */
function plainHost(address:string):string {
  const authority=written(address),host=authority.replace(/^.*@/,'').replace(/:[0-9]*$/,'');
  if(!/^[\x21-\x7e]+$/.test(authority))return '';
  try{const read=new URL(address).hostname;return read===host.toLowerCase()?read:'';}catch{return '';}
}
/** The host an address opens, as the browser reads it when it is plain; otherwise exactly as written, quoted,
 * every character beyond plain ASCII as its code. Empty when the address names no host. */
function site(address:string):string {
  const authority=written(address),host=plainHost(address);
  return !authority?'':host?shown(host):ascii(JSON.stringify(authority));
}
/** An address as it is, or quoted with every character beyond plain ASCII as its code when its host is not plain. */
const location=(address:string)=>!written(address)||plainHost(address)?shown(address):ascii(JSON.stringify(address));

/** An operation's name in words, such as “Run a command”, “Open a web page · example.com” or “Notion · create pages”. */
export function operationTitle(kind:string,args:Record<string,any>,words:OperationWords):string {
  if(kind==='shell')return plain(words.kind_shell);
  if(kind==='browser') {
    const host=typeof args.url==='string'?site(args.url):'';
    return plain(words.kind_browser)+(host?' · '+host:'');
  }
  if(kind==='mcp') {
    // Another server's tool keeps its exact name: its host is shown, but not who chose its names.
    const slug=typeof args.connection==='string'?args.connection:'',address=String(args.url??''),name=String(args.tool??'');
    const app=slug?shown(service(slug)):site(address)||shown(address);
    return `${app} · ${args.operation==='list'?plain(words.kind_tools):slug?tool(name,slug):shown(name)}`;
  }
  return shown(kind);
}

/** An operation's exact arguments in words: a command as code, an address as it is, and a tool's
 * input field by field, its long text in a quote that opens on a tap. Text with a hidden character is
 * quoted with that character written out, so the card never shows less than what runs. */
function words(kind:string,args:Record<string,any>,folded:boolean):string {
  if(kind==='shell'&&typeof args.command==='string')return mark('p',shown(args.command,true));
  if(kind==='browser'&&typeof args.url==='string')return location(args.url);
  if(kind==='mcp')return [typeof args.url==='string'?location(args.url):'',args.operation==='list'?'':fields(args.input,folded)].filter(Boolean).join('\n\n');
  return exactJson(args);
}

/** What the asker says an operation does, as one line: as written, or quoted with its hidden characters
 * written out when it hides one or could pass for a quote or a change on a list card. Left out when empty
 * or, written out, too long for a card's line. */
const summaryLimit=600;
function said(text:string|null):string|null {
  const line=(text??'').replace(/\s+/g,' ').trim();
  const kept=line&&!line.startsWith('"')&&!line.includes('⚙')&&!hidden(line,false)?line:exact(line);
  return line&&kept.length<=summaryLimit?kept:null;
}

/** An operation's card from the owner's template: its name in bold, what the asker says it does, and its
 * arguments put in after the template is filled, so filling never changes them. A template without a place
 * for the summary, or whose summary line is left out for another missing value, gets it on the line after
 * the name, so folded arguments never come without it. */
export function operationCard(template:string,operation:OperationText,origin:string|null):string {
  const slot='\u0001\u0003',own=template.replace(controls,'');
  const values={kind:heading(operation.title),summary:operation.summary,origin,arguments:operation.body?slot:''};
  const shows=own.split('\n').some(line=>line.includes('{summary}')&&lineKept(line,values));
  const placed=!operation.summary||shows?own:/\{kind\}/.test(own)?own.replace(/^(.*\{kind\}.*)$/m,'$1\n📝 {summary}'):'📝 {summary}\n'+own;
  return fillTemplate(placed,values).replaceAll(slot,()=>operation.body);
}

/** What an approval card shows for an operation. Its arguments are in words while they fit a card
 * plainly; a very long or finely split input, or one whose keys read alike, is shown as its exact JSON
 * instead. Null when even that is too long for a card, as text with many characters written out can be.
 * With a summary from the asker, the arguments fold under it into one quote that opens on a tap, unless
 * they are code, which Telegram cannot put in a quote. */
export function operationText(kind:string,args:Record<string,any>,names:OperationWords,note:string|null=null):OperationText|null {
  const title=operationTitle(kind,args,names),summary=said(note),twins=alike(args),json=twins?mark('p',ascii(canonical(args))):exactJson(args);
  const length=(text:string)=>text.replace(marked,'$2').length;
  let body=twins?json:words(kind,args,!!summary);
  if(length(body)>wordsLimit||[...body.matchAll(marked)].length>wordsEntities)body=json;
  if(length(body)>wordsLimit)return null;
  const folded=!!summary&&!!body&&!/\u0001p\u0002/.test(body);
  return {title,summary,body:folded?'\u0004'+heading(plain(names.details))+'\n'+body+'\u0005':body};
}
