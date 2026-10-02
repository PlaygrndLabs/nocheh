/** Access labels describe the saved state, never just the kind of connection. */
export function accessDescription(state?:string):string {
  switch(state){
    case 'active':return 'This fact can be used here.';
    case 'suspended':return 'Access paused. This fact cannot be used until you approve its current wording again.';
    case 'revoked':return 'Access revoked. This grant no longer allows future recall.';
    case 'consumed':return 'One-time access used. No further access through this grant.';
    case 'expired':return 'Access expired. This grant no longer allows recall.';
    default:return 'Access is not confirmed active.';
  }
}

export function connectionDescription(edge:{kind:string;state?:string}):string {
  if(edge.kind==='access')return accessDescription(edge.state);
  if(edge.kind==='suggestion')return edge.state==='pending'?'Awaiting your approval. No access granted.':'Past suggestion. This connection does not grant access.';
  if(edge.kind==='project_assignment')return 'Organizes the conversation in a project. No memory access granted.';
  return 'Describes a relationship. No memory access granted.';
}

export const shareableFact=(node:{id:string;kind:string;state?:string;detail?:{retired?:boolean}}):boolean=>
  node.kind==='fact'&&/^fact:[a-f0-9]{64}$/.test(node.id)&&node.state==='active'&&!node.detail?.retired;
