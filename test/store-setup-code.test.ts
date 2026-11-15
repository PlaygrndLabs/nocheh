import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {initializeStoreDatabases,pgCode} from '../src/stores/connections.js';
import {setupFailureCode} from '../src/stores/bootstrap.js';

// A failed store setup logs why as a code only: a SQLSTATE or setup's own error name, never a message that can quote
// values. The development schema step prints it when it has to try a build again.
test('store setup failures keep the SQLSTATE and nothing else', () => {
  assert.equal(pgCode(Object.assign(Error('relation "chats" does not exist'),{code:'42P01'})),'42P01');
  assert.equal(pgCode(Object.assign(Error('connect refused'),{code:'ECONNREFUSED'})),undefined);
  assert.equal(setupFailureCode(Object.assign(Error('store_database_setup_failed'),{code:'40P01'})),'40P01');
  assert.equal(setupFailureCode(Error('store_maintenance_busy')),'store_maintenance_busy');
  assert.equal(setupFailureCode(Error('password authentication failed for user "x"')),'unknown');
  assert.equal(setupFailureCode(undefined),'unknown');
});

/** A PostgreSQL stand-in that accepts any login and answers every query with one error. */
function failingServer(code:string,message:string) {
  const message_=(type:string,body:Buffer)=>{const head=Buffer.alloc(5);head.write(type,0,'latin1');head.writeInt32BE(body.length+4,1);return Buffer.concat([head,body]);};
  const field=(key:string,value:string)=>Buffer.from(key+value+'\0','utf8');
  const ready=message_('Z',Buffer.from('I','latin1'));
  return createServer((socket:Socket)=>{
    let buffer=Buffer.alloc(0),started=false;
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk as Buffer]);
      for(;;) {
        if(!started) {
          if(buffer.length<4||buffer.length<buffer.readInt32BE(0))return;
          buffer=buffer.subarray(buffer.readInt32BE(0));started=true;
          const ok=Buffer.alloc(4);socket.write(Buffer.concat([message_('R',ok),ready]));continue;
        }
        if(buffer.length<5||buffer.length<1+buffer.readInt32BE(1))return;
        const type=String.fromCharCode(buffer[0]!);buffer=buffer.subarray(1+buffer.readInt32BE(1));
        if(type==='X'){socket.end();return;}
        if(type==='Q')socket.write(Buffer.concat([message_('E',Buffer.concat([field('S','ERROR'),field('V','ERROR'),field('C',code),field('M',message),Buffer.from('\0')])),ready]));
      }
    });
  });
}

test('store setup keeps the database error code when it fails', async () => {
  const server=failingServer('55P03','could not obtain lock on relation "secret_value"');
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port,passwords={archive:'a'.repeat(64),derived:'b'.repeat(64),control:'c'.repeat(64)};
  try {
    await assert.rejects(initializeStoreDatabases({host:'127.0.0.1',port,user:'synthetic',database:'synthetic',password:'synthetic'},passwords),
      (error:Error&{code?:string})=>error.message==='store_database_setup_failed'&&error.code==='55P03'&&setupFailureCode(error)==='55P03');
  } finally {server.close();}
});
