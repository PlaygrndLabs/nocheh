import { useEffect, useMemo, useRef } from "react";
import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
  type D3DragEvent,
  type D3ZoomEvent,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3";

const CANVAS_W = 980;
const CANVAS_H = 560;
const MAX_NODES = 32;
const MAX_EDGES = 48;
const MIN_RADIUS = 18;
const MAX_RADIUS = 34;

export interface KnowledgeGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly status?: string;
  readonly confidence?: number;
  readonly summary?: string;
}

export interface KnowledgeGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: string;
  readonly fact?: string;
  readonly confidence?: number;
}

interface SimNode extends SimulationNodeDatum {
  readonly id: string;
  readonly source: KnowledgeGraphNode;
  readonly degree: number;
  readonly radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  readonly id: string;
  readonly relation: string;
}

interface KnowledgeGraphProps {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
  readonly emptyMessage: string;
  readonly height?: number;
}

/** Live, interactive d3 force-directed graph: draggable nodes, zoom/pan, running simulation. */
export function KnowledgeGraph({ nodes, edges, emptyMessage, height = 460 }: KnowledgeGraphProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomGroupRef = useRef<SVGGElement | null>(null);

  const { simNodes, simLinks } = useMemo(() => buildGraph(nodes, edges), [nodes, edges]);

  useEffect(() => {
    const svgEl = svgRef.current;
    const groupEl = zoomGroupRef.current;
    if (svgEl === null || groupEl === null || simNodes.length === 0) {
      return;
    }

    // React owns element creation; bind data by the data-id attribute so the
    // key function works on the already-rendered (data-less) DOM nodes too.
    const keyById = function (this: Element, d: unknown): string {
      return (d as { id?: string } | undefined)?.id ?? this.getAttribute("data-id") ?? "";
    };
    const group = select(groupEl);
    const linkSel = group.selectAll<SVGLineElement, unknown>(".knowledge-edge").data(simLinks, keyById);
    const labelSel = group.selectAll<SVGTextElement, unknown>(".knowledge-edge-label").data(simLinks, keyById);
    const nodeSel = group.selectAll<SVGGElement, unknown>(".knowledge-node").data(simNodes, keyById);

    const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(simNodes)
      .force("link", forceLink<SimNode, SimLink>(simLinks)
        .id((node) => node.id)
        .distance((link) => linkDistance(link))
        .strength(0.55))
      .force("charge", forceManyBody<SimNode>().strength((node) => -240 - node.degree * 40))
      .force("collide", forceCollide<SimNode>().radius((node) => node.radius + 26).strength(0.9))
      .force("center", forceCenter(CANVAS_W / 2, CANVAS_H / 2))
      .force("x", forceX<SimNode>(CANVAS_W / 2).strength(0.05))
      .force("y", forceY<SimNode>(CANVAS_H / 2).strength(0.07));

    simulation.on("tick", () => {
      linkSel
        .attr("x1", (d) => endpoint(d.source).x)
        .attr("y1", (d) => endpoint(d.source).y)
        .attr("x2", (d) => endpoint(d.target).x)
        .attr("y2", (d) => endpoint(d.target).y);
      labelSel
        .attr("x", (d) => (endpoint(d.source).x + endpoint(d.target).x) / 2)
        .attr("y", (d) => (endpoint(d.source).y + endpoint(d.target).y) / 2 - 6);
      nodeSel.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });

    const dragBehavior = drag<SVGGElement, SimNode>()
      .on("start", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (event.active === 0) {
          simulation.alphaTarget(0.3).restart();
        }
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event: D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (event.active === 0) {
          simulation.alphaTarget(0);
        }
        d.fx = null;
        d.fy = null;
      });
    nodeSel.call(dragBehavior);

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 2.4])
      // Explicit extent: d3-zoom's default reads SVG geometry that jsdom lacks.
      .extent([[0, 0], [CANVAS_W, CANVAS_H]])
      .filter((event) => !(event.target as Element).closest(".knowledge-node"))
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        group.attr("transform", event.transform.toString());
      });
    const svg = select(svgEl);
    svg.call(zoomBehavior).call(zoomBehavior.transform, zoomIdentity);

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      nodeSel.on(".drag", null);
    };
  }, [simNodes, simLinks]);

  if (simNodes.length === 0) {
    return (
      <div className="knowledge-graph empty" style={{ minHeight: height }}>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="knowledge-graph" style={{ minHeight: height }}>
      <svg
        ref={svgRef}
        className="knowledge-svg"
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="list"
        aria-label="Knowledge graph"
      >
        <g ref={zoomGroupRef} className="knowledge-zoom">
          {simLinks.map((link) => (
            <line key={link.id} data-id={link.id} className="knowledge-edge" />
          ))}
          {simLinks.map((link) => (
            <text key={`label-${link.id}`} data-id={link.id} className="knowledge-edge-label" textAnchor="middle">
              {humanRelation(link.relation)}
            </text>
          ))}
          {simNodes.map((node) => (
            <g
              key={node.id}
              data-id={node.id}
              className={`knowledge-node kind-${kindClass(node.source.kind)} status-${node.source.status ?? "active"}`}
              role="listitem"
              tabIndex={0}
            >
              <title>{node.source.summary ?? node.source.label}</title>
              <circle className="knowledge-node-circle" r={node.radius} />
              <text className="knowledge-node-kind" y={4 - node.radius - 6} textAnchor="middle">
                {humanKind(node.source.kind)}
              </text>
              <text className="knowledge-node-label" y={node.radius + 16} textAnchor="middle">
                {node.source.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <p className="knowledge-hint">Drag nodes to explore · scroll to zoom · drag the canvas to pan</p>
    </div>
  );
}

function buildGraph(
  sourceNodes: readonly KnowledgeGraphNode[],
  sourceEdges: readonly KnowledgeGraphEdge[],
): { readonly simNodes: SimNode[]; readonly simLinks: SimLink[] } {
  const visibleNodes = sourceNodes.slice(0, MAX_NODES);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = sourceEdges
    .filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId))
    .slice(0, MAX_EDGES);

  const degree = new Map<string, number>();
  for (const edge of visibleEdges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
  }

  const sorted = [...visibleNodes].sort((a, b) => {
    const delta = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    return delta === 0 ? a.label.localeCompare(b.label) : delta;
  });

  const simNodes: SimNode[] = sorted.map((node, index) => {
    const nodeDegree = degree.get(node.id) ?? 0;
    return {
      id: node.id,
      source: node,
      degree: nodeDegree,
      radius: Math.min(MAX_RADIUS, MIN_RADIUS + nodeDegree * 4),
      // Deterministic starting ring so the layout converges the same way each render.
      x: CANVAS_W / 2 + Math.cos(index * 1.7) * 160,
      y: CANVAS_H / 2 + Math.sin(index * 1.7) * 120,
    };
  });

  const simLinks: SimLink[] = visibleEdges.map((edge) => ({
    id: edge.id,
    relation: edge.relation,
    source: edge.fromNodeId,
    target: edge.toNodeId,
  }));

  return { simNodes, simLinks };
}

function linkDistance(link: SimLink): number {
  const source = typeof link.source === "object" ? link.source.degree : 0;
  const target = typeof link.target === "object" ? link.target.degree : 0;
  return Math.max(90, 170 - (source + target) * 6);
}

function endpoint(node: string | number | SimNode | undefined): { readonly x: number; readonly y: number } {
  if (typeof node === "object" && node !== null) {
    return { x: node.x ?? CANVAS_W / 2, y: node.y ?? CANVAS_H / 2 };
  }
  return { x: CANVAS_W / 2, y: CANVAS_H / 2 };
}

function humanRelation(relation: string): string {
  return relation
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanKind(kind: string): string {
  return humanRelation(kind).replace("Plan", " plan");
}

function kindClass(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
