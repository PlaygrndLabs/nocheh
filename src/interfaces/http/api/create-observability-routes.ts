import type { AuditRepositoryPort } from "../../../application/ports/audit-repository.js";
import type { MetricsCollectorPort } from "../../../application/ports/metrics.js";
import type { ProcessingAuditRecord } from "../../../domain/observability/audit.js";
import type { JsonHandler } from "../router.js";

const DEFAULT_AUDIT_LIMIT = 50;
const CONVERSATION_SCAN_LIMIT = 200;

export interface ObservabilityRoutes {
  readonly metrics: JsonHandler;
  readonly audit: JsonHandler;
  readonly conversations: JsonHandler;
  readonly conversation: JsonHandler;
}

/** Read-only routes backing the metrics and chat-flow visualization. */
export function createObservabilityRoutes(
  auditRepository: AuditRepositoryPort,
  metrics: MetricsCollectorPort,
): ObservabilityRoutes {
  return {
    metrics: () => ({ status: 200, body: { ok: true, metrics: metrics.snapshot() } }),

    audit: async ({ query }) => {
      const limit = clampLimit(query.get("limit"));
      const records = await auditRepository.findRecent(limit);
      return { status: 200, body: { ok: true, records } };
    },

    conversations: async () => {
      const records = await auditRepository.findRecent(CONVERSATION_SCAN_LIMIT);
      return { status: 200, body: { ok: true, conversations: summarize(realConversationRecords(records)) } };
    },

    conversation: async ({ params }) => {
      const conversationId = params.conversationId ?? "";
      const records = await auditRepository.findRecent(CONVERSATION_SCAN_LIMIT);
      // Detail view is not filtered so the Simulator can read back its own mock/simulator runs.
      const matching = records.filter((record) => record.conversationId === conversationId);
      return { status: 200, body: { ok: true, conversationId, records: matching } };
    },
  };
}

interface ConversationSummary {
  conversationId: string;
  platform: string;
  messageCount: number;
  lastProcessedAt: Date;
  lastPreview: string;
}

/** Groups a bounded window of audit records into per-conversation summaries. */
function summarize(records: readonly ProcessingAuditRecord[]): ConversationSummary[] {
  const byConversation = new Map<string, ConversationSummary>();
  for (const record of records) {
    const existing = byConversation.get(record.conversationId);
    if (existing === undefined) {
      byConversation.set(record.conversationId, {
        conversationId: record.conversationId,
        platform: record.platform,
        messageCount: 1,
        lastProcessedAt: record.processedAt,
        lastPreview: record.redactedContentPreview,
      });
      continue;
    }

    existing.messageCount += 1;
    if (record.processedAt.getTime() > existing.lastProcessedAt.getTime()) {
      existing.lastProcessedAt = record.processedAt;
      existing.lastPreview = record.redactedContentPreview;
    }
  }

  return [...byConversation.values()].sort(
    (left, right) => right.lastProcessedAt.getTime() - left.lastProcessedAt.getTime(),
  );
}

function realConversationRecords(records: readonly ProcessingAuditRecord[]): readonly ProcessingAuditRecord[] {
  return records.filter((record) => record.platform !== "mock" && record.platform !== "simulator");
}

function clampLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(value, CONVERSATION_SCAN_LIMIT);
}
