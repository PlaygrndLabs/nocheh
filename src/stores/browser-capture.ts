import {join} from 'node:path';
import {admin,type Reader} from '../access.js';
import {canonical,digest,envelope,type Envelope} from '../archive.js';
import type {AssistantPolicy} from '../assistant-policy.js';
import {HttpError,object,string} from '../http.js';
import {validateSpace,parentSpace} from '../spaces.js';
import {immutableFile,storeBytes} from '../storage.js';
import type {OriginalManifest} from './archive.js';

const identity=(value:unknown)=>{const result=string(value,128);if(!/^[a-zA-Z0-9_-]+$/.test(result))throw new HttpError(400,'invalid_run_identity');return result;};
/** Manifests are part of the original browser submission and commit with it. */
export function browserManifests(id:string,value:Envelope):OriginalManifest[] {
  if(value.channel!=='browser'||value.kind!=='browser_input')return [];
  const files=value.payload.attachments??[];
  if(!Array.isArray(files)||files.length>10)throw new HttpError(400,'invalid_original_manifest');
  return files.map((input,index)=>{
    const file=object(input);
    if(typeof file.name!=='string'||!file.name||file.name.length>255||/[\x00-\x1f/\\]/.test(file.name)||
      !['file','image','voice','audio'].includes(String(file.kind))||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||
      !Number.isSafeInteger(file.bytes)||Number(file.bytes)<0)throw new HttpError(400,'invalid_original_manifest');
    const source_ref='browser:'+index+':'+file.sha256;
    return {id:digest(id+':'+source_ref),source_ref,kind:String(file.kind),metadata:{file_name:file.name},file_hash:file.sha256,byte_size:Number(file.bytes)};
  });
}

/** Admission is filesystem-only: databases and Inngest can all be unavailable. */
export class BrowserCaptureRepository {
  constructor(readonly root:string,readonly policy:()=>AssistantPolicy){}
  async capture(principal:Reader,value:unknown) {
    admin(principal);const body=object(value),policy=this.policy(),scope=string(body.scope,64);
    if(!policy.owner_id||scope!==policy.owner_id&&!policy.group_ids.includes(scope))throw new HttpError(403,'run_scope_denied');
    const id=identity(body.id),conversation=identity(body.conversation),profile=identity(body.profile),space=validateSpace(body.space??scope),revision=body.revision??0;
    if(profile.length>64||(parentSpace(space)??space)!==scope||!Number.isSafeInteger(revision)||Number(revision)<0)throw new HttpError(400,'invalid_run_audience');
    const text=string(body.text,100000),display=string(body.display??text,200000),submission=body.submission??'composer';
    if(!['composer','resubmission'].includes(String(submission)))throw new HttpError(400,'invalid_submission');
    const files=body.files??[];if(!Array.isArray(files)||files.length>10)throw new HttpError(400,'invalid_attachments');
    const prepared:{name:string;kind:string;sha256:string;bytes:number;content:Buffer}[]=[];let total=0;
    for(const input of files) {
      const file=object(input),name=string(file.name,255),kind=string(file.kind,32),encoded=string(file.bytes_base64,36*1024*1024);
      if(!name||/[\x00-\x1f/\\]/.test(name)||!['file','image','voice','audio'].includes(kind)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new HttpError(400,'invalid_attachment');
      const bytes=Buffer.from(encoded,'base64');total+=bytes.length;if(total>25*1024*1024)throw new HttpError(413,'attachment_limit');
      prepared.push({name,kind,sha256:digest(bytes),bytes:bytes.length,content:bytes});
    }
    const attachments=prepared.map(({content,...manifest})=>manifest),key=canonical(['browser',scope,profile,conversation,id]);
    const original=envelope({version:1,key,channel:'browser',origin:'live',kind:'browser_input',bot_id:'',scope,source_id:id,revision:'0',occurred_at:null,text,
      payload:{profile,space,revision,conversation_id:conversation,attachments,submission,display},
      source:{version:1,adapter:'nocheh.browser',adapter_version:'2',
        object:{platform:'browser',namespace:canonical([scope,profile,conversation]),kind:'message',external_id:id},operation:'create',completeness:'full',
        relations:[{kind:'contained_in',target:{platform:'browser',namespace:canonical([scope,profile]),kind:'conversation',external_id:conversation}}],
        metadata:{audience:{chat_id:scope,topic_state:space===scope?'none':'known',...(space===scope?{}:{topic_id:space.split('/topic/')[1]})}},
        provenance:{capture:'owner_browser_submission'}}});
    // Validate all input before writing, then persist every file before publishing
    // the spool record. Replay can reconstruct its complete archive transaction.
    const event_id=digest(key);browserManifests(event_id,original);
    for(const file of prepared)await storeBytes(this.root,file.content);
    await immutableFile(join(this.root,'spool/pending'),event_id+'.json',Buffer.from(canonical(original)));
    return {event_id,source_key:key,attachments,state:'spooled'};
  }
}
