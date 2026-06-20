import { useEffect, useState } from "react";
import { api, type SetupStatus } from "../api/client.js";

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
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
      <h2>Setup</h2>
      <p className="subtitle">Bootstrap the assistant. Secrets are written to a gitignored .env and never read back.</p>

      <div className="card">
        <h3>Configuration status</h3>
        {status === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="status-line">AI key: {flag(status.hasAiKey)}</p>
            <p className="status-line">Bot token: {flag(status.hasBotToken)}</p>
            <p className="status-line">Bot connected: {flag(status.botConnected)}</p>
            <p className="status-line">Encryption secret: {flag(status.encryptionConfigured)}</p>
            {status.webhookUrl !== undefined && <p className="status-line muted">Webhook: {status.webhookUrl}</p>}
          </>
        )}
      </div>

      <div className="card">
        <h3>AI API key</h3>
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
        {message !== null && <div className={`notice ${message.kind}`}>{message.text}</div>}
      </div>
    </div>
  );
}

function flag(value: boolean): JSX.Element {
  return <span className={value ? "ok" : "warn"}>{value ? "set" : "not set"}</span>;
}
