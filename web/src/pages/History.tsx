import { useState } from "react";
import { api } from "../api/client.js";
import { Card, Notice, PageHeader, type NoticeMessage } from "../components/ui.js";

export function History(): JSX.Element {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage | null>(null);

  const importHistory = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const parsed: unknown = JSON.parse(raw);
      const result = await api.importHistory({ rawExport: parsed });
      setMessage({
        kind: "success",
        text: `Imported ${result.importedMessageCount} messages in ${result.processedChunkCount} chunks (${result.redactedFindingCount} secrets redacted).`,
      });
    } catch (error) {
      setMessage({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Import history"
        subtitle="Paste a Telegram Desktop export (single chat JSON). Messages are redacted, chunked, and fed through the pipeline."
      />

      <Card>
        <label htmlFor="export">Telegram export JSON</label>
        <textarea id="export" value={raw} placeholder='{ "id": 123, "name": "Chat", "messages": [ … ] }' onChange={(e) => setRaw(e.target.value)} />
        <button className="action" disabled={busy || raw.trim().length === 0} onClick={() => void importHistory()}>
          {busy ? "Importing…" : "Import"}
        </button>
        <Notice message={message} />
      </Card>
    </div>
  );
}
