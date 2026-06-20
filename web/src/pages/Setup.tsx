import { useEffect, useState } from "react";
import { api, type SetupStatus } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = (): void => {
    api.getSetupStatus().then(setStatus).catch((error: Error) => setMessage({ kind: "error", text: error.message }));
  };

  useEffect(refresh, []);

  const saveKey = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      await api.putEnv({ AI_API_KEY: aiKey });
      setAiKey("");
      setMessage({ kind: "success", text: "AI API key saved to .env. Restart the server for it to take effect." });
      refresh();
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Setup"
        subtitle="Bootstrap the assistant. Secrets are written to a gitignored .env and never read back."
      />

      <Card title="Configuration status">
        {status === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="status-line">AI key: <StatusFlag active={status.hasAiKey} /></p>
            <p className="status-line">Bot token: <StatusFlag active={status.hasBotToken} /></p>
            <p className="status-line">Bot connected: <StatusFlag active={status.botConnected} /></p>
            <p className="status-line">Encryption secret: <StatusFlag active={status.encryptionConfigured} /></p>
            {status.webhookUrl !== undefined && <p className="status-line muted">Webhook: {status.webhookUrl}</p>}
          </>
        )}
      </Card>

      <Card title="AI API key">
        <label htmlFor="ai-key">AI_API_KEY</label>
        <input
          id="ai-key"
          type="password"
          value={aiKey}
          placeholder="sk-…"
          onChange={(event) => setAiKey(event.target.value)}
        />
        <button className="action" disabled={saving || aiKey.length === 0} onClick={() => void saveKey()}>
          {saving ? "Saving…" : "Save key"}
        </button>
        <Notice message={message} />
      </Card>
    </div>
  );
}
