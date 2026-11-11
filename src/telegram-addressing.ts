/** Group messages start a turn only when they address the bot, unless the owner lets it answer every message
 * (ADR-0133, ADR-0134). Nocheh decides this before any brain runs or presence shows (ADR-0235). */
export type GroupReplies={readonly mode:'addressed'|'all';readonly names:readonly string[]};
/** What in a captured group message can address the bot: a reply to it or a tap on its name, and the @usernames it names. */
export type AddressingFacts={readonly direct:boolean;readonly handles:readonly string[]};
/** The bot's own names, as its front door reports them. */
export type BotIdentity={readonly username?:string|null;readonly first_name?:string|null};

/** Used when the setting is absent; the owner may change or remove them. */
export const defaultBotNames='Nocheh,نوچه';

/** The owner's settings. A malformed value stops startup rather than guessing. */
export function groupReplies(env:Readonly<Record<string,string|undefined>>):GroupReplies {
  const mode=env.TELEGRAM_GROUP_REPLIES?.trim()||'addressed';
  if(mode!=='addressed'&&mode!=='all')throw new Error('Invalid TELEGRAM_GROUP_REPLIES');
  const names=(env.TELEGRAM_BOT_NAMES??defaultBotNames).split(',').map(name=>name.trim()).filter(Boolean);
  if(names.length>10||names.some(name=>name.length>32))throw new Error('Invalid TELEGRAM_BOT_NAMES');
  return {mode,names};
}

const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** A name opening the text after any non-word characters, and not followed by a word character. Letters and digits of
 * every script count as word characters. */
const opens=(text:string,name:string)=>new RegExp('^[^\\p{L}\\p{N}_]*'+escape(name)+'(?![\\p{L}\\p{N}_])','iu').test(text);

/**
 * A reply to the bot or a tap on its name, its @username, or one of its names opening the message. The names are the
 * owner-set names and the bot's display name. `facts` come from the captured original, because the routed message keeps
 * neither its reply target nor its entities; `text` is the routed text.
 */
export function addressed(facts:unknown,text:unknown,identity:BotIdentity|null,names:readonly string[]):boolean {
  const known=facts&&typeof facts==='object'?facts as Partial<AddressingFacts>:{};
  if(known.direct===true)return true;
  const handles=Array.isArray(known.handles)?known.handles:[],username=identity?.username;
  if(typeof username==='string'&&username&&handles.includes(username.toLowerCase()))return true;
  const opening=typeof text==='string'?text:'',first=identity?.first_name;
  return [...names,...(typeof first==='string'?[first]:[])].some(name=>!!name&&opens(opening,name));
}

/** Whether a group turn runs: every message when the owner allows it, otherwise only one that addresses the bot. */
export function groupTurn(settings:GroupReplies,facts:unknown,text:unknown,identity:BotIdentity|null,addressedOnly=false):boolean {
  return settings.mode==='all'&&!addressedOnly||addressed(facts,text,identity,settings.names);
}

/** The bot's identity from its front door, kept for a minute. An unknown identity still honors replies and set names. */
export function identityCache(read:()=>Promise<Record<string,unknown>>,ttl=60000) {
  let value:BotIdentity|null=null,until=0,pending:Promise<BotIdentity|null>|null=null;
  return async():Promise<BotIdentity|null>=>{
    if(Date.now()<until)return value;
    pending??=read().then(found=>{
      const text=(field:unknown)=>typeof field==='string'&&field?field:null;
      const next={username:text(found.username),first_name:text(found.first_name)};
      if(next.username||next.first_name){value=next;until=Date.now()+ttl;}
      return next.username||next.first_name?next:value;
    },()=>value).finally(()=>{pending=null;});
    return pending;
  };
}
