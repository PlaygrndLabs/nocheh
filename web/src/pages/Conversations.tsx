import { useEffect, useState } from "react";
import { api, type AuditRecord, type ConversationSummary, type MetricsSnapshot } from "../api/client.js";
import { MetricsCards } from "../components/MetricsCards.js";
import { PipelineTrace } from "../components/PipelineTrace.js";

export function Conversations(): JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    Promise.all([api.getConversations(), api.getMetrics()])
      .then(([conv, met]) => {
        setConversations(conv.conversations);
        setMetrics(met.metrics);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(refresh, []);

  useEffect(() => {
    if (selected === null) {
      return;
    }
    api
      .getConversation(selected)
      .then((result) => setRecords(result.records))
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  return (
    <div>
      <h2>Conversations</h2>
      <p className="subtitle">Reconstructed from redacted audit records (not raw chat history). Select a conversation to see its processing flow.</p>

      {metrics !== null && <MetricsCards metrics={metrics} />}
      {error !== null && <div className="notice error">{error}</div>}

      <button className="action" onClick={refresh}>Refresh</button>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Conversations ({conversations.length})</h3>
        <div className="conversation-list">
          {conversations.length === 0 && <p className="muted">No processed conversations yet. Inject a mock message to get started.</p>}
          {conversations.map((conversation) => (
            <button key={conversation.conversationId} onClick={() => setSelected(conversation.conversationId)}>
              <b>{conversation.conversationId}</b> · {conversation.messageCount} processed ·{" "}
              {new Date(conversation.lastProcessedAt).toLocaleString()}
              <br />
              <span className="muted">{conversation.lastPreview.slice(0, 120)}</span>
            </button>
          ))}
        </div>
      </div>

      {selected !== null && (
        <div className="card">
          <h3>Pipeline flow · {selected}</h3>
          <PipelineTrace records={records} />
        </div>
      )}
    </div>
  );
}
