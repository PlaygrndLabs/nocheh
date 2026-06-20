import { useEffect, useState } from "react";
import { api, type BotInfo } from "../api/client.js";

export function Bot(): JSX.Element {
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

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
      <h2>Connect bot</h2>
      <p className="subtitle">Validates the token with getMe, then registers the webhook with Telegram.</p>

      <div className="card">
        <h3>Current status</h3>
        <p className="status-line">
          {connected ? <span className="ok">connected</span> : <span className="warn">not connected</span>}
          {bot !== null && ` · @${bot.username ?? bot.firstName} (#${bot.id})`}
        </p>
      </div>

      <div className="card">
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
          {busy ? "Connecting…" : "Validate & connect"}
        </button>
        {message !== null && <div className={`notice ${message.kind}`}>{message.text}</div>}
      </div>
    </div>
  );
}
