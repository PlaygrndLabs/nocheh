import { envelope, type Envelope } from './archive.js';

/** Submitted inputs are originals. Harness output is stored separately as derived data. */
export function runInput(source: {
  channel: 'browser'|'scheduler'; scope: string; conversation: string; id: string;
  text: string; payload: Record<string,unknown>;
}): Envelope {
  return envelope({version:1, channel:source.channel, origin:'live', bot_id:'',
    key:JSON.stringify([source.channel,source.scope,source.conversation,source.id]),
    kind:source.channel==='browser'?'browser_input':'scheduled_trigger',
    scope:source.scope,source_id:source.id,revision:'0',occurred_at:null,
    text:source.text,payload:{...source.payload,conversation_id:source.conversation}});
}
