/** Preserve bounded observed state without inferring meaning or completeness. */
export function reactionObservation(payload:unknown):Record<string,unknown>|null {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
  const body=payload as Record<string,unknown>;
  for(const [key,mode,fields] of [
    ['message_reaction','individual',['date','user','actor_chat','old_reaction','new_reaction']],
    ['message_reaction_count','aggregate',['date','reactions']],
  ] as const) {
    const item=body[key];if(!item||typeof item!=='object'||Array.isArray(item))continue;
    const value=item as Record<string,unknown>,observation:Record<string,unknown>={mode};
    for(const field of fields)if(field in value)observation[field]=value[field];
    return JSON.stringify(observation).length<=6000?observation:{mode,unavailable:'observation_size_limit'};
  }
  return null;
}
