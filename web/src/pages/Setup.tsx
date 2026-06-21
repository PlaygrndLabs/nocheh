import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, type SetupStatus } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [modelId, setModelId] = useState("");
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
        AI_PROVIDER: "bedrock",
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        AWS_BEDROCK_MODEL_ID: modelId,
      });
      setAccessKeyId("");
      setSecretAccessKey("");
      setModelId("");
      setMessage({ kind: "success", text: "Bedrock provider config saved to .env. Restart the server for it to take effect." });
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
        <p className="muted">Leave this empty while model research is in progress. Rule-based analysis remains active.</p>
        <label htmlFor="aws-access-key">AWS_ACCESS_KEY_ID</label>
        <input
          id="aws-access-key"
          value={accessKeyId}
          placeholder="AKIA..."
          onChange={(event) => setAccessKeyId(event.target.value)}
        />
        <label htmlFor="aws-secret-key">AWS_SECRET_ACCESS_KEY</label>
        <input
          id="aws-secret-key"
          type="password"
          value={secretAccessKey}
          placeholder="AWS secret access key"
          onChange={(event) => setSecretAccessKey(event.target.value)}
        />
        <label htmlFor="bedrock-model">AWS_BEDROCK_MODEL_ID</label>
        <input
          id="bedrock-model"
          value={modelId}
          placeholder="Set only after model selection research"
          onChange={(event) => setModelId(event.target.value)}
        />
        <button className="action" disabled={saving || accessKeyId.length === 0 || secretAccessKey.length === 0 || modelId.length === 0} onClick={() => void saveKey()}>
          <Save size={15} aria-hidden="true" />
          {saving ? "Saving…" : "Save key"}
        </button>
        <Notice message={message} />
      </Card>
    </div>
  );
}
