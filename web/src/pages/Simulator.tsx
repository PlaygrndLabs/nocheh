import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrainCircuit, Database, GitBranch, Lightbulb, MessageCircle, Play, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { GroupChat } from "../components/GroupChat.js";
import { FlowDiagram } from "../components/FlowDiagram.js";
import { KnowledgeGraph, type KnowledgeGraphEdge, type KnowledgeGraphNode } from "../components/KnowledgeGraph.js";
import { PlaybackBar } from "../components/PlaybackBar.js";
import { StageInspector } from "../components/StageInspector.js";
import { Notice, type NoticeMessage } from "../components/ui.js";
import { buildBrainPreview, type BrainPreview } from "../sim/brain-preview.js";
import { buildFlow, stageById, type StageId } from "../sim/flow-model.js";
import { simulateLocalProcessing } from "../sim/local-processor.js";
import { useFlowPlayback } from "../sim/useFlowPlayback.js";
import { useSimulation } from "../state/useSimulation.js";

const SCENARIOS = [
  {
    label: "Startup",
    text: "We need a decision with my startup partner: who owns sales, what risks block launch, and what should be our next goal?",
  },
  {
    label: "Routine",
    text: "I keep missing my weekly review. Idea: create a Sunday routine for planning, English practice, X posts, and freelance follow-ups.",
  },
  {
    label: "Content",
    text: "I want to grow on X. Need three content ideas from my current startup lessons and a posting routine.",
  },
  {
    label: "Trading",
    text: "Crypto note: BTC looks interesting but do not trade. Build a thesis, risk rule, and journal reminder before any action.",
  },
] as const;

type DockTab = "stage" | "insights" | "knowledge";

export function Simulator(): JSX.Element {
  const [conversationId, setConversationId] = useState("mock-chat-1");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [selectedStageId, setSelectedStageId] = useState<StageId | null>(null);
  const [activeTab, setActiveTab] = useState<DockTab>("stage");

  const sim = useSimulation(conversationId);

  const brainPreview = useMemo(() => buildBrainPreview(sim.entries), [sim.entries]);
  const frames = useMemo(
    () => (sim.lastAssistant === undefined ? [] : buildFlow(sim.lastAssistant.record, brainPreview)),
    [sim.lastAssistant, brainPreview],
  );
  const playback = useFlowPlayback(frames);

  // Auto-play whenever a freshly processed record becomes the latest.
  const playRef = useRef(playback.restart);
  playRef.current = playback.restart;
  const lastPlayedId = useRef<string | null>(null);
  useEffect(() => {
    if (sim.lastAssistant !== undefined && sim.lastAssistant.auditId !== lastPlayedId.current && frames.length > 0) {
      lastPlayedId.current = sim.lastAssistant.auditId;
      setSelectedStageId(null);
      playRef.current();
    }
  }, [sim.lastAssistant, frames]);

  // Clicking a stage seeks the playback there, surfaces its detail tab, and keeps things in sync.
  const onSelectStage = useCallback((id: StageId): void => {
    setSelectedStageId(id);
    setActiveTab("stage");
    const index = frames.findIndex((frame) => frame.stageId === id);
    if (index >= 0) {
      playback.seek(index);
    }
  }, [frames, playback]);

  const inspectedStageId: StageId = selectedStageId
    ?? (playback.activeIndex >= 0 ? frames[playback.activeIndex]?.stageId : undefined)
    ?? "chat";
  const inspectedFrame = frames.find((frame) => frame.stageId === inspectedStageId);

  const send = useCallback(async (message: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    sim.addUserEntry(sim.activeMemberName, message);
    try {
      await delay(140);
      sim.ingestRecords([simulateLocalProcessing({
        conversationId,
        text: message,
        senderDisplayName: sim.activeMemberName,
      })]);
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, sim]);

  const clear = useCallback((): void => {
    if (!confirm("Clear this local simulation? This does not delete real app data because the simulator does not write to it.")) {
      return;
    }
    setNotice(null);
    sim.clear();
    lastPlayedId.current = null;
    setSelectedStageId(null);
    setNotice({ kind: "success", text: "Local simulation cleared. No persisted conversations were changed." });
  }, [sim]);

  const DOCK_TABS: ReadonlyArray<{ readonly id: DockTab; readonly label: string; readonly icon: JSX.Element }> = [
    { id: "stage", label: "Stage detail", icon: <Workflow size={14} aria-hidden="true" /> },
    { id: "insights", label: "What Nocheh noticed", icon: <BrainCircuit size={14} aria-hidden="true" /> },
    { id: "knowledge", label: "Knowledge graph", icon: <GitBranch size={14} aria-hidden="true" /> },
  ];

  return (
    <section className="sim-page" aria-label="System flow simulator">
      <header className="sim-topbar">
        <div className="sim-topbar-title">
          <h2>Simulator</h2>
          <p>Post a mock message and watch it flow through Nocheh, stage by stage.</p>
        </div>
        <div className="sim-conversation-field">
          <label htmlFor="conv">Simulation ID</label>
          <input id="conv" value={conversationId} onChange={(event) => setConversationId(event.target.value)} />
        </div>
        <div className="sim-mode-pill" aria-label="Persistence mode">
          <span>storage</span>
          <b className="ok">local only</b>
        </div>
        <div className="sim-samples" aria-label="Sample messages">
          <span><Play size={13} aria-hidden="true" /></span>
          {SCENARIOS.map((scenario) => (
            <button key={scenario.label} disabled={busy} onClick={() => void send(scenario.text)}>
              {scenario.label}
            </button>
          ))}
        </div>
        <button className="action" disabled={busy} onClick={() => clear()}><Trash2 size={14} aria-hidden="true" />Clear</button>
      </header>

      <Notice message={notice} />

      <div className="sim-body">
        <section className="sim-panel sim-chat-panel" aria-label="Mock Telegram chat">
          <div className="sim-panel-header">
            <span><MessageCircle size={15} aria-hidden="true" /> Telegram chat</span>
            <b>{conversationId}</b>
          </div>
          <GroupChat
            entries={sim.entries}
            members={sim.members}
            activeMemberId={sim.activeMemberId}
            busy={busy}
            onSetActiveMember={sim.setActiveMember}
            onAddMember={sim.addMember}
            onRemoveMember={sim.removeMember}
            onSend={(text) => void send(text)}
          />
        </section>

        <section className="sim-panel sim-flow-panel" aria-label="System flow">
          <div className="sim-panel-header">
            <span><Workflow size={15} aria-hidden="true" /> System flow</span>
            <FlowStatus
              hasRecord={sim.lastAssistant !== undefined}
              activeIndex={playback.activeIndex}
              frameCount={frames.length}
              hasError={(sim.lastAssistant?.record.errorLogs.length ?? 0) > 0}
              latencyMs={sim.lastAssistant?.record.totalLatencyMs}
            />
          </div>
          <FlowDiagram
            frames={frames}
            activeIndex={playback.activeIndex}
            selectedStageId={selectedStageId}
            onSelectStage={onSelectStage}
          />
          <PlaybackBar playback={playback} frames={frames} />
        </section>
      </div>

      <section className="sim-dock sim-panel" aria-label="Analysis detail">
        <div className="sim-tabs" role="tablist">
          {DOCK_TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`sim-tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
        <div className="sim-dock-body" role="tabpanel">
          {activeTab === "stage" && (
            <StageInspector
              stage={stageById(inspectedStageId)}
              frame={inspectedFrame}
              record={sim.lastAssistant?.record}
              preview={brainPreview}
            />
          )}
          {activeTab === "insights" && <BrainConsole preview={brainPreview} />}
          {activeTab === "knowledge" && <KnowledgeTab preview={brainPreview} />}
        </div>
      </section>
    </section>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function FlowStatus({
  hasRecord,
  activeIndex,
  frameCount,
  hasError,
  latencyMs,
}: {
  readonly hasRecord: boolean;
  readonly activeIndex: number;
  readonly frameCount: number;
  readonly hasError: boolean;
  readonly latencyMs: number | undefined;
}): JSX.Element {
  if (!hasRecord) {
    return <b className="muted">waiting</b>;
  }
  if (activeIndex >= 0 && activeIndex < frameCount - 1) {
    return <b className="warn">running {activeIndex + 1}/{frameCount}</b>;
  }
  if (hasError) {
    return <b className="fail">error</b>;
  }
  return <b className="ok">{(latencyMs ?? 0).toFixed(0)} ms</b>;
}

function BrainConsole({ preview }: { readonly preview: BrainPreview }): JSX.Element {
  const memories: PlainItem[] = preview.memories
    .filter((memory) => memory.type !== "Preview")
    .map((memory) => ({
      title: memory.title,
      detail: memory.detail,
      badge: memory.status === "pending" ? "Needs review" : "Would remember",
      tone: memory.status === "pending" ? "warn" : "ok",
    }));
  const suggestions: PlainItem[] = preview.suggestions.map((suggestion) => ({
    title: suggestion.title,
    detail: suggestion.rationale,
    badge: suggestion.status === "blocked" ? "Approval required" : "Idea",
    tone: suggestion.status === "blocked" ? "blocked" : "warn",
  }));
  const guardrails: PlainItem[] = preview.guardrails.map((guardrail) => ({
    title: plainGuardrailTitle(guardrail.label),
    detail: guardrail.detail,
    badge: guardrail.status === "ok" ? "OK" : guardrail.status === "blocked" ? "Stopped" : "Careful",
    tone: guardrail.status === "ok" ? "ok" : guardrail.status === "blocked" ? "blocked" : "warn",
  }));

  return (
    <div className="plain-brain" aria-label="Simple Nocheh simulator analysis">
      <div className="plain-stat-row" aria-label="Simulator summary">
        <PlainStat label="Messages" value={preview.metrics.messages} />
        <PlainStat label="Memories" value={preview.metrics.memories} />
        <PlainStat label="Ideas" value={preview.metrics.suggestions} />
        <PlainStat label="Blocked" value={preview.metrics.blocked} />
      </div>

      <CollapsibleCard
        icon={<Database size={15} aria-hidden="true" />}
        title="What it would remember"
        count={memories.length}
        empty="No useful memory yet. Send a mock message first."
        items={memories}
        defaultOpen
      />
      <CollapsibleCard
        icon={<Lightbulb size={15} aria-hidden="true" />}
        title="Ideas it would suggest"
        count={suggestions.length}
        empty="No ideas yet. Try Startup, Routine, Content, or Trading."
        items={suggestions}
      />
      <CollapsibleCard
        icon={<ShieldCheck size={15} aria-hidden="true" />}
        title="Safety checks"
        count={guardrails.length}
        empty="No safety checks yet."
        items={guardrails}
      />
    </div>
  );
}

function KnowledgeTab({ preview }: { readonly preview: BrainPreview }): JSX.Element {
  const graph = buildPreviewKnowledgeGraph(preview);
  return (
    <KnowledgeGraph
      nodes={graph.nodes}
      edges={graph.edges}
      emptyMessage="No knowledge graph yet. Send a mock message first."
      height={260}
    />
  );
}

function PlainStat({ label, value }: { readonly label: string; readonly value: number }): JSX.Element {
  return (
    <div className="plain-stat">
      <span>{label}</span>
      <b>{value.toLocaleString()}</b>
    </div>
  );
}

function CollapsibleCard({
  icon,
  title,
  count,
  empty,
  items,
  defaultOpen = false,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly count: number;
  readonly empty: string;
  readonly items: readonly PlainItem[];
  readonly defaultOpen?: boolean;
}): JSX.Element {
  return (
    <details className="plain-card" open={defaultOpen}>
      <summary>
        <span className="plain-section-title">{icon}<b>{title}</b></span>
        <span className="plain-card-count">{count}</span>
      </summary>
      {items.length === 0 ? (
        <p className="plain-empty">{empty}</p>
      ) : (
        <div className="plain-list">
          {items.map((item) => (
            <article key={`${title}-${item.title}-${item.badge}`} className={`plain-item tone-${item.tone}`}>
              <div>
                <b>{item.title}</b>
                <p>{item.detail}</p>
              </div>
              <span>{item.badge}</span>
            </article>
          ))}
        </div>
      )}
    </details>
  );
}

interface PlainItem {
  readonly title: string;
  readonly detail: string;
  readonly badge: string;
  readonly tone: "ok" | "warn" | "blocked" | "neutral";
}

function plainGuardrailTitle(label: string): string {
  if (label.toLowerCase().includes("approval")) {
    return "Wait for your approval";
  }
  if (label.toLowerCase().includes("retention")) {
    return "Protect private data";
  }
  if (label.toLowerCase().includes("cost")) {
    return "Keep AI usage controlled";
  }
  return label;
}

function buildPreviewKnowledgeGraph(preview: BrainPreview): {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphEdge[];
} {
  const nodesByLabel = new Map<string, KnowledgeGraphNode>();
  for (const node of preview.nodes) {
    nodesByLabel.set(node.label, {
      id: node.id,
      kind: node.kind,
      label: node.label,
      status: node.status,
      confidence: node.confidence,
    });
  }

  for (const edge of preview.edges) {
    ensurePreviewNode(nodesByLabel, edge.from);
    ensurePreviewNode(nodesByLabel, edge.to);
  }

  const edges = preview.edges.map((edge) => ({
    id: `${nodeIdFor(nodesByLabel, edge.from)}:${edge.relation}:${nodeIdFor(nodesByLabel, edge.to)}`,
    fromNodeId: nodeIdFor(nodesByLabel, edge.from),
    toNodeId: nodeIdFor(nodesByLabel, edge.to),
    relation: edge.relation,
    confidence: edge.confidence,
  }));

  return {
    nodes: [...nodesByLabel.values()].filter((node) => node.label !== "No live input yet"),
    edges,
  };
}

function ensurePreviewNode(nodesByLabel: Map<string, KnowledgeGraphNode>, label: string): void {
  if (nodesByLabel.has(label)) {
    return;
  }
  nodesByLabel.set(label, {
    id: `preview:${slug(label)}`,
    kind: inferPreviewKind(label),
    label,
    status: "simulated",
    confidence: 0.7,
  });
}

function nodeIdFor(nodesByLabel: Map<string, KnowledgeGraphNode>, label: string): string {
  const node = nodesByLabel.get(label);
  if (node === undefined) {
    throw new Error(`Missing preview graph node: ${label}`);
  }
  return node.id;
}

function inferPreviewKind(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("mak") || normalized.includes("partner")) {
    return "person";
  }
  if (normalized.includes("risk")) {
    return "risk";
  }
  if (normalized.includes("goal") || normalized.includes("growth")) {
    return "goal";
  }
  if (normalized.includes("routine")) {
    return "routine";
  }
  if (normalized.includes("project") || normalized.includes("startup")) {
    return "project";
  }
  return "concept";
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";
}
