import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserDeliveryRepository} from '../src/stores/browser-delivery.js';
import {digest} from '../src/archive.js';

test('browser receipts preserve exact delivered evidence across outages, retries and restart, with reset and forgery fences',async()=>{
  const root=await mkdtemp(join(tmpdir(),'browser-delivery-')),secret=digest('synthetic-delivery-secret'),owner={admin:true,scope:null};
  const service=new BrowserDeliveryRepository(root,secret),row={scope:'123',logical_profile:'research',conversation_id:'conversation',space_id:'123',
    binding:{generation:'generation-one'},event_id:digest('input'),source_reference:{store:'archive',id:digest('input')},result_reference:{store:'derived',id:digest('result')}};
  const text=' exact\r\n🙂 ';
  try{
    const offer=await service.offer(row,text,'original-input');
    assert.deepEqual(await service.offer(row,text,'original-input'),offer);
    assert.ok(!(await readdir(join(root,'spool'))).includes('pending'),'a completion offer is not observed speech');
    await assert.rejects(service.acknowledge({admin:false,scope:'123'},offer),{status:403});
    await assert.rejects(service.acknowledge(owner,{...offer,sha256:digest('forged')}),{code:'delivery_receipt_conflict'});
    await assert.rejects(service.acknowledge(owner,{...offer,receipt:'../bad'}),{code:'invalid_delivery_receipt'});
    const captured=await service.acknowledge(owner,offer),restarted=new BrowserDeliveryRepository(root,secret);
    assert.deepEqual(await restarted.acknowledge(owner,offer),captured);
    assert.equal(JSON.parse(await readFile(join(root,'spool/pending',captured.event_id+'.json'),'utf8')).text,text);
    const changed=await service.offer({...row,binding:{generation:'generation-two'}},text,'original-input');
    assert.notEqual(changed.receipt,offer.receipt);
    const path=join(root,'spool/browser-delivery-offers',offer.receipt+'.json'),bytes=await readFile(path),document=JSON.parse(bytes.toString());
    await writeFile(path,JSON.stringify({...document,text:'tampered'}));
    await assert.rejects(service.acknowledge(owner,{...offer,sha256:digest('tampered')}),{code:'delivery_receipt_conflict'});
    await rm(path);await assert.rejects(service.acknowledge(owner,offer),{code:'delivery_offer_missing'});
    await assert.rejects(new BrowserDeliveryRepository(root,digest('different')).acknowledge(owner,changed),{code:'delivery_receipt_conflict'});
  }finally{await rm(root,{recursive:true,force:true});}
});
