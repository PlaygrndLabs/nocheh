import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrainCircuit, Check, CheckCircle2, Database, Gauge, GitBranch, Lightbulb, ListChecks, Lock, Pencil, Play, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { api, type AuditRecord, type GroupSettings } from "../api/client.js";
import { GroupChat } from "../components/GroupChat.js";
import { SystemGraph } from "../components/SystemGraph.js";
import { Card, Notice, PageHeader, type NoticeMessage } from "../components/ui.js";
import { buildBrainPreview, type BrainPreview, type PreviewAuditEvent, type PreviewGuardrail, type PreviewMemory, type PreviewSuggestion } from "../sim/brain-preview.js";
import { buildTimeline } from "../sim/pipeline.js";
import { usePlayback } from "../sim/usePlayback.js";
import { useSimulation } from "../state/useSimulation.js";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_TRIES = 6;

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

export function Mock(): JSX.Element {
  const [conversationId, setConversationId] = useState("mock-chat-1");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const [settings, setSettings] = useState<GroupSettings | null>(null);

  const sim = useSimulation(conversationId);
  const ingestRef = useRef(sim.ingestRecords);
  ingestRef.current = sim.ingestRecords;

  const frames = useMemo(
    () => (sim.lastAssistant === undefined ? [] : buildTimeline(sim.lastAssistant.record)),
    [sim.lastAssistant],
  );
  const brainPreview = useMemo(() => buildBrainPreview(sim.entries), [sim.entries]);
  const playback = usePlayback(frames);
  // Animate the graph whenever a new processed record becomes the latest.
  const playRef = useRef(playback.play);
  playRef.current = playback.play;
  const lastPlayedId = useRef<string | null>(null);
  useEffect(() => {
    if (sim.lastAssistant !== undefined && sim.lastAssistant.auditId !== lastPlayedId.current && frames.length > 0) {
      lastPlayedId.current = sim.lastAssistant.auditId;
      playRef.current();
    }
  }, [sim.lastAssistant, frames]);

  const loadSettings = useCallback((): void => {
    api.getSettings(conversationId).then((r) => setSettings(r.settings)).catch(() => setSettings(null));
  }, [conversationId]);

  useEffect(loadSettings, [loadSettings]);

  const pollForResults = useCallback(async (): Promise<number> => {
    for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt += 1) {
      await delay(POLL_INTERVAL_MS);
      let records: AuditRecord[];
      try {
        records = (await api.getConversation(conversationId)).records;
      } catch {
        continue;
      }
      const added = ingestRef.current(records);
      if (added > 0) {
        return added;
      }
    }
    return 0;
  }, [conversationId]);

  const send = useCallback(async (message: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    sim.addUserEntry(sim.activeMemberName, message);
    try {
      await api.injectMock([{ conversationId, text: message, senderDisplayName: sim.activeMemberName }]);
      const added = await pollForResults();
      if (added === 0) {
        setNotice({
          kind: "success",
          text: settings?.analysisMode === "batch"
            ? "Buffered (batch mode). Press Flush to process now, or switch to immediate."
            : "Sent. No brain-flow output appeared yet — try Flush.",
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, pollForResults, settings, sim]);

  const runScenario = useCallback(async (message: string): Promise<void> => {
    await send(message);
  }, [send]);

  const flush = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await api.flushMock(conversationId);
      await pollForResults();
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId, pollForResults]);

  const setImmediate = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.putSettings(conversationId, { analysisMode: "immediate" });
      setSettings(result.settings);
      setNotice({ kind: "success", text: "Analysis mode set to immediate — sends process instantly." });
    } catch (error) {
      setNotice({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  const clear = useCallback(async (): Promise<void> => {
    if (!confirm("Clear this simulation? The transcript is removed and any buffered messages are flushed.")) {
      return;
    }
    setBusy(true);
    setNotice(null);
    sim.clear();
    lastPlayedId.current = null;
    try {
      await api.flushMock(conversationId);
    } catch {
      // Flushing a fresh conversation may be a no-op; ignore.
    } finally {
      setBusy(false);
      setNotice({ kind: "success", text: "Simulation cleared." });
    }
  }, [conversationId, sim]);

  return (
    <div>
      <PageHeader
        title="Simulator"
        subtitle="Preview the full Nocheh Brain loop before real deployment: intake, memory, graph links, suggestions, approval, safety, and cost."
      />

      <Card>
        <div className="control-grid">
          <div>
            <label htmlFor="conv">Group (conversation ID)</label>
            <input id="conv" value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
          </div>
          <div className="action-row">
            <button className="action" disabled={busy} onClick={() => void flush()}><RefreshCw size={15} aria-hidden="true" />Flush buffer</button>
            <button className="action" disabled={busy} onClick={() => void clear()}><Trash2 size={15} aria-hidden="true" />Clear simulation</button>
            {settings !== null && (
              <span className="status-line muted">
                mode: <b className={settings.analysisMode === "immediate" ? "ok" : "warn"}>{settings.analysisMode}</b>
                {settings.analysisMode === "batch" && (
                  <>{" · "}<button className="linklike" onClick={() => void setImmediate()}>set immediate</button></>
                )}
              </span>
            )}
          </div>
        </div>
        <Notice message={notice} />
      </Card>

      <Card title="Run a complete scenario" icon={<Play size={16} aria-hidden="true" />}>
        <div className="scenario-grid">
          {SCENARIOS.map((scenario) => (
            <button key={scenario.label} className="scenario-button" disabled={busy} onClick={() => void runScenario(scenario.text)}>
              <b>{scenario.label}</b>
              <span>{scenario.text}</span>
            </button>
          ))}
        </div>
      </Card>

      <BrainConsole preview={brainPreview} />

      <div className="sim-split">
        <Card title="Brain flow · live trace">
          <SystemGraph frames={frames} activeIndex={playback.activeIndex} />
        </Card>

        <Card title="Group conversation">
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
        </Card>
      </div>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function BrainConsole({ preview }: { readonly preview: BrainPreview }): JSX.Element {
  return (
    <section className="brain-console" aria-label="Nocheh brain simulator">
      <div className="brain-metrics">
        <Metric icon={<BrainCircuit size={15} aria-hidden="true" />} label="Messages" value={preview.metrics.messages} />
        <Metric icon={<Database size={15} aria-hidden="true" />} label="Memories" value={preview.metrics.memories} />
        <Metric icon={<GitBranch size={15} aria-hidden="true" />} label="Graph edges" value={preview.metrics.edges} />
        <Metric icon={<Lightbulb size={15} aria-hidden="true" />} label="Suggestions" value={preview.metrics.suggestions} />
        <Metric icon={<Lock size={15} aria-hidden="true" />} label="Blocked" value={preview.metrics.blocked} />
        <Metric icon={<Gauge size={15} aria-hidden="true" />} label="Est. tokens" value={preview.metrics.estimatedTokens} />
      </div>

      <div className="brain-stage-strip">
        {preview.stages.map((stage, index) => (
          <div key={stage.label} className={`brain-stage ${stage.status}`}>
            <span className="stage-index">{index + 1}</span>
            <b>{stage.label}</b>
            <span>{stage.detail}</span>
          </div>
        ))}
      </div>

      <div className="brain-grid">
        <section className="brain-panel memory-panel">
          <PanelTitle icon={<Database size={15} aria-hidden="true" />} title="Structured memory" />
          <div className="memory-list">
            {preview.memories.map((memory) => <MemoryRow key={`${memory.type}-${memory.title}`} memory={memory} />)}
          </div>
        </section>

        <section className="brain-panel graph-panel">
          <PanelTitle icon={<GitBranch size={15} aria-hidden="true" />} title="Memory graph inspector" />
          <div className="node-list">
            {preview.nodes.map((node) => (
              <div key={node.id} className="node-row">
                <code>{node.id}</code>
                <span>{node.kind}</span>
                <b>{node.label}</b>
                <em>{Math.round(node.confidence * 100)}%</em>
              </div>
            ))}
          </div>
          <div className="edge-list">
            {preview.edges.map((edge) => (
              <div key={`${edge.from}-${edge.relation}-${edge.to}`} className="edge-row">
                <span>{edge.from}</span>
                <code>{edge.relation}</code>
                <span>{edge.to}</span>
                <b>{Math.round(edge.confidence * 100)}%</b>
              </div>
            ))}
          </div>
        </section>

        <section className="brain-panel suggestion-panel">
          <PanelTitle icon={<Lightbulb size={15} aria-hidden="true" />} title="Pending suggestions approval" />
          <div className="suggestion-list">
            {preview.suggestions.map((suggestion) => <SuggestionRow key={`${suggestion.kind}-${suggestion.title}`} suggestion={suggestion} />)}
          </div>
        </section>

        <section className="brain-panel guardrail-panel">
          <PanelTitle icon={<ShieldCheck size={15} aria-hidden="true" />} title="Safety and cost guardrails" />
          <div className="guardrail-list">
            {preview.guardrails.map((guardrail) => <GuardrailRow key={guardrail.label} guardrail={guardrail} />)}
          </div>
        </section>

        <section className="brain-panel audit-panel">
          <PanelTitle icon={<ListChecks size={15} aria-hidden="true" />} title="Graph and suggestion audit" />
          <div className="audit-list">
            {preview.auditEvents.map((event) => <AuditRow key={`${event.label}-${event.status}`} event={event} />)}
          </div>
        </section>
      </div>
    </section>
  );
}

function Metric({ icon, label, value }: { readonly icon: JSX.Element; readonly label: string; readonly value: number }): JSX.Element {
  return (
    <div className="brain-metric">
      <span>{icon}{label}</span>
      <b>{value.toLocaleString()}</b>
    </div>
  );
}

function PanelTitle({ icon, title }: { readonly icon: JSX.Element; readonly title: string }): JSX.Element {
  return (
    <div className="panel-title">
      {icon}
      <b>{title}</b>
    </div>
  );
}

function MemoryRow({ memory }: { readonly memory: PreviewMemory }): JSX.Element {
  return (
    <article className="memory-row">
      <div>
        <span className="memory-type">{memory.type}</span>
        <b>{memory.title}</b>
        <p>{memory.detail}</p>
      </div>
      <span className={`mini-status ${memory.status}`}>{memory.status}</span>
    </article>
  );
}

function SuggestionRow({ suggestion }: { readonly suggestion: PreviewSuggestion }): JSX.Element {
  return (
    <article className={`suggestion-row ${suggestion.status}`}>
      <div>
        <span className="memory-type">{suggestion.kind}</span>
        <b>{suggestion.title}</b>
        <p>{suggestion.rationale}</p>
      </div>
      <div className="suggestion-meta">
        <span>{Math.round(suggestion.confidence * 100)}%</span>
        <span>{suggestion.sourceLabel}</span>
        <span>impact {suggestion.impact}</span>
        <span>risk {suggestion.risk}</span>
      </div>
      <div className="approval-actions" aria-label={`Approval controls for ${suggestion.title}`}>
        <button type="button" title="Approve suggestion" disabled={suggestion.status === "blocked"}>
          <Check size={13} aria-hidden="true" />
        </button>
        <button type="button" title="Edit suggestion">
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button type="button" title="Reject suggestion">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function GuardrailRow({ guardrail }: { readonly guardrail: PreviewGuardrail }): JSX.Element {
  const Icon = guardrail.status === "ok" ? CheckCircle2 : guardrail.status === "blocked" ? Lock : ShieldCheck;
  return (
    <article className={`guardrail-row guardrail-${guardrail.status}`}>
      <Icon size={14} aria-hidden="true" />
      <div>
        <b>{guardrail.label}</b>
        <p>{guardrail.detail}</p>
      </div>
    </article>
  );
}

function AuditRow({ event }: { readonly event: PreviewAuditEvent }): JSX.Element {
  return (
    <article className={`audit-row audit-${event.status}`}>
      <span>{event.status}</span>
      <div>
        <b>{event.label}</b>
        <p>{event.detail}</p>
      </div>
    </article>
  );
}
