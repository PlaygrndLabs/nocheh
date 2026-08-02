import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, type AiRoleStatus, type SetupStatus } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

/**
 * Credentials belong to a provider and models belong to a role, so they are edited
 * separately: one key per provider, reused by every role that provider fills.
 */
interface RoleDraft {
  providerId: string;
  model: string;
}

const EMPTY_DRAFT: RoleDraft = { providerId: "", model: "" };

export function Setup(): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RoleDraft>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = (): void => {
    api.getSetupStatus()
      .then((next) => {
        setStatus(next);
        setRoleDrafts((current) => {
          const merged = { ...current };
          for (const role of next.roles ?? []) {
            // `provider` is "none" when unset, so only preselect ids the role actually offers.
            const active = role.providers.find((candidate) => candidate.id === role.provider)?.id;
            const existing = merged[role.id];
            if (existing === undefined || existing.providerId.length === 0) {
              merged[role.id] = {
                ...EMPTY_DRAFT,
                ...existing,
                providerId: active ?? role.providers[0]?.id ?? "",
              };
            }
          }
          return merged;
        });
      })
      .catch((error: Error) => setMessage({ kind: "error", text: error.message }));
  };

  useEffect(refresh, []);

  const roles = status?.roles ?? [];
  const providers = status?.providers ?? [];

  const saveCredential = async (providerId: string, apiKeyEnvKey: string, label: string): Promise<void> => {
    const value = (keyDrafts[providerId] ?? "").trim();
    if (value.length === 0) {
      return;
    }
    setSaving(`key:${providerId}`);
    setMessage(null);
    try {
      await api.putEnv({ [apiKeyEnvKey]: value });
      setKeyDrafts((current) => ({ ...current, [providerId]: "" }));
      setMessage({
        kind: "success",
        text: `${label} credential saved to .env. Restart the server for it to take effect.`,
      });
      refresh();
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setSaving(null);
    }
  };

  const saveRole = async (role: AiRoleStatus): Promise<void> => {
    const draft = roleDrafts[role.id] ?? EMPTY_DRAFT;
    const provider = role.providers.find((candidate) => candidate.id === draft.providerId);
    if (provider === undefined) {
      return;
    }
    setSaving(`role:${role.id}`);
    setMessage(null);
    try {
      const trimmedModel = draft.model.trim();
      await api.putEnv({
        [role.providerEnvKey]: provider.id,
        // Empty model means "use the provider default", so only send a real value.
        ...(trimmedModel.length === 0 ? {} : { [provider.modelEnvKey]: trimmedModel }),
      });
      setRoleDrafts((current) => ({ ...current, [role.id]: { ...draft, model: "" } }));
      const effectiveModel = trimmedModel.length === 0
        ? provider.defaultModel ?? "provider default"
        : trimmedModel;
      setMessage({
        kind: "success",
        text: `${role.label}: ${provider.label} saved to .env (model: ${effectiveModel}). Restart the server for it to take effect.`,
      });
      refresh();
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setSaving(null);
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
            {roles.map((role) => (
              <p className="status-line" key={role.id}>
                {role.label}: <b>{role.provider}</b>
                {role.model !== undefined && <> · <b>{role.model}</b></>}
                {" "}<StatusFlag active={role.ready} />
                {!role.supported && role.provider !== "none" && (
                  <span className="muted"> — selected provider cannot fill this role</span>
                )}
              </p>
            ))}
            <p className="status-line">Bot token: <StatusFlag active={status.hasBotToken} /></p>
            <p className="status-line">Bot connected: <StatusFlag active={status.botConnected} /></p>
            <p className="status-line">Encryption secret: <StatusFlag active={status.encryptionConfigured} /></p>
            {status.webhookUrl !== undefined && <p className="status-line muted">Webhook: {status.webhookUrl}</p>}
          </>
        )}
      </Card>

      <Card title="Provider credentials">
        <p className="muted">
          One key per provider, shared by every role that provider fills. Keys are write-only: the dashboard shows
          whether one is present, never its value.
        </p>
        {providers.map((provider) => (
          <div key={provider.id}>
            <label htmlFor={`provider-key-${provider.id}`}>
              {provider.apiKeyEnvKey}{provider.hasApiKey ? " (set — enter a new value to replace)" : ""}
            </label>
            <input
              id={`provider-key-${provider.id}`}
              type="password"
              value={keyDrafts[provider.id] ?? ""}
              autoComplete="off"
              placeholder={provider.hasApiKey ? "unchanged" : "API key"}
              onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
            />
            <p className="muted">{provider.notes}</p>
            <button
              className="action"
              disabled={saving !== null || (keyDrafts[provider.id] ?? "").trim().length === 0}
              onClick={() => void saveCredential(provider.id, provider.apiKeyEnvKey, provider.label)}
            >
              <Save size={15} aria-hidden="true" />
              {saving === `key:${provider.id}` ? "Saving…" : `Save ${provider.label} key`}
            </button>
          </div>
        ))}
      </Card>

      {roles.map((role) => {
        const draft = roleDrafts[role.id] ?? EMPTY_DRAFT;
        const provider = role.providers.find((candidate) => candidate.id === draft.providerId);
        const modelMissing = provider !== undefined
          && provider.modelRequired
          && draft.model.trim().length === 0
          && !role.ready;
        const credential = providers.find((candidate) => candidate.id === provider?.id);
        const canSave = provider !== undefined && !modelMissing;

        return (
          <Card title={role.label} key={role.id}>
            <p className="muted">{role.purpose}</p>
            <p className="muted">Leave unconfigured to skip this role. {role.whenUnset}</p>

            <label htmlFor={`role-provider-${role.id}`}>{role.providerEnvKey}</label>
            <select
              id={`role-provider-${role.id}`}
              value={draft.providerId}
              onChange={(event) => setRoleDrafts((current) => ({
                ...current,
                [role.id]: { providerId: event.target.value, model: "" },
              }))}
            >
              {role.providers.length === 0 && <option value="">No provider supports this role</option>}
              {role.providers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
            </select>

            {provider !== undefined && (
              <>
                <p className="muted">{provider.notes}</p>
                <label htmlFor={`role-model-${role.id}`}>
                  {provider.modelEnvKey}{provider.modelRequired ? "" : " (optional)"}
                </label>
                <input
                  id={`role-model-${role.id}`}
                  value={draft.model}
                  placeholder={provider.defaultModel ?? "Model id"}
                  onChange={(event) => setRoleDrafts((current) => ({
                    ...current,
                    [role.id]: { ...draft, model: event.target.value },
                  }))}
                />
                {!provider.modelRequired && provider.defaultModel !== undefined && (
                  <p className="muted">Leave empty to use {provider.defaultModel}.</p>
                )}
                {credential?.hasApiKey === false && (
                  <p className="muted">
                    {provider.apiKeyEnvKey} is not set yet. Add it under Provider credentials or this role stays off.
                  </p>
                )}
              </>
            )}

            <button
              className="action"
              disabled={saving !== null || !canSave}
              onClick={() => void saveRole(role)}
            >
              <Save size={15} aria-hidden="true" />
              {saving === `role:${role.id}` ? "Saving…" : `Save ${role.label.toLowerCase()}`}
            </button>
          </Card>
        );
      })}

      <Notice message={message} />
    </div>
  );
}
