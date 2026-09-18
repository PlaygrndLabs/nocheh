import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {admin,type Reader} from '../access.js';
import {canonical,digest,envelope,type Envelope} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {immutableFile} from '../storage.js';

/** An offer is still generated output. Only an authenticated browser receipt
 * moves its exact representation into the capture spool. Offers are retained
 * outside archive and erased with installation content during a reset. */
export class BrowserDeliveryRepository {
  constructor(readonly root:string,readonly secret:string){}
  private key(row:any){return canonical(['browser-delivered',row.binding.generation,row.event_id,row.result_reference.id]);}
  eventId(row:any){return digest(this.key(row));}
  private receipt(value:Envelope){
    if(this.secret.length<24)throw new HttpError(503,'service_credential_required');
    return createHmac('sha256',this.secret).update('browser-delivery-v1:'+canonical(value)).digest('hex');
  }
  async offer(row:any,text:string,inputId:string){
    const namespace=canonical([row.scope,row.logical_profile,row.conversation_id]),key=this.key(row);
    const original=envelope({version:1,key,channel:'browser',origin:'live',kind:'browser_delivered_message',bot_id:'',scope:row.scope,
      source_id:row.result_reference.id,revision:'0',occurred_at:null,text,
      payload:{profile:row.logical_profile,space:row.space_id,conversation_id:row.conversation_id,role:'assistant',in_reply_to:inputId},
      source:{version:1,adapter:'nocheh.browser',adapter_version:'2',object:{platform:'browser',namespace,kind:'message',external_id:row.result_reference.id},
        operation:'create',completeness:'full',relations:[
          {kind:'contained_in',target:{platform:'browser',namespace:canonical([row.scope,row.logical_profile]),kind:'conversation',external_id:row.conversation_id}},
          {kind:'reply_to',target:{platform:'browser',namespace,kind:'message',external_id:inputId}}],
        metadata:{audience:{chat_id:row.scope,topic_state:row.space_id===row.scope?'none':'known',...(row.space_id===row.scope?{}:{topic_id:row.space_id.split('/topic/')[1]})}},
        provenance:{capture:'authenticated_browser_receipt',generation:row.binding.generation,result:row.result_reference,input:row.source_reference}}});
    const receipt=this.receipt(original);
    await immutableFile(join(this.root,'spool/browser-delivery-offers'),receipt+'.json',Buffer.from(canonical(original)));
    return {receipt,sha256:digest(text)};
  }
  async acknowledge(principal:Reader,input:unknown){
    admin(principal);const body=object(input),receipt=string(body.receipt,64),sha256=string(body.sha256,64);
    if(!/^[a-f0-9]{64}$/.test(receipt)||!/^[a-f0-9]{64}$/.test(sha256))throw new HttpError(400,'invalid_delivery_receipt');
    let bytes:Buffer;try{bytes=await readFile(join(this.root,'spool/browser-delivery-offers',receipt+'.json'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new HttpError(404,'delivery_offer_missing');throw error;}
    const value=envelope(JSON.parse(bytes.toString()));
    if(this.receipt(value)!==receipt||digest(value.text??'')!==sha256||value.kind!=='browser_delivered_message')throw new HttpError(409,'delivery_receipt_conflict');
    const event_id=digest(value.key);
    // No database, guard preparation, or workflow service is needed to accept
    // already-delivered evidence. Normal source replay handles the handoff.
    await immutableFile(join(this.root,'spool/pending'),event_id+'.json',Buffer.from(canonical(value)));
    return {event_id,state:'spooled'};
  }
}
