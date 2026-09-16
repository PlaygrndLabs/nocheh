import {request, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';

export function nativePath(raw:string):string {
  const url=new URL(raw,'http://local');
  url.pathname=url.pathname.slice('/hermes'.length)||'/';
  url.searchParams.delete('token');url.searchParams.delete('ticket');url.searchParams.delete('internal');
  return url.pathname+url.search;
}
const responseHeaders={'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'};
export function proxyNative(req:IncomingMessage,res:ServerResponse,port:number,token:string,csrf:string,host='127.0.0.1') {
  const headers:IncomingHttpHeaders={...req.headers,host:`127.0.0.1:${port}`,'x-forwarded-prefix':'/hermes','x-hermes-session-token':token};
  headers['accept-encoding']='identity';
  delete headers.cookie;delete headers.authorization;delete headers['x-nocheh-csrf'];
  // Origin has already been verified at the owner boundary. Native sees its own authority.
  if(headers.origin)headers.origin=`http://127.0.0.1:${port}`;
  const proxy=request({hostname:host,port,path:nativePath(req.url??'/hermes/'),method:req.method,headers},response=>{
    const outgoing={...response.headers,...responseHeaders};delete outgoing['set-cookie'];
    if(outgoing.location?.startsWith('/')&&!outgoing.location.startsWith('/hermes/'))outgoing.location='/hermes'+outgoing.location;
    if(String(response.headers['content-type']).includes('text/html')) {
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>4*1024*1024){response.destroy();res.destroy();}else chunks.push(chunk);});
      response.on('end',()=>{
        let html=Buffer.concat(chunks).toString();
        html=html.replace(/window\.__HERMES_SESSION_TOKEN__\s*=\s*[^;]+;/g,`window.__HERMES_SESSION_TOKEN__=${JSON.stringify(csrf)};`);
        html=html.replace('</head>','<script>window.__HERMES_AUTH_REQUIRED__=true;</script></head>');
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

export function proxyNativeSocket(req:IncomingMessage,socket:Duplex,head:Buffer,port:number,token:string,host='127.0.0.1') {
  const url=new URL(nativePath(req.url??''),'http://local');url.searchParams.set('token',token);
  const headers:IncomingHttpHeaders={...req.headers,host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`};
  delete headers.cookie;delete headers.authorization;delete headers['x-nocheh-csrf'];
  const proxy=request({hostname:host,port,path:url.pathname+url.search,headers});
  proxy.on('upgrade',(response,upstream,initial)=>{
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
    if(initial.length)socket.write(initial);if(head.length)upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
    socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
    socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
    socket.on('end',()=>upstream.destroy());upstream.on('end',()=>socket.destroy());
  });
  proxy.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode??502} Rejected\r\nConnection: close\r\n\r\n`);response.resume();});
  proxy.on('error',()=>socket.destroy());socket.on('close',()=>proxy.destroy());proxy.end();
}
