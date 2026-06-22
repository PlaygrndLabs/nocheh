import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { api, type BrainGraphEdge, type BrainGraphNode } from "../api/client.js";
import { KnowledgeGraph, type KnowledgeGraphEdge, type KnowledgeGraphNode } from "../components/KnowledgeGraph.js";
import { Card, PageHeader } from "../components/ui.js";

export function Knowledge(): JSX.Element {
  const [nodes, setNodes] = useState<BrainGraphNode[]>([]);
  const [edges, setEdges] = useState<BrainGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    setError(null);
    api.getBrainGraph()
      .then((graph) => {
        setNodes(graph.nodes);
        setEdges(graph.edges);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const graph = useMemo(() => toKnowledgeGraph(nodes, edges), [nodes, edges]);
  const recentEdges = edges.slice(0, 8);

  return (
    <div>
      <PageHeader
        title="Knowledge graph"
        subtitle="A visual map of the memories Nocheh has connected across people, projects, goals, routines, ideas, risks, and assets."
      />

      <div className="knowledge-page-actions">
        <button className="action" disabled={loading} onClick={refresh}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading ? "Loading" : "Refresh"}
        </button>
        <span>{nodes.length.toLocaleString()} memories</span>
        <span>{edges.length.toLocaleString()} links</span>
      </div>

      {error !== null && <div className="notice error">{error}</div>}

      <Card title="Memory map" icon={<GitBranch size={16} aria-hidden="true" />} className="section-card">
        <KnowledgeGraph
          nodes={graph.nodes}
          edges={graph.edges}
          emptyMessage="No persisted knowledge graph yet. Import history or process Telegram messages to create memory links."
          height={620}
        />
      </Card>

      <Card title="Recent links" className="section-card">
        <div className="knowledge-link-list">
          {recentEdges.length === 0 && <p className="muted">No links stored yet.</p>}
          {recentEdges.map((edge) => (
            <article key={edge.id}>
              <b>{humanRelation(edge.relation)}</b>
              <p>{edge.fact}</p>
            </article>
          ))}
        </div>
      </Card>
    </div>
  );
}

function toKnowledgeGraph(
  nodes: readonly BrainGraphNode[],
  edges: readonly BrainGraphEdge[],
): { readonly nodes: readonly KnowledgeGraphNode[]; readonly edges: readonly KnowledgeGraphEdge[] } {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: node.status,
      confidence: node.confidence,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      relation: edge.relation,
      fact: edge.fact,
      confidence: edge.confidence,
    })),
  };
}

function humanRelation(relation: string): string {
  return relation
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
