import {canonical} from './archive.js';
import {HttpError,object,string} from './http.js';

export function actionArguments(kind:unknown,value:unknown) {
  const args=object(value), keys=Object.keys(args);
  if(kind==='shell') {
    const command=string(args.command,16000);
    if(keys.some(k=>k!=='command')||!command.trim()||command.includes('\0'))throw new HttpError(400,'invalid_shell_action');
    return {command};
  }
  if(kind==='browser'||kind==='mcp') {
    const address=string(args.url,4096);let url:URL;
    try {url=new URL(address);}catch{throw new HttpError(400,'invalid_action_url');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||url.hostname==='localhost')throw new HttpError(400,'public_https_required');
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
