import { useState } from "react";
import { Download, Save } from "lucide-react";
import { api, type GroupSettings } from "../api/client.js";
import { Card, Notice, NumericField, PageHeader, type NoticeMessage } from "../components/ui.js";

export function Settings(): JSX.Element {
  const [conversationId, setConversationId] = useState("mock-chat-1");
  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setMessage(null);
    try {
      const result = await api.getSettings(conversationId);
      setSettings(result.settings);
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    }
  };

  const save = async (): Promise<void> => {
    if (settings === null) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.putSettings(conversationId, settings);
      setSettings(result.settings);
      setMessage({ kind: "success", text: "Settings saved." });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const patch = (changes: Partial<GroupSettings>): void => {
    setSettings((current) => (current === null ? current : { ...current, ...changes }));
  };

  return (
    <div>
      <PageHeader title="Group settings" subtitle="Per-conversation analysis and reply behavior." />

      <Card>
        <label htmlFor="conv">Conversation ID</label>
        <input id="conv" value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
        <button className="action" onClick={() => void load()}><Download size={15} aria-hidden="true" />Load</button>
      </Card>

      {settings !== null && (
        <Card>
          <label>Analysis mode</label>
          <select value={settings.analysisMode} onChange={(e) => patch({ analysisMode: e.target.value as GroupSettings["analysisMode"] })}>
            <option value="batch">batch</option>
            <option value="immediate">immediate</option>
          </select>

          <label>Reply mode</label>
          <select value={settings.replyMode} onChange={(e) => patch({ replyMode: e.target.value as GroupSettings["replyMode"] })}>
            <option value="silent">silent</option>
            <option value="mention">mention</option>
            <option value="active">active</option>
            <option value="digest">digest</option>
          </select>

          <NumericField label="Analysis interval (s)" value={settings.analysisIntervalSeconds} onChange={(v) => patch({ analysisIntervalSeconds: v })} />
          <NumericField label="Max messages per batch" value={settings.maxMessagesPerBatch} onChange={(v) => patch({ maxMessagesPerBatch: v })} />
          <NumericField label="Max AI context tokens" value={settings.maxAiContextTokens} onChange={(v) => patch({ maxAiContextTokens: v })} />
          <NumericField label="Max retrieved memories" value={settings.maxRetrievedMemories} onChange={(v) => patch({ maxRetrievedMemories: v })} />
          <NumericField label="Max recent messages" value={settings.maxRecentMessages} onChange={(v) => patch({ maxRecentMessages: v })} />

          <button className="action" disabled={busy} onClick={() => void save()}><Save size={15} aria-hidden="true" />{busy ? "Saving…" : "Save settings"}</button>
        </Card>
      )}

      <Notice message={message} />
    </div>
  );
}
