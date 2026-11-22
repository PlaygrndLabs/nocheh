import {HttpError,object} from './http.js';

/** The read-only Gmail lookups the owner's private chat may ask for (ADR-0272), and their inputs. */
export const gmailLookupTools=['search_mail','read_message','read_thread'] as const;
export type GmailLookupTool=typeof gmailLookupTools[number];
const ID=/^[A-Za-z0-9_-]{6,64}$/;
const inputs:Record<GmailLookupTool,Record<string,RegExp>>={
  search_mail:{query:/^[^\0\n\r]{1,300}$/},
  read_message:{id:ID},
  read_thread:{id:ID},
};

/** A lookup's saved arguments: `{connection:'gmail',tool,input}`, every field checked; 400 `invalid_mcp_action` otherwise. */
export function gmailArguments(args:Record<string,unknown>):{connection:'gmail';tool:GmailLookupTool;input:Record<string,string>} {
  const invalid=new HttpError(400,'invalid_mcp_action'),tool=args.tool as GmailLookupTool;
  if(Object.keys(args).some(key=>!['connection','tool','input'].includes(key))||!gmailLookupTools.includes(tool))throw invalid;
  const given=object(args.input),allowed=inputs[tool],input:Record<string,string>={};
  for(const [key,value] of Object.entries(given)) {
    if(!allowed[key]||typeof value!=='string'||!allowed[key].test(value))throw invalid;
    input[key]=value;
  }
  if(Object.keys(allowed).some(key=>!(key in input)))throw invalid;
  return {connection:'gmail',tool,input};
}
