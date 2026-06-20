import { useState } from "react";
import { api, type GroupSettings } from "../api/client.js";

export function Settings(): JSX.Element {
  const [conversationId, setConversationId] = useState("mock-chat-1");
  const [settings, setSettings] = useState<GroupSettings | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
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
      <h2>Group settings</h2>
      <p className="subtitle">Per-conversation analysis and reply behavior.</p>

      <div className="card">
        <label htmlFor="conv">Conversation ID</label>
        <input id="conv" value={conversationId} onChange={(e) => setConversationId(e.target.value)} />
        <button className="action" onClick={() => void load()}>Load</button>
      </div>

      {settings !== null && (
        <div className="card">
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

          {numericField("Analysis interval (s)", settings.analysisIntervalSeconds, (v) => patch({ analysisIntervalSeconds: v }))}
          {numericField("Max messages per batch", settings.maxMessagesPerBatch, (v) => patch({ maxMessagesPerBatch: v }))}
          {numericField("Max AI context tokens", settings.maxAiContextTokens, (v) => patch({ maxAiContextTokens: v }))}
          {numericField("Max retrieved memories", settings.maxRetrievedMemories, (v) => patch({ maxRetrievedMemories: v }))}
          {numericField("Max recent messages", settings.maxRecentMessages, (v) => patch({ maxRecentMessages: v }))}

          <button className="action" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button>
        </div>
      )}

      {message !== null && <div className={`notice ${message.kind}`}>{message.text}</div>}
    </div>
  );
}

function numericField(label: string, value: number, onChange: (value: number) => void): JSX.Element {
  return (
    <>
      <label>{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </>
  );
}
