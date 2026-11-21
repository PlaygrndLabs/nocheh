import {canonical,digest} from './archive.js';
import {HttpError,object,string} from './http.js';
import {browserRuleKey,toolRuleKey} from './link-check.js';
import {githubArguments} from './github-arguments.js';

/** Whether a web address's host is written plainly, so the card, a chat rule, the executor and any other parser all read
 * the same one (ADR-0214): no backslash, percent escape, user name, port spelling or non-ASCII name. */
export const plainHost=(address:string,url:URL)=>/^https:\/\/([^/?#]*)/i.exec(address)?.[1]?.toLowerCase()===url.host&&/^[a-z0-9.-]+$/.test(url.hostname);

/** `stored` re-reads a saved operation: it keeps every check except the plain host one, which only new
 * proposals need, since a chat rule only ever covers an operation proposed with a plain host (ADR-0214). */
export function actionArguments(kind:unknown,value:unknown,stored=false) {
  const args=object(value), keys=Object.keys(args);
  if(kind==='shell') {
    const command=string(args.command,16000);
    if(keys.some(k=>k!=='command')||!command.trim()||command.includes('\0'))throw new HttpError(400,'invalid_shell_action');
    return {command};
  }
  if(kind==='mcp'&&args.connection!==undefined) {
    // A connected service: its address and sign-in are fixed by a connection the owner set up, never by the model. A call
    // names the owner's own Notion by leaving `project` out, or a project's Notion by its id (ADR-0268).
    // GitHub's lookups are a fixed few reads of one repository (ADR-0270).
    if(args.connection==='github')return githubArguments(args);
    if(args.connection!=='notion'||args.url!==undefined)throw new HttpError(400,'invalid_mcp_action');
    if(args.project!==undefined&&(typeof args.project!=='string'||!/^[a-f0-9]{64}$/.test(args.project)))throw new HttpError(400,'invalid_mcp_action');
    const project=args.project===undefined?{}:{project:args.project as string};
    if(args.operation==='list') {
      if(keys.some(k=>!['connection','operation','project'].includes(k)))throw new HttpError(400,'invalid_mcp_action');
      return {connection:'notion',...project,operation:'list'};
    }
    const tool=string(args.tool,128),input=object(args.input);
    if(keys.some(k=>!['connection','project','tool','input','operation'].includes(k))||(args.operation!==undefined&&args.operation!=='call')||!/^[\w.:-]{1,128}$/.test(tool)||canonical(input).length>32000)throw new HttpError(400,'invalid_mcp_action');
    return {connection:'notion',...project,tool,input};
  }
  if(kind==='browser'||kind==='mcp') {
    const address=string(args.url,4096);let url:URL;
    try {url=new URL(address);}catch{throw new HttpError(400,'invalid_action_url');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||url.hostname==='localhost')throw new HttpError(400,'public_https_required');
    if(!stored&&!plainHost(address,url))throw new HttpError(400,'plain_host_required');
    if(kind==='browser') {
      if(keys.some(k=>k!=='url'))throw new HttpError(400,'invalid_browser_action');
      return {url:address};
    }
    if(args.operation==='list') {
      if(keys.some(k=>!['url','operation'].includes(k)))throw new HttpError(400,'invalid_mcp_action');
      return {url:address,operation:'list'};
    }
    const tool=string(args.tool,128),input=object(args.input);
    if(keys.some(k=>!['url','tool','input','operation'].includes(k))||(args.operation!==undefined&&args.operation!=='call')||!/^[\w.:-]{1,128}$/.test(tool)||canonical(input).length>32000)throw new HttpError(400,'invalid_mcp_action');
    return {url:address,tool,input};
  }
  throw new HttpError(400,'unsupported_controlled_tool');
}

/** What a chat rule allows, in Hermes's approval rule_key format: one site for a web read, or one document on a shared
 * site; one exact command for a shell command; one tool of another server, for short input (ADR-0214, ADR-0263). A web
 * read or a tool call that carries data, a connected service and Telegram have no rule and are decided one by one. */
export function ruleKey(kind:string,args:any):string|null {
  if(kind==='browser')return browserRuleKey(args.url);
  if(kind==='shell')return 'nocheh_shell:'+digest(args.command);
  if(kind==='mcp')return toolRuleKey(args);
  return null;
}
