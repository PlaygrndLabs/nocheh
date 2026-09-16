import {request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse} from 'node:http';

const securityHeaders={'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};

export function providerMonitorPath(raw:string):string {
  const url=new URL(raw,'http://local');
  if(!url.pathname.startsWith('/providers/'))throw new Error('provider_monitor_path_denied');
  url.pathname=url.pathname.slice('/providers'.length)||'/';
  return url.pathname+url.search;
}

export function proxyProviderMonitor(req:IncomingMessage,res:ServerResponse,port:number,adminKey:string,csrf:string,host='127.0.0.1') {
  const path=providerMonitorPath(req.url??'/providers/management.html');
  const headers:IncomingHttpHeaders={...req.headers,host:`127.0.0.1:${port}`,authorization:`Bearer ${adminKey}`};
  headers['accept-encoding']='identity';
  delete headers.cookie;delete headers['x-nocheh-csrf'];delete headers['x-hermes-session-token'];
  if(headers.origin)headers.origin=`http://127.0.0.1:${port}`;
  const proxy=request({hostname:host,port,path,method:req.method,headers},response=>{
    const outgoing={...response.headers,...securityHeaders};delete outgoing['set-cookie'];
    if(outgoing.location?.startsWith('/'))outgoing.location='/providers'+outgoing.location;
    if(String(response.headers['content-type']).includes('text/html')) {
      const chunks:Buffer[]=[];let length=0;
      response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>32*1024*1024){response.destroy();res.destroy();}else chunks.push(chunk);});
      response.on('end',()=>{
        let html=Buffer.concat(chunks).toString();
        html=html.replace('</head>',`<script>window.__NOCHEH_CSRF__=${JSON.stringify(csrf)};</script></head>`);
        delete outgoing['content-length'];delete outgoing['content-encoding'];
        res.writeHead(response.statusCode??502,outgoing);res.end(html);
      });
    } else {res.writeHead(response.statusCode??502,outgoing);response.pipe(res);}
    response.on('error',()=>res.destroy());
  });
  proxy.on('error',()=>{
    if(res.headersSent){res.end();return;}
    res.writeHead(503,{...securityHeaders,'content-type':'text/html; charset=utf-8'});
    res.end('<!doctype html><html lang="en"><title>Provider monitoring unavailable</title><body><h1>Provider monitoring is unavailable</h1><p>Nocheh and its reasoning provider continue independently.</p><a href="/">Back to Nocheh</a></body></html>');
  });
  req.pipe(proxy);
}
