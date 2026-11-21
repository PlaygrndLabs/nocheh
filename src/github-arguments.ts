import {HttpError,object} from './http.js';

/** The read-only GitHub lookups a chat may ask for (ADR-0270), and their inputs. Kept apart from the store so the argument
 *  check has no store imports. */
export const githubLookupTools=['search_code','read_file','list_files','list_commits','get_commit'] as const;
export type GithubLookupTool=typeof githubLookupTools[number];
export const GITHUB_REPO=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const inputs:Record<GithubLookupTool,Record<string,RegExp>>={
  search_code:{repo:GITHUB_REPO,query:/^[^\0\n\r]{1,200}$/},
  read_file:{repo:GITHUB_REPO,path:/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n\r]{1,400}$/,ref:/^[\w./-]{1,255}$/},
  list_files:{repo:GITHUB_REPO,path:/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n\r]{0,400}$/,ref:/^[\w./-]{1,255}$/},
  list_commits:{repo:GITHUB_REPO,path:/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\n\r]{1,400}$/,since:/^\d{4}-\d{2}-\d{2}(T[\d:]{8}Z)?$/,until:/^\d{4}-\d{2}-\d{2}(T[\d:]{8}Z)?$/,ref:/^[\w./-]{1,255}$/},
  get_commit:{repo:GITHUB_REPO,sha:/^[a-f0-9]{7,40}$/},
};
const required:Record<GithubLookupTool,string[]>={search_code:['repo','query'],read_file:['repo','path'],list_files:['repo'],list_commits:['repo'],get_commit:['repo','sha']};

/** A lookup's saved arguments: `{connection:'github',tool,input}`, every field checked; 400 `invalid_mcp_action` otherwise. */
export function githubArguments(args:Record<string,unknown>):{connection:'github';tool:GithubLookupTool;input:Record<string,string>} {
  const invalid=new HttpError(400,'invalid_mcp_action'),tool=args.tool as GithubLookupTool;
  if(Object.keys(args).some(key=>!['connection','tool','input'].includes(key))||!githubLookupTools.includes(tool))throw invalid;
  const given=object(args.input),allowed=inputs[tool],input:Record<string,string>={};
  for(const [key,value] of Object.entries(given)) {
    if(!allowed[key]||typeof value!=='string'||!allowed[key].test(value))throw invalid;
    input[key]=value;
  }
  if(required[tool].some(key=>!(key in input)))throw invalid;
  return {connection:'github',tool,input};
}

