import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, type AiProviderOption, type SetupStatus } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = (): void => {
    api.getSetupStatus()
      .then((next) => {
        setStatus(next);
        // aiProvider is "none" when unset, so only preselect ids the backend actually offers.
        const active = next.providers?.find((candidate) => candidate.id === next.aiProvider)?.id;
        setProviderId((current) => current.length > 0 ? current : active ?? next.providers?.[0]?.id ?? "");
      })
      .catch((error: Error) => setMessage({ kind: "error", text: error.message }));
  };

  useEffect(refresh, []);

  const providers = status?.providers ?? [];
  const provider = providers.find((candidate) => candidate.id === providerId);
  const modelMissing = provider !== undefined && provider.modelRequired && model.trim().length === 0;
  const canSave = provider !== undefined && apiKey.trim().length > 0 && !modelMissing;

  const saveProvider = async (): Promise<void> => {
    if (provider === undefined) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const trimmedModel = model.trim();
      await api.putEnv({
        AI_PROVIDER: provider.id,
        [provider.apiKeyEnvKey]: apiKey.trim(),
        // Empty model means "use the provider default", so only send a real value.
        ...(trimmedModel.length === 0 ? {} : { [provider.modelEnvKey]: trimmedModel }),
      });
      setApiKey("");
      setModel("");
      setMessage({
        kind: "success",
        text: `${provider.label} saved to .env (model: ${trimmedModel.length === 0 ? provider.defaultModel ?? "provider default" : trimmedModel}). Restart the server for it to take effect.`,
      });
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
            <p className="status-line">Model: <b>{status.aiModel ?? "—"}</b></p>
            <p className="status-line">Provider ready: <StatusFlag active={status.hasAiKey} /></p>
            <p className="status-line">Bot token: <StatusFlag active={status.hasBotToken} /></p>
            <p className="status-line">Bot connected: <StatusFlag active={status.botConnected} /></p>
            <p className="status-line">Encryption secret: <StatusFlag active={status.encryptionConfigured} /></p>
            {status.webhookUrl !== undefined && <p className="status-line muted">Webhook: {status.webhookUrl}</p>}
          </>
        )}
      </Card>

      <Card title="AI provider">
        <p className="muted">
          Leave this empty to keep running in dry-run mode: messages are still redacted, buffered, and audited, but no
          analysis is produced and nothing is sent to a provider.
        </p>
        <label htmlFor="ai-provider">AI_PROVIDER</label>
        <select
          id="ai-provider"
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
            setApiKey("");
            setModel("");
          }}
        >
          {providers.length === 0 && <option value="">Loading…</option>}
          {providers.map((candidate: AiProviderOption) => (
            <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
          ))}
        </select>
        {provider !== undefined && (
          <>
            <p className="muted">{provider.notes}</p>
            <label htmlFor="provider-api-key">{provider.apiKeyEnvKey}</label>
            <input
              id="provider-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={provider.id === "nvidia" ? "nvapi-..." : "sk-ant-..."}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <label htmlFor="provider-model">
              {provider.modelEnvKey}{provider.modelRequired ? "" : " (optional)"}
            </label>
            <input
              id="provider-model"
              value={model}
              placeholder={provider.defaultModel ?? "Model id"}
              onChange={(event) => setModel(event.target.value)}
            />
            {!provider.modelRequired && provider.defaultModel !== undefined && (
              <p className="muted">Leave empty to use {provider.defaultModel}.</p>
            )}
          </>
        )}
        <button className="action" disabled={saving || !canSave} onClick={() => void saveProvider()}>
          <Save size={15} aria-hidden="true" />
          {saving ? "Saving…" : "Save provider"}
        </button>
        <Notice message={message} />
      </Card>
    </div>
  );
}
