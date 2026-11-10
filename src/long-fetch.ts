import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';

export interface LongFetchInit {method?:string;headers?:Record<string,string>;body?:string;signal?:AbortSignal;redirect?:'error'}
const redirects=new Set([301,302,303,307,308]),bodiless=new Set([204,205,304]);
/** A fetch for calls that may take longer than five minutes, such as a long-term memory recall. Node's own fetch
 * gives up after 300 s without response headers, or 300 s between two body chunks, whatever signal it gets (its
 * headersTimeout and bodyTimeout). Here only the caller's signal ends a call. Each call opens its own connection,
 * so no idle-connection timer applies, and a redirect is refused, as `redirect:'error'` does. */
export function longFetch(input:string|URL,init:LongFetchInit={}):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const url=new URL(input),signal=init.signal;
    if(url.protocol!=='http:'&&url.protocol!=='https:')return reject(new TypeError('long_fetch_protocol'));
    if(signal?.aborted)return reject(signal.reason);
    const headers={...init.headers,...(init.body===undefined?{}:{'content-length':String(Buffer.byteLength(init.body))})};
    const outgoing=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:init.method??'GET',headers,agent:false},incoming=>{
      const status=incoming.statusCode??0,empty=bodiless.has(status)||init.method==='HEAD';
      try {
        if(redirects.has(status))throw new TypeError('long_fetch_redirect');
        const answer=new Headers();
        for(let i=0;i+1<incoming.rawHeaders.length;i+=2)answer.append(incoming.rawHeaders[i]!,incoming.rawHeaders[i+1]!);
        resolve(new Response(empty?null:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,{status,headers:answer}));
        if(empty){incoming.on('error',()=>{});incoming.resume();}
      }catch(error){incoming.on('error',()=>{});incoming.destroy();reject(error);}
    });
    const abort=()=>outgoing.destroy(signal!.reason);
    signal?.addEventListener('abort',abort,{once:true});
    outgoing.on('close',()=>signal?.removeEventListener('abort',abort));
    outgoing.on('error',reject);
    outgoing.end(init.body);
  });
}
