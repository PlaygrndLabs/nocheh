import { useEffect, useState } from "react";
import { Plus, PlugZap, Save, Trash2 } from "lucide-react";
import { api, type BotInfo } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Bot(): JSX.Element {
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage | null>(null);
  const [accessMessage, setAccessMessage] = useState<NoticeMessage | null>(null);
  const [allowedChatIds, setAllowedChatIds] = useState<string[]>([]);
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>([]);
  const [newChatId, setNewChatId] = useState("");
  const [newUserId, setNewUserId] = useState("");

  useEffect(() => {
    api
      .getBotStatus()
      .then((status) => {
        setConnected(status.connected);
        setBot(status.bot ?? null);
      })
      .catch(() => undefined);
    api
      .getTelegramAccess()
      .then((access) => {
        setAllowedChatIds(access.allowedChatIds);
        setAllowedUserIds(access.allowedUserIds);
      })
      .catch(() => undefined);
  }, []);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.connectBot(token, webhookUrl);
      setBot(result.bot);
      setConnected(true);
      setToken("");
      setMessage({ kind: "success", text: `Connected @${result.bot.username ?? result.bot.firstName} and registered the webhook.` });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const addChatId = (): void => {
    setAllowedChatIds((current) => addId(current, newChatId));
    setNewChatId("");
  };

  const addUserId = (): void => {
    setAllowedUserIds((current) => addId(current, newUserId));
    setNewUserId("");
  };

  const saveAccess = async (): Promise<void> => {
    setAccessBusy(true);
    setAccessMessage(null);
    try {
      const result = await api.putTelegramAccess({ allowedChatIds, allowedUserIds });
      setAllowedChatIds(result.allowedChatIds);
      setAllowedUserIds(result.allowedUserIds);
      setAccessMessage({ kind: "success", text: "Telegram access list saved. New webhook messages use it immediately." });
    } catch (error) {
      setAccessMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setAccessBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Connect bot" subtitle="Validates the token with getMe, then registers the webhook with Telegram." />

      <Card title="Current status">
        <p className="status-line">
          <StatusFlag active={connected} activeLabel="connected" inactiveLabel="not connected" />
          {bot !== null && ` · @${bot.username ?? bot.firstName} (#${bot.id})`}
        </p>
      </Card>

      <Card>
        <label htmlFor="token">TELEGRAM_BOT_TOKEN</label>
        <input id="token" type="password" value={token} placeholder="123456:ABC-…" onChange={(e) => setToken(e.target.value)} />
        <label htmlFor="webhook">Webhook URL</label>
        <input
          id="webhook"
          type="url"
          value={webhookUrl}
          placeholder="https://your-host/telegram/webhook"
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        <button className="action" disabled={busy || token.length === 0 || webhookUrl.length === 0} onClick={() => void connect()}>
          <PlugZap size={15} aria-hidden="true" />
          {busy ? "Connecting…" : "Validate & connect"}
        </button>
        <Notice message={message} />
      </Card>

      <Card title="Telegram access control">
        <p className="muted">
          Leave a list empty to allow every value for that dimension. For private MVP use, set at least your user ID and the group IDs you approve.
        </p>
        <div className="access-grid">
          <AccessList
            title="Allowed group/chat IDs"
            placeholder="-1001234567890"
            value={newChatId}
            items={allowedChatIds}
            onChange={setNewChatId}
            onAdd={addChatId}
            onRemove={(id) => setAllowedChatIds((current) => current.filter((item) => item !== id))}
          />
          <AccessList
            title="Allowed user IDs"
            placeholder="123456789"
            value={newUserId}
            items={allowedUserIds}
            onChange={setNewUserId}
            onAdd={addUserId}
            onRemove={(id) => setAllowedUserIds((current) => current.filter((item) => item !== id))}
          />
        </div>
        <button className="action" disabled={accessBusy} onClick={() => void saveAccess()}>
          <Save size={15} aria-hidden="true" />
          {accessBusy ? "Saving..." : "Save access list"}
        </button>
        <Notice message={accessMessage} />
      </Card>
    </div>
  );
}

function AccessList({
  title,
  placeholder,
  value,
  items,
  onChange,
  onAdd,
  onRemove,
}: {
  readonly title: string;
  readonly placeholder: string;
  readonly value: string;
  readonly items: readonly string[];
  onChange(value: string): void;
  onAdd(): void;
  onRemove(id: string): void;
}): JSX.Element {
  return (
    <section className="access-list">
      <b>{title}</b>
      <div className="access-add-row">
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        <button className="icon-button" type="button" disabled={!isTelegramId(value)} onClick={onAdd} title="Add ID" aria-label={`Add ${title}`}>
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="access-pill-list">
        {items.length === 0 && <span className="muted">No restriction</span>}
        {items.map((id) => (
          <span key={id} className="access-pill">
            {id}
            <button type="button" onClick={() => onRemove(id)} title={`Remove ${id}`} aria-label={`Remove ${id}`}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
    </section>
  );
}

function addId(current: readonly string[], id: string): string[] {
  const next = id.trim();
  if (!isTelegramId(next) || current.includes(next)) {
    return [...current];
  }
  return [...current, next];
}

function isTelegramId(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}
