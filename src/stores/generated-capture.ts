import {canonical,digest,envelope,type Envelope} from '../archive.js';
import {HttpError} from '../http.js';
import {originalEnvelope,type CapturedSource} from './archive.js';
import {DerivedRepository} from './derived.js';
import {OperationRepository} from './operations.js';

const messageMethods=new Set(['sendMessage','sendPhoto','sendAudio','sendDocument','sendVideo','sendAnimation',
  'sendVoice','sendVideoNote','sendMediaGroup','sendLocation','sendVenue','sendContact','sendPoll','sendDice',
  'sendSticker','forwardMessage','forwardMessages','copyMessage','copyMessages','editMessageText','editMessageCaption',
  'editMessageMedia','editMessageLiveLocation','stopMessageLiveLocation','editMessageReplyMarkup']);
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Only observed Telegram Message responses count as evidence of delivered speech.
 * Boolean/MessageId-only responses cannot reconstruct a message from its draft. */
export function captureEvidence(input:unknown):{value:Envelope;originals:Envelope[];generated:boolean} {
  const value=envelope(input);
  if(value.origin!=='generated')return {value,originals:[originalEnvelope(value)],generated:false};
  const originals:Envelope[]=[];
  if((value.channel??'telegram')!=='telegram'||value.kind!=='outbound_result')return {value,originals,generated:true};
  const payload=value.payload;
  if(payload.state!=='delivered'||typeof payload.status!=='number'||payload.status<200||payload.status>=300||
    !messageMethods.has(String(payload.method))||typeof payload.wire_base64!=='string')return {value,originals,generated:true};
  let wire:Record<string,unknown>;
  try {wire=record(JSON.parse(Buffer.from(payload.wire_base64,'base64').toString()));}
  catch {return {value,originals,generated:true};}
  if(wire.ok!==true)return {value,originals,generated:true};
  for(const raw of Array.isArray(wire.result)?wire.result:[wire.result]) {
    const message=record(raw),chat=record(message.chat);
    if(!Number.isSafeInteger(message.message_id)||Number(message.message_id)<1||
      !(typeof chat.id==='string'||Number.isSafeInteger(chat.id))||String(chat.id)!==value.scope||
      !Number.isSafeInteger(message.date)||Number(message.date)<0)continue;
    const revision=digest(canonical(message)),sourceId=String(message.message_id);
    originals.push(envelope({version:1,channel:'telegram',origin:'live',bot_id:value.bot_id,
      key:canonical(['telegram-delivered',value.bot_id,String(chat.id),sourceId,revision]),
      kind:'telegram_delivered_message',scope:String(chat.id),source_id:sourceId,revision,
      occurred_at:String(message.edit_date??message.date),text:typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:null,
      payload:{message},wire_base64:Buffer.from(canonical(message)).toString('base64')}));
  }
  return {value,originals,generated:true};
}

export class GeneratedCaptureRepository {
  constructor(readonly operations:OperationRepository,readonly derived:DerivedRepository){}
  async commit(value:Envelope,sources:CapturedSource[]):Promise<void> {
    if(value.origin!=='generated')throw new HttpError(400,'generated_capture_required');
    const source=await this.operations.record({key:value.key,kind:value.kind,scope:value.scope,input_hash:digest(canonical(value))});
    const result=await this.derived.record({operation_id:'capture:'+source.id,source,kind:value.kind,content:Buffer.from(canonical(value)),
      producer:'nocheh-capture',producer_version:'2',configuration:{},provenance:{channel:value.channel??'telegram'}});
    const state=value.kind==='outbound_intent'?'attempting':value.kind==='outbound_result'&&
      ['delivered','rejected','ambiguous'].includes(String(value.payload.state))?String(value.payload.state):'recorded';
    const references=sources.map(s=>s.reference);
    await this.operations.pool.query(`INSERT INTO capture_effect_receipts(operation_id,derived_id,state,sources)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[source.id,result.id,state,JSON.stringify(references)]);
    const stored=(await this.operations.pool.query('SELECT derived_id,state,sources FROM capture_effect_receipts WHERE operation_id=$1',[source.id])).rows[0];
    if(!stored||stored.derived_id!==result.id||stored.state!==state||canonical(stored.sources)!==canonical(references))
      throw new HttpError(409,'capture_effect_conflict');
  }
}
