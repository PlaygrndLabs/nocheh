import {HttpError,object} from '../http.js';

/** Mandatory boundaries even when secret masking is off: no hosted side effects
 * or provider-stored history can bypass local tool/audience authorization. */
export function providerPayload(value:unknown):Record<string,unknown> {
  const payload=object(value);
  if(payload.tools!==undefined&&(!Array.isArray(payload.tools)||payload.tools.some(tool=>!tool||typeof tool!=='object'||tool.type!=='function')))throw new HttpError(403,'hosted_provider_tools_denied');
  if(payload.web_search_options!==undefined)throw new HttpError(403,'hosted_provider_tools_denied');
  if(payload.tool_choice&&typeof payload.tool_choice==='object'&&object(payload.tool_choice).type!=='function')throw new HttpError(403,'hosted_provider_tools_denied');
  function inspect(input:unknown) {
    if(Array.isArray(input)){for(const item of input)inspect(item);return;}
    if(!input||typeof input!=='object')return;
    const record=input as Record<string,unknown>;
    for(const key of ['previous_response_id','conversation','file_id','file_url','vector_store_ids'])if(record[key]!==undefined)throw new HttpError(403,'opaque_provider_context_denied');
    if(record.image_url!==undefined){const image=typeof record.image_url==='string'?record.image_url:object(record.image_url).url;if(typeof image!=='string'||!image.startsWith('data:'))throw new HttpError(403,'remote_provider_media_denied');}
    for(const item of Object.values(record))inspect(item);
  }
  // Tool parameter schemas are data describing locally executed functions. Inspect
  // actual context envelopes, not property names in those schemas.
  const {tools:_tools,...context}=payload;inspect(context);
  return Array.isArray(payload.input)?{...payload,input:payload.input.filter(item=>!(item?.type==='reasoning'&&item.encrypted_content!==undefined))}:payload;
}
