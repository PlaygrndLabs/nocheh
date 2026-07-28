import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Lightbulb, NotebookPen, RefreshCw, Send } from "lucide-react";
import {
  api,
  type BrainGraphEdge,
  type BrainGraphNode,
  type BrainSuggestion,
} from "../api/client.js";
import { KnowledgeGraph, type KnowledgeGraphEdge, type KnowledgeGraphNode } from "../components/KnowledgeGraph.js";
import { Card, Notice, PageHeader, type NoticeMessage } from "../components/ui.js";

const NOTES_STORAGE_KEY = "nocheh.notes";

interface NoteEntry {
  readonly text: string;
  readonly sentAt: string;
}

/** Loads the local note transcript from localStorage, tolerating malformed storage. */
function loadNotes(): NoteEntry[] {
  try {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is NoteEntry =>
        typeof item === "object"
        && item !== null
        && typeof (item as NoteEntry).text === "string"
        && typeof (item as NoteEntry).sentAt === "string",
    );
  } catch {
    return [];
  }
}

export function Notes(): JSX.Element {
  const [notes, setNotes] = useState<NoteEntry[]>(loadNotes);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [nodes, setNodes] = useState<BrainGraphNode[]>([]);
  const [edges, setEdges] = useState<BrainGraphEdge[]>([]);
  const [suggestions, setSuggestions] = useState<BrainSuggestion[]>([]);
  const [hasAiKey, setHasAiKey] = useState<boolean | null>(null);

  // Persist the local transcript so notes Mak has sent survive reloads.
  useEffect(() => {
    try {
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
    } catch {
      // Ignore quota / unavailable storage; the transcript still works in-memory.
    }
  }, [notes]);

  const loadKnowledge = useCallback(async (): Promise<void> => {
    const [graph, pending] = await Promise.all([
      api.getBrainGraph(),
      api.getBrainSuggestions(),
    ]);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setSuggestions(pending.suggestions);
  }, []);

  // Show the current knowledge and AI status when the page opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.getSetupStatus();
        if (!cancelled) {
          setHasAiKey(status.hasAiKey);
        }
      } catch {
        if (!cancelled) {
          setHasAiKey(null);
        }
      }
      try {
        await loadKnowledge();
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", text: (error as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadKnowledge]);

  const send = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.sendNote({ text: trimmed });
      setNotes((current) => [...current, { text: trimmed, sentAt: new Date().toISOString() }]);
      setText("");
      await loadKnowledge();
      setNotice(hasAiKey === false
        ? { kind: "success", text: "Note sent. AI is in dry-run mode, so knowledge did not change. Configure an AI provider in Setup to let notes update the brain." }
        : { kind: "success", text: "Note sent. Nocheh turned it into knowledge and refreshed the graph and suggestions below." });
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [text, hasAiKey, loadKnowledge]);

  const refresh = useCallback((): void => {
    setNotice(null);
    loadKnowledge().catch((error: Error) => setNotice({ kind: "error", text: error.message }));
  }, [loadKnowledge]);

  const graph = useMemo(() => toKnowledgeGraph(nodes, edges), [nodes, edges]);

  return (
    <div>
      <PageHeader
        title="Notes"
        subtitle="Send Nocheh an authoritative instruction. A note is an out-of-band command from Mak (not group chatter) — it bypasses buffering and is turned into knowledge right away: new graph nodes, links, memories, and tasks, and it can correct or close open tasks."
      />

      {hasAiKey === false && (
        <div className="notice" role="status">
          <Lightbulb className="notice-icon" size={16} aria-hidden="true" />
          <span>
            AI is disabled (dry-run). Notes are recorded and sent, but the backend produces no knowledge changes until an
            AI provider is configured in Setup. The graph and suggestions below will not change from a note while dry-run is active.
          </span>
        </div>
      )}

      <Notice message={notice} />

      <Card title="Send a note" icon={<NotebookPen size={16} aria-hidden="true" />} className="section-card">
        <div className="notes-chat" aria-label="Notes to Nocheh">
          <div className="transcript notes-transcript">
            {notes.length === 0 ? (
              <p className="muted empty-chat">No notes yet. Write an instruction like "close the release-notes task" or "remember that Alice owns the mobile app".</p>
            ) : (
              notes.map((note, index) => (
                <div key={index} className="bubble user">
                  <span className="who">Mak · note · {new Date(note.sentAt).toLocaleString()}</span>
                  {note.text}
                </div>
              ))
            )}
          </div>
          <div className="composer-row">
            <textarea
              aria-label="Note to Nocheh"
              value={text}
              placeholder="Send an instruction to Nocheh (Cmd/Ctrl+Enter to send)…"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void send();
                }
              }}
            />
            <button className="action" disabled={busy || text.trim().length === 0} onClick={() => void send()}>
              <Send size={15} aria-hidden="true" />
              {busy ? "Sending…" : "Send note"}
            </button>
          </div>
        </div>
      </Card>

      <div className="knowledge-page-actions">
        <button className="action" disabled={busy} onClick={refresh}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh knowledge
        </button>
        <span>{nodes.length.toLocaleString()} memories</span>
        <span>{edges.length.toLocaleString()} links</span>
        <span>{suggestions.length.toLocaleString()} pending</span>
      </div>

      <Card title="Knowledge graph" icon={<GitBranch size={16} aria-hidden="true" />} className="section-card">
        <KnowledgeGraph
          nodes={graph.nodes}
          edges={graph.edges}
          emptyMessage="No knowledge graph yet. Send a note (a configured AI provider is required for real results)."
          height={420}
        />
      </Card>

      <Card title="Pending suggestions" className="section-card">
        <div className="plain-list" aria-label="Pending suggestions">
          {suggestions.length === 0 ? (
            <p className="plain-empty">No pending suggestions. Notes that imply goals or actions will show up here for review.</p>
          ) : (
            suggestions.map((suggestion) => (
              <article key={suggestion.id} className={`plain-item tone-${riskTone(suggestion.riskLevel)}`}>
                <div>
                  <b>{suggestion.title}</b>
                  <p>{suggestion.rationale}</p>
                </div>
                <span>{suggestion.riskLevel} risk · {(suggestion.confidence * 100).toFixed(0)}%</span>
              </article>
            ))
          )}
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

function riskTone(risk: BrainSuggestion["riskLevel"]): "ok" | "warn" | "blocked" {
  if (risk === "high") {
    return "blocked";
  }
  if (risk === "medium") {
    return "warn";
  }
  return "ok";
}
