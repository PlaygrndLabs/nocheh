import ELK from 'elkjs/lib/elk.bundled.js';

type LayoutNode={id:string;position:{x:number;y:number};width?:number;height?:number;measured?:{width?:number;height?:number}};
type LayoutEdge={id:string;source:string;target:string};

const elk=new ELK();

export const memoryMapLayoutOptions={
  'elk.algorithm':'layered',
  'elk.direction':'RIGHT',
  'elk.edgeRouting':'ORTHOGONAL',
  'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy':'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy':'BRANDES_KOEPF',
  'elk.layered.spacing.nodeNodeBetweenLayers':'92',
  'elk.spacing.nodeNode':'48',
  'elk.separateConnectedComponents':'true',
  'elk.spacing.componentComponent':'72',
  'elk.padding':'[top=36,left=36,bottom=36,right=36]',
} as const;

/** Calculate presentation-only positions. Stable input ordering keeps Reset layout predictable. */
export async function layoutMemoryMap<N extends LayoutNode,E extends LayoutEdge>(nodes:N[],edges:E[],direction:'RIGHT'|'DOWN'='RIGHT'):Promise<N[]>{
  if(!nodes.length)return [];
  const orderedNodes=[...nodes].sort((a,b)=>a.id.localeCompare(b.id));
  const graph=await elk.layout({
    id:'memory-map',
    layoutOptions:{...memoryMapLayoutOptions,'elk.direction':direction},
    children:orderedNodes.map(node=>({
      id:node.id,
      width:node.measured?.width??node.width??184,
      height:node.measured?.height??node.height??64,
    })),
    edges:[...edges].sort((a,b)=>a.id.localeCompare(b.id)).map(edge=>({id:edge.id,sources:[edge.source],targets:[edge.target]})),
  });
  const positions=new Map((graph.children??[]).map(node=>[node.id,{x:node.x??0,y:node.y??0}]));
  return nodes.map(node=>({...node,position:positions.get(node.id)??node.position}));
}
