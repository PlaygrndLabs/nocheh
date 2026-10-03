export type DecisionKind='controlled_action'|'telegram_action'|'memory_access'|'entity'|'knowledge';
export type Decision={kind:DecisionKind;id:string;title:string;state:string;created_at:string;summary?:string;destination?:string;revision?:number;detail?:any;observation?:string};
export type DecisionPage={items:Decision[];total:number;totals:Record<string,number>;next_cursor:string|null;observed_at:string;state:string};
export const decisionLabels:Record<DecisionKind,string>={controlled_action:'External action',telegram_action:'Telegram message',memory_access:'Memory access',entity:'Identity suggestion',knowledge:'Knowledge management'};
export function decisionLink(kind:DecisionKind,id:string){return '#activity?'+new URLSearchParams({kind,decision:id});}
export function selectedDecision(hash:string):{kind:DecisionKind;id:string}|null{const params=new URLSearchParams(hash.split('?')[1]??''),kind=params.get('kind'),id=params.get('decision');return kind&&Object.hasOwn(decisionLabels,kind)&&id?{kind:kind as DecisionKind,id}:null;}
export type ActivityTab='decisions'|'approvals'|'permissions'|'runs';
/** A hash-selected item owns the visible reviewer, even when its tab was unmounted. */
export function activityNavigation(hash:string,currentTab:ActivityTab){
 const decision=selectedDecision(hash),actionId=decision?null:new URLSearchParams(hash.split('?')[1]??'').get('action');
 return {tab:decision||actionId?'decisions' as const:currentTab,actionId};
}
export function memoryAvailability(memory:{connection?:{attached?:boolean;verified?:boolean};limited_memory?:boolean;syncing?:boolean}|null,failed=false){
 if(failed||!memory)return {state:'unknown',label:'Availability unobserved'};
 if(!memory.connection?.attached)return {state:'disabled',label:'Long-term memory detached'};
 if(!memory.connection.verified)return {state:'unverified',label:'Memory compatibility unverified'};
 if(memory.limited_memory!==false)return {state:'limited',label:'Limited memory'};
 return {state:'ready',label:'Current memory available'};
}
export function proposalState(state:string){return ({review:'Your review needed',queued:'Queued for application',waiting:'Waiting for safe application',applied:'Applied',stale:'Conflict — prepare a fresh proposal',cancelled:'Cancelled',failed:'Application failed',undone:'Undone'} as Record<string,string>)[state]??state;}
/** Cancelling saved authority does not need the source dependencies needed to apply it. */
export function knowledgeDecisionControls(state:string,{unavailable=false,changed=false,busy=false,stale=false}:{unavailable?:boolean;changed?:boolean;busy?:boolean;stale?:boolean}={}){
 const locked=unavailable||changed||busy;
 return {approve:state==='review'&&!locked&&!stale,reject:state==='review'&&!locked,cancel:['queued','waiting','stale','failed'].includes(state)&&!locked,undo:state==='applied'&&!locked&&!stale};
}
