import {admin,type Reader} from '../access.js';
import {HttpError,string} from '../http.js';
import type {StorePools} from './connections.js';
import type {MemoryAccessRepository} from './memory-access.js';

export type MemoryMapNodeKind='person'|'project'|'conversation'|'topic'|'fact';
export type MemoryMapEdgeKind='relationship'|'project_assignment'|'access'|'suggestion';
export interface MemoryMapNode {id:string;kind:MemoryMapNodeKind;label:string;state?:string;cluster?:string;collapsed?:boolean;detail?:Record<string,unknown>}
export interface MemoryMapEdge {id:string;kind:MemoryMapEdgeKind;source:string;target:string;state?:string;label?:string;authoritative:boolean;detail?:Record<string,unknown>}

const cursor=(value:string)=>{if(value&&!/^[a-z_]+:[^\x00-\x1f]{1,300}$/.test(value))throw new HttpError(400,'invalid_memory_map_cursor');return value;};
const classify=(space:string):'topic'|'conversation'=>space.includes('/topic/')?'topic':'conversation';

/** Owner-only graph projection. It describes relationships and separately marks authority edges. */
export class MemoryMapRepository {
  constructor(readonly stores:StorePools,readonly access:MemoryAccessRepository){}
  async read(principal:Reader,input:{after:string;limit:number;focus:string;query:string;kind:string;state:string}) {
    admin(principal);await this.access.reconcile();const after=cursor(input.after),query=string(input.query,200).trim().toLocaleLowerCase();
    if(input.kind&&!['person','project','conversation','topic','fact'].includes(input.kind))throw new HttpError(400,'invalid_memory_map_kind');
    const nodes:MemoryMapNode[]=[],edges:MemoryMapEdge[]=[];
    const entities=(await this.stores.control.query('SELECT e.* FROM memory_entities e ORDER BY e.id LIMIT 5000')).rows;
    const factCounts=new Map<string,number>();for(const row of (await this.stores.derived.query(`SELECT entity_id,count(*)::int AS count FROM
      (SELECT subject_entity_id AS entity_id FROM entity_claims UNION ALL SELECT object_entity_id FROM entity_claims WHERE object_entity_id IS NOT NULL) x GROUP BY entity_id`)).rows)factCounts.set(row.entity_id,Number(row.count));
    for(const row of entities)nodes.push({id:`${row.kind}:${row.id}`,kind:row.kind,label:row.name,state:row.state,collapsed:true,
      detail:{revision:row.revision,project_id:row.project_id,fact_count:factCounts.get(row.id)??0,...(input.focus===`${row.kind}:${row.id}`?{bindings:(await this.stores.control.query('SELECT binding_kind,label,state,source_object_id FROM memory_entity_bindings WHERE entity_id=$1 ORDER BY id',[row.id])).rows}:{})}});
    const spaces=(await this.stores.control.query(`SELECT space_id AS id FROM project_assignments UNION SELECT destination FROM memory_access_requests
      UNION SELECT destination FROM memory_fact_grants UNION SELECT destination FROM sharing_rules UNION SELECT jsonb_array_elements_text(sources) FROM sharing_rules ORDER BY id LIMIT 5000`)).rows;
    for(const row of spaces){const kind=classify(row.id),parent=row.id.includes('/topic/')?row.id.split('/topic/')[0]:null;
      nodes.push({id:`${kind}:${row.id}`,kind,label:kind==='topic'?`Topic ${row.id.split('/topic/')[1]}`:`Conversation ${row.id}`,cluster:parent??row.id,detail:{space_id:row.id,parent}});}
    const claims=(await this.stores.derived.query(`SELECT e.*,v.revision,v.content,v.relationship_kind,v.attribution,v.uncertainty,v.retired,v.evidence,v.author,v.created_at
      FROM entity_claims e JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision ORDER BY e.id LIMIT 5000`)).rows;
    for(const row of claims){nodes.push({id:`fact:${row.id}`,kind:'fact',label:row.content,state:row.retired?'retired':'active',collapsed:false,
      detail:{revision:row.revision,predicate:row.predicate,attribution:row.attribution,uncertainty:row.uncertainty,evidence:row.evidence,author:row.author,created_at:row.created_at}});
      edges.push({id:`relationship:fact:${row.id}`,kind:'relationship',source:`${entities.find(entity=>entity.id===row.subject_entity_id)?.kind??'person'}:${row.subject_entity_id}`,target:`fact:${row.id}`,
        label:row.predicate,authoritative:false,detail:{relationship_kind:row.relationship_kind,evidence:row.evidence,revision:row.revision,history:`/v1/entities/claims/${row.id}/history`}});
      if(row.object_entity_id)edges.push({id:`relationship:${row.id}`,kind:'relationship',source:`fact:${row.id}`,target:`${entities.find(entity=>entity.id===row.object_entity_id)?.kind??'person'}:${row.object_entity_id}`,
        label:row.relationship_kind??row.predicate,authoritative:false,detail:{evidence:row.evidence,revision:row.revision,history:`/v1/entities/claims/${row.id}/history`}});}
    const assignments=(await this.stores.control.query(`SELECT a.*,p.name FROM project_assignments a LEFT JOIN projects p ON p.id=a.project_id WHERE a.mode='assigned' ORDER BY a.space_id LIMIT 5000`)).rows;
    for(const row of assignments){const entity=entities.find(item=>item.project_id===row.project_id);if(entity)edges.push({id:`project_assignment:${row.space_id}`,kind:'project_assignment',source:`project:${entity.id}`,target:`${classify(row.space_id)}:${row.space_id}`,label:'contains',authoritative:false,detail:{mode:row.mode,revision:row.revision}});}
    const grants=(await this.stores.control.query('SELECT * FROM memory_fact_grants ORDER BY id LIMIT 5000')).rows;
    for(const row of grants)edges.push({id:`access:${row.id}`,kind:'access',source:`fact:${row.fact_id}`,target:`${classify(row.destination)}:${row.destination}`,state:row.state,label:row.mode,authoritative:true,
      detail:{grant_id:row.id,mode:row.mode,revision:row.revision,fact_revision:row.fact_revision,expires_at:row.expires_at,suspended_reason:row.suspended_reason,request_id:row.request_id,revocation:`/v1/memory-access/grants/${row.id}/revoke`}});
    const requests=(await this.stores.control.query('SELECT * FROM memory_access_requests ORDER BY id LIMIT 5000')).rows;
    for(const row of requests)edges.push({id:`suggestion:${row.id}`,kind:'suggestion',source:`fact:${row.fact_id}`,target:`${classify(row.destination)}:${row.destination}`,state:row.state,label:'suggested',authoritative:false,
      detail:{request_id:row.id,revision:row.revision,fact_revision:row.fact_revision,relationship_path:row.relationship_path,evidence:row.evidence,expires_at:row.expires_at,decision:row.decision}});
    const releases=(await this.stores.control.query(`SELECT r.*,s.destination FROM sharing_releases r JOIN sharing_rules s ON s.id=r.rule_id ORDER BY r.id LIMIT 5000`)).rows;
    for(const row of releases){const fact=`fact:release-${row.id}`;nodes.push({id:fact,kind:'fact',label:'Approved shared knowledge',state:row.state,detail:{legacy_release_id:row.id,revision:row.revision,mode:row.mode}});
      edges.push({id:`access:release:${row.id}`,kind:'access',source:fact,target:`${classify(row.destination)}:${row.destination}`,state:row.state,label:row.mode,authoritative:true,detail:{release_id:row.id,existing_sharing:true}});}
    const unique=new Map(nodes.map(node=>[node.id,node])),filtered=[...unique.values()].filter(node=>(!input.kind||node.kind===input.kind)&&(!input.state||node.state===input.state)&&(!query||`${node.label} ${node.kind}`.toLocaleLowerCase().includes(query))).sort((a,b)=>a.id.localeCompare(b.id));
    const page=filtered.filter(node=>node.id>after).slice(0,input.limit+1),visible=page.slice(0,input.limit),ids=new Set(visible.map(node=>node.id));
    const pageEdges=edges.filter(edge=>ids.has(edge.source)||ids.has(edge.target)).sort((a,b)=>a.id.localeCompare(b.id));
    return {format:'nocheh-memory-map-v1',nodes:visible,edges:pageEdges,next:page.length>input.limit?visible.at(-1)!.id:null,
      collapsed_facts:!input.focus,focus:input.focus||null,counts:{nodes:filtered.length,edges:edges.length},relationship_edges_grant_access:false};
  }
}
