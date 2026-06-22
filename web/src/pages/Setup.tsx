import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, type SetupStatus } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
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
      await api.putEnv({
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_MODEL: model,
      });
      setApiKey("");
      setModel("");
      setMessage({ kind: "success", text: "Anthropic provider config saved to .env. Restart the server for it to take effect." });
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
            <p className="status-line">AI provider: <b>{status.aiProvider ?? "none"}</b></p>
            <p className="status-line">Provider ready: <StatusFlag active={status.hasAiKey} /></p>
            <p className="status-line">Bot token: <StatusFlag active={status.hasBotToken} /></p>
            <p className="status-line">Bot connected: <StatusFlag active={status.botConnected} /></p>
            <p className="status-line">Encryption secret: <StatusFlag active={status.encryptionConfigured} /></p>
            {status.webhookUrl !== undefined && <p className="status-line muted">Webhook: {status.webhookUrl}</p>}
          </>
        )}
      </Card>

      <Card title="Optional provider config">
        <p className="muted">Leave this empty while model research is in progress. Rule-based analysis remains active. First paid-provider target is Claude Sonnet through Anthropic.</p>
        <label htmlFor="anthropic-api-key">ANTHROPIC_API_KEY</label>
        <input
          id="anthropic-api-key"
          value={apiKey}
          placeholder="sk-ant-..."
          onChange={(event) => setApiKey(event.target.value)}
        />
        <label htmlFor="anthropic-model">ANTHROPIC_MODEL</label>
        <input
          id="anthropic-model"
          value={model}
          placeholder="Claude Sonnet model id after selection"
          onChange={(event) => setModel(event.target.value)}
        />
        <button className="action" disabled={saving || apiKey.length === 0 || model.length === 0} onClick={() => void saveKey()}>
          <Save size={15} aria-hidden="true" />
          {saving ? "Saving…" : "Save key"}
        </button>
        <Notice message={message} />
      </Card>
    </div>
  );
}
