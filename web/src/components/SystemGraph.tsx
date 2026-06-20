import { GRAPH_EDGES, GRAPH_NODES, type GraphNode, type NodeStatus, type TimelineFrame } from "../sim/pipeline.js";

const CANVAS_W = 1000;
const CANVAS_H = 520;
const NODE_W = 104;
const NODE_H = 46;

interface SystemGraphProps {
  readonly frames: TimelineFrame[];
  readonly activeIndex: number;
}

/** Hand-built system-design graph: SVG edge layer + positioned node cards. */
export function SystemGraph({ frames, activeIndex }: SystemGraphProps): JSX.Element {
  const nodeById = new Map(GRAPH_NODES.map((node) => [node.id, node]));
  const statusByNode = computeStatuses(frames, activeIndex);
  const activeNodeId = activeIndex >= 0 ? frames[activeIndex]?.nodeId : undefined;
  const activeFrame = activeIndex >= 0 ? frames[activeIndex] : undefined;

  return (
    <div className="system-graph">
      <svg
        className="graph-edges"
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {GRAPH_EDGES.map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (from === undefined || to === undefined) {
            return null;
          }
          const active = edge.to === activeNodeId;
          return (
            <path
              key={`${edge.from}-${edge.to}`}
              className={`graph-edge${active ? " active" : ""}`}
              d={edgePath(from, to)}
              fill="none"
            />
          );
        })}
        {activeFrame?.dataLabel !== undefined && activeNodeId !== undefined && renderDataLabel(nodeById, activeNodeId, activeFrame.dataLabel)}
      </svg>

      {GRAPH_NODES.map((node) => {
        const status = statusByNode.get(node.id) ?? "idle";
        const isActive = node.id === activeNodeId;
        return (
          <div
            key={node.id}
            className={`graph-node ${node.kind} ${status}${isActive ? " is-active" : ""}`}
            style={{
              left: `${(node.x / CANVAS_W) * 100}%`,
              top: `${(node.y / CANVAS_H) * 100}%`,
              width: `${(NODE_W / CANVAS_W) * 100}%`,
            }}
            title={`${node.label}: ${status}`}
            role="listitem"
          >
            <span className="graph-node-label">{node.label}</span>
            <span className="graph-node-status">{status}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Resolves each node's status from the frames played so far. */
function computeStatuses(frames: TimelineFrame[], activeIndex: number): Map<string, NodeStatus> {
  const result = new Map<string, NodeStatus>();
  if (activeIndex < 0) {
    return result;
  }
  for (let index = 0; index <= activeIndex && index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) {
      continue;
    }
    result.set(frame.nodeId, index === activeIndex ? "active" : frame.status);
  }
  return result;
}

function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function renderDataLabel(nodeById: Map<string, GraphNode>, nodeId: string, label: string): JSX.Element | null {
  const node = nodeById.get(nodeId);
  if (node === undefined) {
    return null;
  }
  return (
    <text className="graph-data-label" x={node.x + NODE_W / 2} y={node.y - 6} textAnchor="middle">
      {label}
    </text>
  );
}
