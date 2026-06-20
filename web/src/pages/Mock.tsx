import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { api, type AuditRecord, type GroupSettings } from "../api/client.js";
import { GroupChat } from "../components/GroupChat.js";
import { SystemGraph } from "../components/SystemGraph.js";
import { Card, Notice, PageHeader, type NoticeMessage } from "../components/ui.js";
import { buildTimeline } from "../sim/pipeline.js";
import { usePlayback } from "../sim/usePlayback.js";
import { useSimulation } from "../state/useSimulation.js";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_TRIES = 6;

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
        subtitle="A mock Telegram group. Send as any member; watch the message become structured memory, tasks, and a simulated suggestion."
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
