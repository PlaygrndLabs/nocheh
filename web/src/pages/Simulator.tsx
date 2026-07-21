import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BrainCircuit,
  GitBranch,
  Lightbulb,
  MessageCircle,
  NotebookPen,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import {
  api,
  type BrainGraphEdge,
  type BrainGraphNode,
  type BrainSuggestion,
  type GroupSettings,
} from "../api/client.js";
import { GroupChat } from "../components/GroupChat.js";
import { FlowDiagram } from "../components/FlowDiagram.js";
import { KnowledgeGraph, type KnowledgeGraphEdge, type KnowledgeGraphNode } from "../components/KnowledgeGraph.js";
import { PlaybackBar } from "../components/PlaybackBar.js";
import { StageInspector } from "../components/StageInspector.js";
import { Notice, type NoticeMessage } from "../components/ui.js";
import { buildFlow, stageById, type FlowInsights, type StageId } from "../sim/flow-model.js";
import { useFlowPlayback } from "../sim/useFlowPlayback.js";
import { useSimulation, createMessageId } from "../state/useSimulation.js";

const EMPTY_INSIGHTS: FlowInsights = { nodes: [], edges: [], suggestions: [] };

interface ScenarioMessage {
  readonly from: string;
  readonly text: string;
}

interface Scenario {
  readonly label: string;
  readonly messages: readonly ScenarioMessage[];
  /** When set, running the scenario also switches the active group to this project mode. */
  readonly projectHint?: ProjectHint;
}

/** Natural, unstructured multi-message threads — no "Project:"/"Task:" prefixes. */
const SCENARIOS: readonly Scenario[] = [
  {
    label: "Startup",
    messages: [
      { from: "Alice", text: "hey, I think we should ship the beta this week — can someone own the release notes?" },
      { from: "Bob", text: "I can draft them tomorrow, but we still haven't decided pricing with the partner." },
      { from: "You", text: "let's lock pricing on Friday's call, that's the real blocker before launch." },
    ],
  },
  {
    label: "Routine",
    messages: [
      { from: "You", text: "I keep skipping my weekly review and it's wrecking my planning." },
      { from: "Alice", text: "maybe try a short Sunday reset — 20 minutes, same time each week?" },
      { from: "You", text: "yeah I'll test a Sunday routine and see if it actually sticks." },
    ],
  },
  {
    label: "Content",
    messages: [
      { from: "You", text: "I want to grow my X account but I never know what to post." },
      { from: "Bob", text: "your startup lessons are gold, turn each one into a short thread." },
      { from: "You", text: "good call, I'll batch three post ideas from this week's wins." },
    ],
  },
  {
    // An org group running two parallel projects with different owners and tasks.
    // Flips the group to multi-project mode so the LLM infers two distinct Project nodes.
    label: "Org (2 projects)",
    projectHint: "multi",
    messages: [
      { from: "Alice", text: "quick sync — we've got two things landing this month: the mobile app launch and the marketing site revamp." },
      { from: "Bob", text: "I'm on the mobile app. I'll finalize the App Store screenshots and submit the iOS build for review by Thursday." },
      { from: "Carol", text: "I've got the marketing site. I'll rewrite the landing page copy and get the new pricing section live before we announce." },
      { from: "Alice", text: "perfect. Bob, can you also send out the TestFlight beta invites? Carol, please loop the designer in on the new hero section." },
      { from: "Bob", text: "on it — TestFlight invites go out tomorrow, then I'll chase down the login crash before I submit." },
      { from: "Carol", text: "will do. once the hero and pricing are done I'll hand the site to QA for a final pass." },
    ],
  },
] as const;

type ProjectHint = GroupSettings["projectHint"];

interface SimGroup {
  readonly id: string;
  readonly name: string;
}

interface SimGroupState {
  readonly groups: readonly SimGroup[];
  readonly activeId: string;
}

const GROUPS_STORAGE_KEY = "nocheh.sim.groups";
const DEFAULT_GROUP: SimGroup = { id: "mock-chat-1", name: "Main group" };

/** Loads the simulated group list from localStorage, falling back to a single default group. */
function loadGroupState(): SimGroupState {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { groups?: unknown; activeId?: unknown };
      const rawGroups = Array.isArray(parsed.groups) ? parsed.groups : [];
      const groups = rawGroups.filter(
        (item): item is SimGroup =>
          typeof item === "object"
          && item !== null
          && typeof (item as SimGroup).id === "string"
          && typeof (item as SimGroup).name === "string",
      );
      if (groups.length > 0) {
        const activeId = typeof parsed.activeId === "string" && groups.some((group) => group.id === parsed.activeId)
          ? parsed.activeId
          : (groups[0]?.id ?? DEFAULT_GROUP.id);
        return { groups, activeId };
      }
    }
  } catch {
    // Ignore malformed or unavailable storage; fall back to the default group.
  }
  return { groups: [DEFAULT_GROUP], activeId: DEFAULT_GROUP.id };
}

/** Derives a unique conversation id from a group name so transcripts never collide. */
function uniqueGroupId(name: string, existing: readonly SimGroup[]): string {
  const base = `mock-${slug(name)}`;
  let candidate = base;
  let counter = 1;
  while (existing.some((group) => group.id === candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

type DockTab = "stage" | "insights" | "knowledge";

export function Simulator(): JSX.Element {
  const [groupState, setGroupState] = useState<SimGroupState>(loadGroupState);
  const conversationId = groupState.activeId;
  const [newGroupName, setNewGroupName] = useState("");
  const [projectHint, setProjectHint] = useState<ProjectHint>("single");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [noteText, setNoteText] = useState("");
  const [selectedStageId, setSelectedStageId] = useState<StageId | null>(null);
  const [activeTab, setActiveTab] = useState<DockTab>("stage");
  const [pendingCount, setPendingCount] = useState(0);
  const [insights, setInsights] = useState<FlowInsights>(EMPTY_INSIGHTS);
  const [hasAiKey, setHasAiKey] = useState<boolean | null>(null);

  const sim = useSimulation(conversationId);

  const frames = useMemo(
    () => (sim.lastAssistant === undefined ? [] : buildFlow(sim.lastAssistant.record, insights)),
    [sim.lastAssistant, insights],
  );
  const playback = useFlowPlayback(frames);

  // Persist the simulated group list (and which one is active) so switching survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groupState));
    } catch {
      // Ignore quota / unavailable storage; the switcher still works in-memory.
    }
  }, [groupState]);

  // Load the active group's project mode, then configure batch mode so injected messages
  // buffer until "Run analysis". The batch update carries the group's projectHint so the
  // backend keeps the whole-group vs org-with-many-projects inference in sync.
  useEffect(() => {
    let cancelled = false;
    setPendingCount(0);
    setInsights(EMPTY_INSIGHTS);
    void (async () => {
      let hint: ProjectHint = "single";
      try {
        const result = await api.getSettings(conversationId);
        hint = result.settings.projectHint;
      } catch {
        hint = "single";
      }
      if (!cancelled) {
        setProjectHint(hint);
      }
      try {
        await api.putSettings(conversationId, {
          analysisMode: "batch",
          analysisIntervalSeconds: 86400,
          maxMessagesPerBatch: 100,
          projectHint: hint,
        });
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", text: `Could not set batch mode: ${(error as Error).message}. Messages may auto-flush.` });
        }
      }
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
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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

  const sendMessages = useCallback(async (
    messages: readonly { readonly senderId: string; readonly senderName: string; readonly text: string }[],
  ): Promise<void> => {
    const clean = messages
      .map((message) => ({ ...message, text: message.text.trim() }))
      .filter((message) => message.text.length > 0);
    if (clean.length === 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    const withIds = clean.map((message) => {
      const messageId = createMessageId();
      sim.addUserEntry(message.senderName, message.text, messageId);
      return { ...message, messageId };
    });
    try {
      await api.injectMock(withIds.map((message) => ({
        conversationId,
        text: message.text,
        messageId: message.messageId,
        senderId: message.senderId,
        senderDisplayName: message.senderName,
      })));
      setPendingCount((count) => count + withIds.length);
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, sim]);

  const send = useCallback((text: string): void => {
    void sendMessages([{ senderId: sim.activeMemberId, senderName: sim.activeMemberName, text }]);
  }, [sendMessages, sim.activeMemberId, sim.activeMemberName]);

  const setProjectMode = useCallback(async (hint: ProjectHint): Promise<void> => {
    setProjectHint(hint);
    try {
      await api.putSettings(conversationId, { projectHint: hint });
      setNotice({
        kind: "success",
        text: hint === "multi"
          ? "Project mode set to multi. Nocheh will infer several distinct projects in this group."
          : "Project mode set to single. Nocheh will treat this whole group as one project.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    }
  }, [conversationId]);

  const switchGroup = useCallback((id: string): void => {
    setNotice(null);
    setGroupState((current) => (current.activeId === id ? current : { ...current, activeId: id }));
  }, []);

  const addGroup = useCallback((name: string): void => {
    setGroupState((current) => {
      const trimmed = name.trim();
      const label = trimmed.length > 0 ? trimmed : `Group ${current.groups.length + 1}`;
      const id = uniqueGroupId(label, current.groups);
      return { groups: [...current.groups, { id, name: label }], activeId: id };
    });
  }, []);

  const removeGroup = useCallback((id: string): void => {
    setGroupState((current) => {
      if (current.groups.length <= 1) {
        return current;
      }
      const groups = current.groups.filter((group) => group.id !== id);
      const activeId = current.activeId === id ? (groups[0]?.id ?? current.activeId) : current.activeId;
      return { groups, activeId };
    });
  }, []);

  const commitNewGroup = useCallback((): void => {
    addGroup(newGroupName);
    setNewGroupName("");
  }, [addGroup, newGroupName]);

  const runScenario = useCallback((scenario: Scenario): void => {
    if (scenario.projectHint !== undefined) {
      void setProjectMode(scenario.projectHint);
    }
    void sendMessages(scenario.messages.map((message) => {
      const existing = sim.members.find((member) => member.name === message.from);
      return { senderId: existing?.id ?? slug(message.from), senderName: message.from, text: message.text };
    }));
  }, [sendMessages, setProjectMode, sim.members]);

  const runAnalysis = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const flush = await api.flushMock(conversationId);
      const [conversation, graph, suggestions] = await Promise.all([
        api.getConversation(conversationId),
        api.getBrainGraph(),
        api.getBrainSuggestions("pending"),
      ]);
      let newest = conversation.records[0];
      if (newest === undefined) {
        // The conversation detail endpoint hides mock/simulator traffic; fall back to the raw audit feed.
        const audit = await api.getAudit(200);
        newest = audit.records.find((record) => record.conversationId === conversationId);
      }
      setInsights({ nodes: graph.nodes, edges: graph.edges, suggestions: suggestions.suggestions });
      setSelectedStageId(null);
      if (newest !== undefined) {
        sim.ingestRecords([newest]);
      }
      setPendingCount(0);
      setActiveTab("stage");
      setNotice(flush.flushedMessageCount === 0
        ? { kind: "success", text: "Nothing buffered to analyze yet. Send a message first." }
        : { kind: "success", text: `Analyzed ${flush.flushedMessageCount} buffered message${flush.flushedMessageCount === 1 ? "" : "s"} in one pass.` });
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, sim]);

  const sendNote = useCallback(async (): Promise<void> => {
    const trimmed = noteText.trim();
    if (trimmed.length === 0) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.sendNote({ conversationId, text: trimmed });
      const [conversation, graph, suggestions] = await Promise.all([
        api.getConversation(conversationId),
        api.getBrainGraph(),
        api.getBrainSuggestions("pending"),
      ]);
      let newest = conversation.records[0];
      if (newest === undefined) {
        // The conversation detail endpoint hides mock/simulator traffic; fall back to the raw audit feed.
        const audit = await api.getAudit(200);
        newest = audit.records.find((record) => record.conversationId === conversationId);
      }
      setInsights({ nodes: graph.nodes, edges: graph.edges, suggestions: suggestions.suggestions });
      setSelectedStageId(null);
      if (newest !== undefined) {
        sim.ingestRecords([newest]);
      }
      setActiveTab("stage");
      setNoteText("");
      setNotice(hasAiKey === false
        ? {
            kind: "error",
            text: "Note sent, but AI is in dry-run mode so nothing changed. Set an Anthropic key in Setup to let notes update knowledge.",
          }
        : {
            kind: "success",
            text: "Note sent to Nocheh as an out-of-band instruction. Knowledge graph and suggestions refreshed.",
          });
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, noteText, sim, hasAiKey]);

  const react = useCallback(async (messageId: string, emoji: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    sim.addReaction(messageId, emoji);
    try {
      const reaction = await api.reactMock({
        conversationId,
        targetMessageId: messageId,
        emoji,
        reactorId: sim.activeMemberId,
        reactorDisplayName: sim.activeMemberName,
      });
      const [conversation, graph, suggestions] = await Promise.all([
        api.getConversation(conversationId),
        api.getBrainGraph(),
        api.getBrainSuggestions("pending"),
      ]);
      let newest = conversation.records[0];
      if (newest === undefined) {
        const audit = await api.getAudit(200);
        newest = audit.records.find((record) => record.conversationId === conversationId);
      }
      setInsights({ nodes: graph.nodes, edges: graph.edges, suggestions: suggestions.suggestions });
      setSelectedStageId(null);
      if (newest !== undefined) {
        sim.ingestRecords([newest]);
      }
      setActiveTab("stage");
      const count = reaction.result.statusUpdateCount;
      if (count > 0) {
        setNotice({
          kind: "success",
          text: `Reaction updated ${count} item${count === 1 ? "" : "s"} (e.g. task marked done).`,
        });
      } else if (hasAiKey === false) {
        setNotice({
          kind: "error",
          text: "Reaction sent, but AI is in dry-run mode so nothing changed. Set an Anthropic key in Setup to let reactions update tasks.",
        });
      } else {
        setNotice({
          kind: "success",
          text: "Reaction sent, but nothing changed. If this message hasn't been analyzed into a task yet, Run analysis first, then react.",
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, sim, hasAiKey]);

  const clear = useCallback((): void => {
    if (!confirm("Clear this local transcript? Nocheh's real brain (memory, knowledge graph, and suggestions in the backend) is NOT deleted — this only clears the on-screen conversation.")) {
      return;
    }
    setNotice(null);
    sim.clear();
    lastPlayedId.current = null;
    setSelectedStageId(null);
    setPendingCount(0);
    setInsights(EMPTY_INSIGHTS);
    setNotice({ kind: "success", text: "Local transcript cleared. Backend brain data was not changed." });
  }, [sim]);

  const DOCK_TABS: ReadonlyArray<{ readonly id: DockTab; readonly label: string; readonly icon: JSX.Element }> = [
    { id: "stage", label: "Stage detail", icon: <Workflow size={14} aria-hidden="true" /> },
    { id: "insights", label: "What Nocheh noticed", icon: <BrainCircuit size={14} aria-hidden="true" /> },
    { id: "knowledge", label: "Knowledge graph", icon: <GitBranch size={14} aria-hidden="true" /> },
  ];

  const tokenUsage = sim.lastAssistant?.record.aiTokenUsage;

  return (
    <section className="sim-page" aria-label="System flow simulator">
      <header className="sim-topbar">
        <div className="sim-topbar-title">
          <h2>Simulator</h2>
          <p>Post messages, buffer a conversation window, then run one real analysis pass through Nocheh.</p>
        </div>
        <div className="sim-groups" aria-label="Simulated groups">
          <span className="sim-groups-label">Groups</span>
          {groupState.groups.map((group) => (
            <span key={group.id} className={`sim-group-chip${group.id === conversationId ? " active" : ""}`}>
              <button
                type="button"
                className="sim-group-pick"
                aria-pressed={group.id === conversationId}
                onClick={() => switchGroup(group.id)}
              >
                {group.name}
              </button>
              {groupState.groups.length > 1 && (
                <button
                  type="button"
                  className="sim-group-remove"
                  title="Remove group"
                  aria-label={`Remove ${group.name}`}
                  onClick={() => removeGroup(group.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
          <span className="sim-group-add">
            <input
              value={newGroupName}
              placeholder="New group"
              aria-label="New group name"
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitNewGroup();
                }
              }}
            />
            <button type="button" className="sim-group-add-btn" aria-label="Add group" title="Add group" onClick={commitNewGroup}>
              <Plus size={14} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="sim-project-mode" role="radiogroup" aria-label="Project mode">
          <span>Projects</span>
          <div className="seg">
            <button
              type="button"
              role="radio"
              aria-checked={projectHint === "single"}
              className={projectHint === "single" ? "is-active" : ""}
              disabled={busy}
              title="Treat the whole group as one project"
              onClick={() => void setProjectMode("single")}
            >
              Single
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={projectHint === "multi"}
              className={projectHint === "multi" ? "is-active" : ""}
              disabled={busy}
              title="Org group hosting several projects"
              onClick={() => void setProjectMode("multi")}
            >
              Multi
            </button>
          </div>
        </div>
        <div className="sim-mode-pill" aria-label="AI status">
          <span>AI</span>
          <b className={hasAiKey === false ? "warn" : "ok"}>
            {hasAiKey === null ? "checking" : hasAiKey ? "live" : "dry-run"}
          </b>
        </div>
        <div className="sim-samples" aria-label="Sample threads">
          <span><Play size={13} aria-hidden="true" /></span>
          {SCENARIOS.map((scenario) => (
            <button key={scenario.label} disabled={busy} onClick={() => runScenario(scenario)}>
              {scenario.label}
            </button>
          ))}
        </div>
        <button className="action" disabled={busy} onClick={() => void runAnalysis()}>
          <Sparkles size={14} aria-hidden="true" />
          Run analysis{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </button>
        <button className="action" disabled={busy} onClick={() => clear()}><Trash2 size={14} aria-hidden="true" />Clear</button>
      </header>

      {hasAiKey === false && (
        <div className="notice" role="status">
          <AlertTriangle className="notice-icon" size={16} aria-hidden="true" />
          <span>
            AI is disabled (dry-run). Analysis runs, but the backend produces an empty result — no memory, graph, or
            suggestions will appear until an Anthropic key is set in Setup. Emoji reactions also need an Anthropic key to
            change anything (the reaction is sent, but no task or knowledge will update).
          </span>
        </div>
      )}

      <Notice message={notice} />

      <div className="sim-body">
        <section className="sim-panel sim-chat-panel" aria-label="Mock Telegram chat">
          <div className="sim-panel-header">
            <span><MessageCircle size={15} aria-hidden="true" /> Telegram chat</span>
            <b>pending (buffered): {pendingCount}</b>
          </div>
          <p className="muted sim-hint">
            Try the reaction flow: post a message asking someone to do something, click <b>Run analysis</b> to turn it into a
            task, then react with ✅ on that same message — Nocheh reads the reaction and marks the task done.
          </p>
          <GroupChat
            entries={sim.entries}
            members={sim.members}
            activeMemberId={sim.activeMemberId}
            busy={busy}
            onSetActiveMember={sim.setActiveMember}
            onAddMember={sim.addMember}
            onRemoveMember={sim.removeMember}
            onSend={(text) => send(text)}
            onReact={(messageId, emoji) => void react(messageId, emoji)}
          />
          <div className="sim-note" aria-label="Send a note to Nocheh">
            <label htmlFor="sim-note-input"><NotebookPen size={14} aria-hidden="true" /> Send a note to Nocheh</label>
            <p className="muted sim-hint">
              A note is an out-of-band instruction from you — not group chatter. It bypasses buffering and runs immediately,
              turning your words into knowledge (new nodes, links, memories, tasks) and it can correct or close open tasks.
            </p>
            <div className="composer-row">
              <textarea
                id="sim-note-input"
                aria-label="Note to Nocheh"
                value={noteText}
                placeholder="e.g. Close the release-notes task — it's done. (Cmd/Ctrl+Enter to send)"
                onChange={(event) => setNoteText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    void sendNote();
                  }
                }}
              />
              <button className="action" disabled={busy || noteText.trim().length === 0} onClick={() => void sendNote()}>
                <NotebookPen size={15} aria-hidden="true" />
                Send note
              </button>
            </div>
          </div>
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
            />
          )}
          {activeTab === "insights" && (
            <BrainConsole
              suggestions={insights.suggestions}
              hasRecord={sim.lastAssistant !== undefined}
              warningCount={analysisWarningCount(sim.lastAssistant?.record.steps)}
              tokenUsage={tokenUsage}
            />
          )}
          {activeTab === "knowledge" && <KnowledgeTab nodes={insights.nodes} edges={insights.edges} />}
        </div>
      </section>
    </section>
  );
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

function BrainConsole({
  suggestions,
  hasRecord,
  warningCount,
  tokenUsage,
}: {
  readonly suggestions: readonly BrainSuggestion[];
  readonly hasRecord: boolean;
  readonly warningCount: number;
  readonly tokenUsage: { readonly provider: string; readonly model: string; readonly totalTokens: number } | undefined;
}): JSX.Element {
  const highRisk = suggestions.filter((suggestion) => suggestion.riskLevel === "high").length;

  return (
    <div className="plain-brain" aria-label="What Nocheh noticed">
      <div className="plain-stat-row" aria-label="Analysis summary">
        <PlainStat label="Suggestions" value={suggestions.length} />
        <PlainStat label="High risk" value={highRisk} />
        <PlainStat label="Warnings" value={warningCount} />
        <PlainStat label="Tokens" value={tokenUsage?.totalTokens ?? 0} />
      </div>

      {tokenUsage !== undefined && (
        <p className="muted sim-token-usage">
          {tokenUsage.totalTokens.toLocaleString()} tokens · {tokenUsage.provider}/{tokenUsage.model}
        </p>
      )}

      <div className="plain-list" aria-label="Pending suggestions">
        {suggestions.length === 0 ? (
          <p className="plain-empty">
            {hasRecord
              ? "No pending suggestions from this analysis."
              : "No suggestions yet. Send a message and run analysis to see what Nocheh proposes."}
          </p>
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

      {warningCount > 0 && (
        <article className="plain-item tone-warn" aria-label="Analysis warnings">
          <div>
            <b><Lightbulb size={14} aria-hidden="true" /> {warningCount} analysis warning{warningCount === 1 ? "" : "s"}</b>
            <p>The analyzer flagged items that need review before they are trusted as facts.</p>
          </div>
          <span>review</span>
        </article>
      )}
    </div>
  );
}

function KnowledgeTab({
  nodes,
  edges,
}: {
  readonly nodes: readonly BrainGraphNode[];
  readonly edges: readonly BrainGraphEdge[];
}): JSX.Element {
  const graph = useMemo(() => toKnowledgeGraph(nodes, edges), [nodes, edges]);
  return (
    <KnowledgeGraph
      nodes={graph.nodes}
      edges={graph.edges}
      emptyMessage="No knowledge graph yet. Send a message and run analysis (an Anthropic key is required for real results)."
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

function analysisWarningCount(steps: readonly { readonly name: string; readonly metadata: Record<string, string | number | boolean | null> }[] | undefined): number {
  const analysis = steps?.find((step) => step.name === "analysis");
  const value = analysis?.metadata["warningCount"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "member";
}
