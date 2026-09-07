import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DashboardSessions} from '../src/dashboard-auth.js';

test('browser sessions require their own CSRF; WebSocket tickets expire and cannot be replayed or moved to another session',()=>{
  let now=0;const auth=new DashboardSessions(()=>now);
  const a=auth.page({headers:{}}),b=auth.page({headers:{}});
  const req={method:'POST',headers:{cookie:'nocheh_session='+a.id,'x-nocheh-csrf':a.csrf}};
  assert.equal(auth.authorize(req).id,a.id);
  assert.throws(()=>auth.authorize({...req,headers:{...req.headers,'x-nocheh-csrf':b.csrf}}),{code:'csrf_required'});
  assert.throws(()=>auth.authorize({...req,headers:{cookie:'nocheh_download='+a.id}}),{code:'owner_session_required'});
  assert.throws(()=>auth.authorize({...req,headers:{...req.headers,'x-nocheh-csrf':'é'.repeat(a.csrf.length)}}),{code:'csrf_required'});
  const ticket=auth.ticket(a);
  assert.throws(()=>auth.consume({headers:{cookie:'nocheh_session='+b.id}},ticket),{code:'websocket_ticket_invalid'});
  auth.consume(req,ticket);
  assert.throws(()=>auth.consume(req,ticket),{code:'websocket_ticket_invalid'});
  const expired=auth.ticket(a);now=30001;
  assert.throws(()=>auth.consume(req,expired),{code:'websocket_ticket_invalid'});
  now=12*60*60*1000;
  assert.throws(()=>auth.authorize(req),{code:'owner_session_required'});
});
