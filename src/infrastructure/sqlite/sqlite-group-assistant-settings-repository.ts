import type { GroupAssistantSettingsRepositoryPort } from "../../application/ports/group-assistant-settings-repository.js";
import type {
  AssistantReplyMode,
  GroupAssistantSettings,
  MessageAnalysisMode,
} from "../../domain/assistant/group-assistant-settings.js";
import type { ProjectHint } from "../../domain/assistant/project-hint.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface SettingsRow {
  readonly conversation_id: string;
  readonly analysis_mode: MessageAnalysisMode;
  readonly reply_mode: AssistantReplyMode;
  readonly analysis_interval_seconds: number;
  readonly max_messages_per_batch: number;
  readonly max_ai_context_tokens: number;
  readonly max_retrieved_memories: number;
  readonly max_recent_messages: number;
  readonly summary_every_messages: number;
  readonly summary_every_minutes: number;
  readonly project_hint: ProjectHint | null;
  readonly updated_at: string;
}

export class SqliteGroupAssistantSettingsRepository implements GroupAssistantSettingsRepositoryPort {
  public constructor(private readonly database: SqliteDatabase) {}

  public async save(settings: GroupAssistantSettings): Promise<void> {
    this.database.prepare(`
      INSERT INTO group_settings (
        conversation_id,
        analysis_mode,
        reply_mode,
        analysis_interval_seconds,
        max_messages_per_batch,
        max_ai_context_tokens,
        max_retrieved_memories,
        max_recent_messages,
        summary_every_messages,
        summary_every_minutes,
        project_hint,
        updated_at
      )
      VALUES (
        @conversationId,
        @analysisMode,
        @replyMode,
        @analysisIntervalSeconds,
        @maxMessagesPerBatch,
        @maxAiContextTokens,
        @maxRetrievedMemories,
        @maxRecentMessages,
        @summaryEveryMessages,
        @summaryEveryMinutes,
        @projectHint,
        @updatedAt
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        analysis_mode = excluded.analysis_mode,
        reply_mode = excluded.reply_mode,
        analysis_interval_seconds = excluded.analysis_interval_seconds,
        max_messages_per_batch = excluded.max_messages_per_batch,
        max_ai_context_tokens = excluded.max_ai_context_tokens,
        max_retrieved_memories = excluded.max_retrieved_memories,
        max_recent_messages = excluded.max_recent_messages,
        summary_every_messages = excluded.summary_every_messages,
        summary_every_minutes = excluded.summary_every_minutes,
        project_hint = excluded.project_hint,
        updated_at = excluded.updated_at
    `).run({
      ...settings,
      updatedAt: settings.updatedAt.toISOString(),
    });
  }

  public async findByConversationId(conversationId: string): Promise<GroupAssistantSettings | undefined> {
    const row = this.database
      .prepare("SELECT * FROM group_settings WHERE conversation_id = ?")
      .get(conversationId) as SettingsRow | undefined;
    return row === undefined ? undefined : this.deserialize(row);
  }

  private deserialize(row: SettingsRow): GroupAssistantSettings {
    return {
      conversationId: row.conversation_id,
      analysisMode: row.analysis_mode,
      replyMode: row.reply_mode,
      analysisIntervalSeconds: row.analysis_interval_seconds,
      maxMessagesPerBatch: row.max_messages_per_batch,
      maxAiContextTokens: row.max_ai_context_tokens,
      maxRetrievedMemories: row.max_retrieved_memories,
      maxRecentMessages: row.max_recent_messages,
      summaryEveryMessages: row.summary_every_messages,
      summaryEveryMinutes: row.summary_every_minutes,
      projectHint: row.project_hint ?? "single",
      updatedAt: new Date(row.updated_at),
    };
  }
}
