import {randomBytes} from 'node:crypto';
import {request, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse} from 'node:http';

export function nativePath(raw:string):string {
  const url=new URL(raw,'http://local');
  url.pathname=url.pathname.slice('/hermes'.length)||'/';
  url.searchParams.delete('token');url.searchParams.delete('ticket');url.searchParams.delete('internal');
  return url.pathname+url.search;
}
const responseHeaders={'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'};
/** Where the browser reports what the Hermes page's script rules would block (ADR-0251). */
export const CSP_REPORT_PATH='/api/nocheh/csp-report';
/**
 * The script rules of a Hermes page, reported only: scripts from the dashboard's own address and the inline
 * scripts this response names by its nonce. There is no connect-src, default-src or style-src.
 */
export const pagePolicy=(nonce:string)=>`script-src 'self' 'nonce-${nonce}'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri ${CSP_REPORT_PATH}`;
/** Any other HTML from Hermes runs no script at all. */
export const OTHER_HTML_POLICY="script-src 'none'; sandbox";
const SESSION_TOKEN=/window\.__HERMES_SESSION_TOKEN__\s*=\s*[^;]+;/g;
/**
 * `page` is one of Hermes's own pages, opened in the browser. Only such a page gets the dashboard's CSRF value
 * in place of Hermes's session token, a nonce on its scripts and the reported script rules. Any other HTML from
 * Hermes gets neither value and no added script, and the browser runs no script in it.
 */
export function proxyNative(req:IncomingMessage,res:ServerResponse,port:number,token:string,csrf:string,host='127.0.0.1',page=false) {
  const headers:IncomingHttpHeaders={...req.headers,host:`127.0.0.1:${port}`,'x-forwarded-prefix':'/hermes','x-hermes-session-token':token};
  headers['accept-encoding']='identity';
  delete headers.cookie;delete headers.authorization;delete headers['x-nocheh-csrf'];
  // Origin has already been verified at the owner boundary. Native sees its own authority.
  if(headers.origin)headers.origin=`http://127.0.0.1:${port}`;
  const proxy=request({hostname:host,port,path:nativePath(req.url??'/hermes/'),method:req.method,headers},response=>{
    const outgoing:IncomingHttpHeaders={...response.headers,...responseHeaders};delete outgoing['set-cookie'];
    if(outgoing.location?.startsWith('/')&&!outgoing.location.startsWith('/hermes/'))outgoing.location='/hermes'+outgoing.location;
    if(String(response.headers['content-type']).includes('text/html')) {
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4*1024*1024){response.destroy();res.destroy();}else chunks.push(chunk);});
      response.on('end',()=>{
        let html=Buffer.concat(chunks).toString();
        if(page) {
          // A new nonce for every response, on each of the page's own scripts and on the one added here.
          const nonce=randomBytes(16).toString('base64');
          html=html.replace(SESSION_TOKEN,`window.__HERMES_SESSION_TOKEN__=${JSON.stringify(csrf)};`);
          html=html.replace(/<script\b/gi,`<script nonce="${nonce}"`);
          html=html.replace('</head>',`<script nonce="${nonce}">window.__HERMES_AUTH_REQUIRED__=true;</script></head>`);
          outgoing['content-security-policy-report-only']=pagePolicy(nonce);
        } else {
          // Hermes's own token never reaches the browser, and no dashboard value takes its place.
          html=html.replace(SESSION_TOKEN,'window.__HERMES_SESSION_TOKEN__="";');
          outgoing['content-security-policy']=OTHER_HTML_POLICY;
        }
        delete outgoing['content-length'];delete outgoing['content-encoding'];
        res.writeHead(response.statusCode??502,outgoing);res.end(html);
      });
    } else {res.writeHead(response.statusCode??502,outgoing);response.pipe(res);}
    response.on('error',()=>res.destroy());
  });
  proxy.on('error',()=>{
    if(res.headersSent){res.end();return;}
    res.writeHead(503,{...responseHeaders,'content-type':'text/html; charset=utf-8'});
    res.end('<!doctype html><html lang="en"><title>Hermes unavailable</title><body><h1>Hermes is unavailable</h1><p>Your archive and management tools are still available in Nocheh.</p><a href="/">Back to Nocheh</a></body></html>');
  });
  req.pipe(proxy);
}
