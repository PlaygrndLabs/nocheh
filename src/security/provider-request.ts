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

/** Anthropic's Messages API keeps the same boundary: only locally executed tools, no hosted
 * tools, containers, MCP servers, stored files or remote media. Unknown request fields are
 * refused, since new Messages API features arrive as new fields. */
const ANTHROPIC_FIELDS=new Set(['model','messages','system','max_tokens','stream','stop_sequences','metadata','tools','tool_choice',
  'thinking','output_config','temperature','top_p','top_k','cache_control']);
const ANTHROPIC_TOOL_FIELDS=new Set(['name','description','input_schema','cache_control','strict','eager_input_streaming','type']);
const ANTHROPIC_BLOCKS=new Set(['text','image','tool_use','tool_result','thinking','redacted_thinking']);
export function anthropicPayload(value:unknown):Record<string,unknown> {
  const payload=object(value);
  for(const key of Object.keys(payload))if(!ANTHROPIC_FIELDS.has(key))throw new HttpError(403,'provider_request_field_denied');
  if(payload.tools!==undefined&&(!Array.isArray(payload.tools)||payload.tools.some(tool=>!tool||typeof tool!=='object'||Array.isArray(tool)
    ||![undefined,'custom'].includes(tool.type)||typeof tool.name!=='string'||!tool.input_schema||typeof tool.input_schema!=='object'
    ||Object.keys(tool).some(key=>!ANTHROPIC_TOOL_FIELDS.has(key)))))throw new HttpError(403,'hosted_provider_tools_denied');
  if(payload.tool_choice!==undefined&&!['auto','any','tool','none'].includes(String(object(payload.tool_choice).type)))throw new HttpError(403,'hosted_provider_tools_denied');
  if(!Array.isArray(payload.messages))throw new HttpError(400,'invalid_model_request');
  function blocks(content:unknown) {
    if(typeof content==='string')return;
    if(!Array.isArray(content))throw new HttpError(400,'invalid_model_request');
    for(const block of content) {
      const record=object(block);
      if(!ANTHROPIC_BLOCKS.has(String(record.type)))throw new HttpError(403,'opaque_provider_context_denied');
      if(record.type==='image'&&object(record.source).type!=='base64')throw new HttpError(403,'remote_provider_media_denied');
      if(record.type==='tool_result'&&record.content!==undefined)blocks(record.content);
    }
  }
  if(payload.system!==undefined)blocks(payload.system);
  for(const message of payload.messages){const record=object(message);if(!['user','assistant','system'].includes(String(record.role)))throw new HttpError(400,'invalid_model_request');blocks(record.content);}
  function inspect(input:unknown) {
    if(Array.isArray(input)){for(const item of input)inspect(item);return;}
    if(!input||typeof input!=='object')return;
    const record=input as Record<string,unknown>;
    for(const key of ['file_id','container','mcp_servers','url'])if(record[key]!==undefined)throw new HttpError(403,'opaque_provider_context_denied');
    // A local tool call's arguments are data for a locally executed tool, as on the OpenAI route.
    for(const [key,item] of Object.entries(record))if(!(record.type==='tool_use'&&key==='input'))inspect(item);
  }
  const {tools:_tools,...context}=payload;inspect(context);
  // Earlier reasoning is not replayed, as on the OpenAI-compatible route: Hermes drops it for a
  // relayed endpoint, and a signature must never pass through the secret check.
  const reasoning=(block:unknown)=>['thinking','redacted_thinking'].includes(String(object(block).type));
  return {...payload,messages:payload.messages.map(message=>{
    const record=object(message);const content=record.content;
    if(record.role!=='assistant'||!Array.isArray(content)||!content.some(reasoning)||content.every(reasoning))return message;
    return {...record,content:content.filter(block=>!reasoning(block))};
  })};
}
