import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";
import { api, type BotInfo } from "../api/client.js";
import { Card, Notice, PageHeader, StatusFlag, type NoticeMessage } from "../components/ui.js";

export function Bot(): JSX.Element {
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage | null>(null);

  useEffect(() => {
    api
      .getBotStatus()
      .then((status) => {
        setConnected(status.connected);
        setBot(status.bot ?? null);
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
    </div>
  );
}
