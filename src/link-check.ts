import {canonical,digest} from './archive.js';
import {forwardOrigin} from './forwarded.js';

/**
 * Which web addresses may open without a card (ADR-0263). One place decides it for "Do what I ask", chat rules and
 * another server's tool rules, so the three cannot drift apart.
 */

/** How many characters after a site name a model-built address may carry: more can hold data, so it asks. */
export const dataLimit=200;
/** Reads one message may open without a card, from every path together, and from links on pages it opened. */
export const freeReadLimit=10,pageLinkLimit=5;
/** A forward's or another person's links open without a card only when it has at most this many. */
export const forwardedLinkLimit=2;
/** Why a read opened without a card: a link typed or pasted in the message, a link in a forward, a link on a page
 *  opened in the same turn, a site named in the owner's words, or a chat rule. */
export type FreeRead='typed'|'forwarded'|'page'|'named'|'rule';
export const freeReads:readonly FreeRead[]=['typed','forwarded','page','named','rule'];

/**
 * Sites where an address names someone's document or sends what it carries elsewhere: shared documents and forms,
 * script and webhook endpoints, notification and proxy services. A rule on one covers one document only, and a site
 * named in the owner's words never opens there without a card. A list cannot be complete; the length and address
 * checks below cover what it misses.
 */
const sharedHosts=new Set(['docs.google.com','drive.google.com','script.google.com','script.googleusercontent.com','sites.google.com',
  'forms.gle','forms.office.com','forms.microsoft.com','ntfy.sh','api.telegram.org','webhook.site','requestbin.com','r.jina.ai',
  'web.archive.org','archive.ph','archive.today','archive.is','maker.ifttt.com','hooks.zapier.com','hooks.slack.com','discord.com',
  'discordapp.com','translate.google.com','webhook.office.com','pastebin.com','paste.ee','hastebin.com','transfer.sh','0x0.st']);
const sharedSuffixes=['.pipedream.net','.translate.goog','.make.com','.webhook.office.com','.requestcatcher.com','.beeceptor.com',
  '.ngrok.io','.ngrok-free.app','.ngrok.app','.workers.dev','.trycloudflare.com','.loca.lt','.webhook.site'];
export const sharedHost=(host:string)=>sharedHosts.has(host)||sharedSuffixes.some(suffix=>host.endsWith(suffix));

/** One document on a shared site, as a path: a Google document, form, file, script or site by its id, or else the
 *  address's first path part. Null when the address names none, so no rule can cover it. */
function documentPath(host:string,path:string):string|null {
  const google:Record<string,RegExp>={
    'docs.google.com':/^\/(document|spreadsheets|presentation|forms|drawings|file)\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]{10,})(?:[/?]|$)/,
    'drive.google.com':/^\/(file|drive\/(?:u\/\d+\/)?folders)\/(?:d\/)?([\w-]{10,})(?:[/?]|$)/,
    'script.google.com':/^\/(macros)\/(?:u\/\d+\/)?s\/([\w-]{10,})(?:[/?]|$)/,
    'sites.google.com':/^\/(view)\/([\w-]+)(?:[/?]|$)/};
  const pattern=google[host];
  if(pattern){const found=pattern.exec(path);return found?`/${found[1]}/${found[2]}`:null;}
  const first=/^\/([^/?#]+)/.exec(path);
  return first?'/'+first[1]:null;
}

/** Text as an address reader may read it: percent escapes undone again and again, so `%252F` reads as a slash too. */
function decoded(text:string):string {
  let value=text;
  for(let round=0;round<4;round++) {
    let next:string;
    try{next=decodeURIComponent(value.replace(/\+/g,' '));}catch{next=value.replace(/%([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));}
    if(next===value)break;value=next;
  }
  return value;
}
const scheme=/[a-z][a-z0-9+.-]*:(?:\/|\\)|(?:^|[^:])\/\/[a-z0-9-]+\.[a-z]/i;
const domain=/(?:^|[^a-z0-9@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?=[/\\:])/i;
const wholeDomain=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
/** Whether text carries another web address: one with a scheme, or a bare site with a path after it, also once its
 *  escapes are undone; or, as a whole query value, a bare site name. */
export function carriesAddress(text:string):boolean {
  const read=decoded(text);
  return scheme.test(text)||scheme.test(read)||domain.test(text)||domain.test(read);
}
/** What an address carries after its site: its path and query, as written. */
const after=(url:URL)=>url.pathname+url.search;
/** Whether an address can carry data beyond a short page name: more than dataLimit characters after its site, or
 *  another web address inside it. */
export function carriesData(address:string):boolean {
  let url:URL;try{url=new URL(address);}catch{return true;}
  // Counted as read, so a Persian page name, six characters a letter once escaped, counts a character a letter.
  const rest=after(url);
  if(Array.from(decoded(rest)).length>dataLimit||carriesAddress(rest))return true;
  return [...url.searchParams.values()].some(value=>wholeDomain.test(decoded(value).trim()));
}

/** The chat rule key of a web read (ADR-0214, ADR-0263): its site, or one document on a shared site; none for an
 *  address that carries data, so a rule never covers it and its card offers none. */
export function browserRuleKey(address:string):string|null {
  if(carriesData(address))return null;
  const url=new URL(address),host=url.hostname;
  if(!sharedHost(host))return 'nocheh_browser:'+host;
  const document=documentPath(host,url.pathname);
  return document?'nocheh_browser:'+host+document:null;
}
/** Whether a chat rule key covers one document rather than a whole site. */
export const documentRule=(key:string|null)=>!!key&&key.startsWith('nocheh_browser:')&&key.slice('nocheh_browser:'.length).includes('/');

/** Whether another server's tool input is short enough for a tool rule to cover (ADR-0263): plain keys, at most 20
 *  values, each text at most dataLimit characters with no web address in it. */
export function shortInput(input:unknown):boolean {
  let values=0;
  const walk=(value:unknown,depth:number):boolean=>{
    if(depth>4)return false;
    if(value===null||typeof value==='boolean'||typeof value==='number')return ++values<=20;
    if(typeof value==='string')return ++values<=20&&Array.from(value).length<=dataLimit&&!carriesAddress(value)&&!wholeDomain.test(value.trim());
    if(Array.isArray(value))return value.every(item=>walk(item,depth+1));
    if(typeof value==='object')return Object.entries(value as object).every(([key,item])=>/^[\w.-]{1,64}$/.test(key)&&walk(item,depth+1));
    return false;
  };
  return walk(input,0)&&canonical(input).length<=2000;
}
/** Whether a web read or another server's tool sends nothing beyond a short address (ADR-0291): its address carries no
 *  data and, for a tool call, its input is short enough for a tool rule to cover. */
export function sendsNoData(args:{url?:unknown;tool?:unknown;input?:unknown;operation?:unknown}):boolean {
  return typeof args.url==='string'&&!carriesData(args.url)&&(args.tool===undefined||shortInput(args.input));
}
/** The rule key of another server's tool call: its exact server address and tool, only for short input from an address
 *  that carries no data. A list of its tools and a connected service have none. */
export function toolRuleKey(args:{url?:unknown;tool?:unknown;input?:unknown;operation?:unknown;connection?:unknown}):string|null {
  if(args.connection!==undefined||args.operation==='list'||typeof args.url!=='string'||typeof args.tool!=='string')return null;
  if(carriesData(args.url)||!shortInput(args.input))return null;
  return 'nocheh_mcp:'+new URL(args.url).hostname+':'+digest(canonical([args.url,args.tool]));
}

/** An address as Nocheh compares it: https, its parser's spelling, without a fragment. Null when it is no web address. */
export function sameAddress(address:string,base?:string):string|null {
  let url:URL;
  try{url=base===undefined?new URL(/^[a-z][a-z0-9+.-]*:/i.test(address)?address:'https://'+address):new URL(address,base);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname)return null;
  url.protocol='https:';url.hash='';
  return url.href;
}

/** What a message gives Nocheh to open without a card: the links in it, the words its sender typed and the sites they
 *  named. A forward's or an inline bot's links are kept apart, and its words are not the sender's own. */
export type MessageLinks={typed:Set<string>;forwarded:Set<string>;words:Set<string>;hosts:Set<string>};
export const noLinks=():MessageLinks=>({typed:new Set(),forwarded:new Set(),words:new Set(),hosts:new Set()});
const words=(text:string)=>text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** The links in one text, from Telegram's own link entities, and any written address Telegram did not mark. */
function linksOf(text:string,entities:unknown):string[] {
  const found:string[]=[];
  for(const entity of Array.isArray(entities)?entities:[]) {
    if(!entity||typeof entity!=='object')continue;
    const {type,offset,length,url}=entity as Record<string,unknown>;
    if(type==='text_link'&&typeof url==='string')found.push(url);
    if(type==='url'&&Number.isSafeInteger(offset)&&Number.isSafeInteger(length))found.push(text.slice(Number(offset),Number(offset)+Number(length)));
  }
  for(const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi))found.push(match[0].replace(/[.,;:!?)\]]+$/,''));
  return found;
}
/** The sites a text names, outside an email address. */
function hostsOf(text:string):string[] {
  return [...text.matchAll(/(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w@-])/gi)].map(match=>match[1]!.toLowerCase());
}
/** What one captured message gives: Telegram's text or caption and its entities, never a quoted reply, or a dashboard
 *  message's own text. */
export function messageLinks(payload:any):MessageLinks {
  const result=noLinks();
  const message=payload?.message;
  const text=typeof message?.text==='string'?message.text:typeof message?.caption==='string'?message.caption:
    typeof payload?.display==='string'?payload.display:'';
  const entities=typeof message?.text==='string'?message.entities:message?.caption_entities;
  const links=linksOf(text,entities).map(link=>sameAddress(link)).filter((link):link is string=>!!link);
  const forward=message?forwardOrigin(message):null;
  if(forward&&forward.from!=='own') {
    if(new Set(links).size<=forwardedLinkLimit)for(const link of links)result.forwarded.add(link);
    return result;
  }
  for(const link of links){result.typed.add(link);result.hosts.add(new URL(link).hostname);}
  for(const word of words(text))result.words.add(word);
  for(const host of hostsOf(text))result.hosts.add(host);
  return result;
}

/** Query keys a search on a named site may use. */
const searchKeys=new Set(['q','query','search','s','term','text','keyword','keywords']);
/** Whether an address only names a site the owner named this turn, with nothing after it but the owner's own words:
 *  the bare site, or a path or search made of words they typed. Never a shared site, and never more than dataLimit. */
export function namedSite(address:string,links:MessageLinks):boolean {
  let url:URL;try{url=new URL(address);}catch{return false;}
  const host=url.hostname,bare=host.replace(/^www\./,'');
  if(sharedHost(host)||carriesData(address)||![host,bare,'www.'+bare].some(name=>links.hosts.has(name)))return false;
  const own=(text:string)=>words(decoded(text)).every(word=>links.words.has(word));
  if(!own(url.pathname))return false;
  return [...url.searchParams].every(([key,value])=>searchKeys.has(key)&&own(value));
}

/** A page opened earlier in the same turn: its address, the links on it, and why it opened. */
export type OpenedPage={url:string;links:unknown;free:string|null};
/** Pages whose address no model chose: a typed, forwarded or named address, or a link on such a page. Links on any
 *  other page, which a rule or a card let the model build, are checked for a piece of that address. */
const chosenByOthers=new Set(['typed','forwarded','page','named']);
/** Whether a link repeats 8 or more characters of the address of the page it was on: such a page can echo what the
 *  model sent it into its links. */
export function reflects(link:string,page:string):boolean {
  let from:URL,to:URL;try{from=new URL(page);to=new URL(link);}catch{return true;}
  const sent=decoded(after(from)).toLowerCase(),shown=decoded(to.hostname+after(to)).toLowerCase();
  for(let at=0;at+8<=sent.length;at++)if(shown.includes(sent.slice(at,at+8)))return true;
  return false;
}
/** Whether an address is exactly a link shown on a page opened in this turn, resolved against that page. */
export function pageLink(address:string,pages:OpenedPage[]):boolean {
  return pages.some(page=>Array.isArray(page.links)&&page.links.some(link=>typeof link==='string'&&sameAddress(link,page.url)===address&&
    (chosenByOthers.has(page.free??'')||!reflects(address,page.url))));
}

/** Why a model's web address may open without a card under "Do what I ask", or null when it asks (ADR-0263). The
 *  address is the one the call sends, in its parser's spelling. */
export function freeRead(address:string,links:MessageLinks,pages:OpenedPage[]):Exclude<FreeRead,'rule'>|null {
  const exact=sameAddress(address);if(!exact)return null;
  if(links.typed.has(exact))return 'typed';
  if(links.forwarded.has(exact))return 'forwarded';
  if(pageLink(exact,pages))return 'page';
  if(namedSite(exact,links))return 'named';
  return null;
}
