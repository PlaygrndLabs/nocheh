/** Host Connect transport on the archive's existing loopback HTTP listener.
 * No new listener, database port, event-ingestion route, or Inngest UI is exposed.
 * HTTP authenticates the SDK key; WebSocket authentication remains the pinned
 * Inngest gateway's signed binary handshake. Browser-origin connections are denied.
 */
import {request,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import type {Duplex} from 'node:stream';

const paths=new Set(['/v0/connect/start','/v0/connect/flush','/v1/traces/userland']);
export function hostTransport(key:string,upstream='http://inngest-server:8288',gateway='http://inngest-server:8289',active=()=>true) {
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('workflow_keys_missing');
  const expected=Buffer.from('Bearer '+createHash('sha256').update(Buffer.from(key,'hex')).digest('hex'));
  const sockets=new Set<Duplex>();
  const browser=(req:IncomingMessage)=>Boolean(req.headers.origin||req.headers.cookie||req.headers['sec-fetch-site']);
  return {
    handle(req:IncomingMessage,res:ServerResponse):boolean {
      if(!paths.has(req.url??''))return false;
      const actual=Buffer.from(String(req.headers.authorization??''));
      if(!active()||browser(req)||req.method!=='POST'||actual.length!==expected.length||!timingSafeEqual(actual,expected)) {
        res.writeHead(403);res.end();return true;
      }
      const target=new URL(req.url!,upstream);
      const outgoing=request(target,{method:'POST',headers:{...req.headers,host:target.host},timeout:30000},incoming=>{
        res.writeHead(incoming.statusCode??502,{'content-type':incoming.headers['content-type']??'application/octet-stream','cache-control':'no-store'});incoming.pipe(res);
      });
      outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});outgoing.on('timeout',()=>outgoing.destroy());
      let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){outgoing.destroy();req.destroy();}});
      req.on('aborted',()=>outgoing.destroy());req.pipe(outgoing);return true;
    },
    attach(server:Server){server.on('upgrade',(req,socket,head)=>{
      if(!active()||browser(req)||req.url!=='/v0/connect'||req.headers['sec-websocket-protocol']!=='v0.connect.inngest.com') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
      }
      const target=new URL('/v0/connect',gateway);
      const outgoing=request(target,{headers:{...req.headers,host:target.host},timeout:10000});
      outgoing.on('upgrade',(response,remote,buffer)=>{
        sockets.add(socket);sockets.add(remote);
        socket.on('close',()=>{sockets.delete(socket);remote.destroy();});remote.on('close',()=>{sockets.delete(remote);socket.destroy();});
        socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
        let headers='HTTP/1.1 101 Switching Protocols\r\n';
        for(let i=0;i<response.rawHeaders.length;i+=2)headers+=response.rawHeaders[i]+': '+response.rawHeaders[i+1]+'\r\n';
        socket.write(headers+'\r\n');if(buffer.length)socket.write(buffer);if(head.length)remote.write(head);
        socket.pipe(remote);remote.pipe(socket);
      });
      outgoing.on('response',response=>{response.resume();socket.destroy();});outgoing.on('error',()=>socket.destroy());
      outgoing.on('timeout',()=>outgoing.destroy());outgoing.end();
    });},
    close(){for(const socket of sockets)socket.destroy();},
  };
}
