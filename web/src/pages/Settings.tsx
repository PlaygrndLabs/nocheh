import { useEffect, useState } from "react";
import { Download, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api, type CustomRedactionPattern, type GroupSettings, type RedactionPolicy } from "../api/client.js";
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

      <RedactionSettings />
    </div>
  );
}

function RedactionSettings(): JSX.Element {
  const [policy, setPolicy] = useState<RedactionPolicy | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.getConfig();
        setPolicy(result.config.redaction);
        setCategories(result.redactionCategories);
      } catch (error) {
        setMessage({ kind: "error", text: (error as Error).message });
      }
    })();
  }, []);

  const toggleCategory = (kind: string, enabled: boolean): void => {
    setPolicy((current) => (current === null ? current : {
      ...current,
      categories: { ...current.categories, [kind]: enabled },
    }));
  };

  const patchPattern = (id: string, changes: Partial<CustomRedactionPattern>): void => {
    setPolicy((current) => (current === null ? current : {
      ...current,
      customPatterns: current.customPatterns.map((pattern) => (pattern.id === id ? { ...pattern, ...changes } : pattern)),
    }));
  };

  const addPattern = (): void => {
    setPolicy((current) => (current === null ? current : {
      ...current,
      customPatterns: [
        ...current.customPatterns,
        { id: `new-${Date.now()}`, kind: categories[0] ?? "api_key", label: "", regex: "", enabled: true },
      ],
    }));
  };

  const removePattern = (id: string): void => {
    setPolicy((current) => (current === null ? current : {
      ...current,
      customPatterns: current.customPatterns.filter((pattern) => pattern.id !== id),
    }));
  };

  const save = async (): Promise<void> => {
    if (policy === null) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.putRedaction({
        categories: policy.categories,
        placeholder: policy.placeholder,
        customPatterns: policy.customPatterns,
      });
      setPolicy(result.redaction);
      setMessage({ kind: "success", text: "Redaction policy saved." });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (policy === null) {
    return (
      <Card title="Redaction" icon={<ShieldCheck size={16} aria-hidden="true" />}>
        <Notice message={message} />
      </Card>
    );
  }

  return (
    <Card title="Redaction (active protected items)" icon={<ShieldCheck size={16} aria-hidden="true" />}>
      <p className="subtitle">Toggle which secret categories are redacted before analysis, and add custom patterns.</p>

      {categories.map((kind) => (
        <label key={kind} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            type="checkbox"
            checked={policy.categories[kind] === true}
            onChange={(event) => toggleCategory(kind, event.target.checked)}
          />
          {kind}
        </label>
      ))}

      <label htmlFor="placeholder">Placeholder template</label>
      <input
        id="placeholder"
        value={policy.placeholder}
        onChange={(event) => setPolicy((current) => (current === null ? current : { ...current, placeholder: event.target.value }))}
      />

      <h4>Custom patterns</h4>
      {policy.customPatterns.length === 0 && <p className="subtitle">No custom patterns yet.</p>}
      {policy.customPatterns.map((pattern) => (
        <div key={pattern.id} style={{ display: "grid", gap: "0.35rem", marginBottom: "0.75rem" }}>
          <input
            placeholder="Label"
            value={pattern.label}
            onChange={(event) => patchPattern(pattern.id, { label: event.target.value })}
          />
          <select value={pattern.kind} onChange={(event) => patchPattern(pattern.id, { kind: event.target.value })}>
            {categories.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
          <input
            placeholder="Regular expression"
            value={pattern.regex}
            onChange={(event) => patchPattern(pattern.id, { regex: event.target.value })}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="checkbox"
                checked={pattern.enabled}
                onChange={(event) => patchPattern(pattern.id, { enabled: event.target.checked })}
              />
              enabled
            </label>
            <button className="action" onClick={() => removePattern(pattern.id)}>
              <Trash2 size={15} aria-hidden="true" />Remove
            </button>
          </div>
        </div>
      ))}

      <button className="action" onClick={addPattern}><Plus size={15} aria-hidden="true" />Add pattern</button>
      <button className="action" disabled={busy} onClick={() => void save()}>
        <Save size={15} aria-hidden="true" />{busy ? "Saving…" : "Save redaction policy"}
      </button>

      <Notice message={message} />
    </Card>
  );
}
