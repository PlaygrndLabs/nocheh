import {createHash} from 'node:crypto';
import {HttpError,object,string} from './http.js';

/*
 * POST /internal/notices/authorize on nocheh-app (step 5, ADR-0265 D10), with the service token like
 * /internal/actions/authorize. nocheh-telegram asks it before send_notice sends a notice to any chat but the owner's
 * private chat: only a task reminder (send_class 'reminder') to the private chat of the member who set it, and only
 * once. Core answers allowed only when a reminder row with that id is in state 'sending', its deliver_chat is that chat,
 * its notice_digest matches, and it was not authorized before (the check is one-time). Anything else, malformed bodies
 * included, is not allowed; the gateway then sends nothing.
 */

/** The request. `id` is the notice id send_notice got (the reminder's id, 64 hex); `chat` the Telegram chat id it is
 * asked to send to (body.chat_id, as the gateway got it); `text_digest` noticeDigest of the exact text. */
export interface NoticeAuthorizeRequest {id:string;chat:string;text_digest:string}
/** The answer: always 200 with allowed true or false; it never says why. */
export interface NoticeAuthorizeResponse {allowed:boolean}
/** The notice text's digest both sides compute: SHA-256 of its UTF-8 bytes, lowercase hex (Python:
 * hashlib.sha256(text.encode('utf-8')).hexdigest()). */
export const noticeDigest=(text:string):string=>createHash('sha256').update(text,'utf8').digest('hex');
/** Reads the request body; anything else is 400 invalid_notice_authorize. */
export function noticeAuthorizeRequest(input:unknown):NoticeAuthorizeRequest {
  const invalid=()=>new HttpError(400,'invalid_notice_authorize');
  let id:string,chat:string,textDigest:string;
  try {
    const body=object(input);
    if(Object.keys(body).sort().join(',')!=='chat,id,text_digest')throw invalid();
    id=string(body.id,64);chat=string(body.chat,32);textDigest=string(body.text_digest,64);
  } catch{throw invalid();}
  // The chat is compared whole with the reminder's own chat, never read for its shape.
  if(!/^[a-f0-9]{64}$/.test(id)||!/^\S{1,32}$/.test(chat)||!/^[a-f0-9]{64}$/.test(textDigest))throw invalid();
  return {id,chat,text_digest:textDigest};
}
