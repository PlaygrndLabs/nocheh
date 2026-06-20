export type { IncomingMessage } from "./application/dto/incoming-message.js";
export type { AssistantAiAnalysis, AssistantAiPort } from "./application/ports/assistant-ai.js";
export { NoopAssistantAi } from "./application/ports/assistant-ai.js";
export type { AuditRepositoryPort } from "./application/ports/audit-repository.js";
export { NoopAuditRepository } from "./application/ports/audit-repository.js";
export type { ClockPort } from "./application/ports/clock.js";
export { SystemClock } from "./application/ports/clock.js";
export type { EncryptionPort } from "./application/ports/encryption.js";
export type { GroupAssistantSettingsRepositoryPort } from "./application/ports/group-assistant-settings-repository.js";
export type { IncomingMessageProcessorPort } from "./application/ports/incoming-message-processor.js";
export type { LiveMessageBufferRepositoryPort } from "./application/ports/live-message-buffer-repository.js";
export type { LoggerPort } from "./application/ports/logger.js";
export { NoopLogger } from "./application/ports/logger.js";
export type {
  ExtractedBlockerCandidate,
  ExtractedDeadlineCandidate,
  ExtractedDecisionCandidate,
  ExtractedMemoryCandidate,
  ExtractedProjectCandidate,
  ExtractedSummaryCandidate,
  MemoryExtractorPort,
} from "./application/ports/memory-extractor.js";
export { NoopMemoryExtractor } from "./application/ports/memory-extractor.js";
export type { MemoryRecordRepositoryPort } from "./application/ports/memory-record-repository.js";
export type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "./application/ports/memory-retrieval.js";
export type { MetricsCollectorPort, MetricsSnapshot } from "./application/ports/metrics.js";
export { NoopMetricsCollector } from "./application/ports/metrics.js";
export type { SecretDetectorPort } from "./application/ports/secret-detector.js";
export type { TaskExtractorPort } from "./application/ports/task-extractor.js";
export type { ExternalTask, TaskProviderPort } from "./application/ports/task-provider.js";
export type { TaskRepositoryPort } from "./application/ports/task-repository.js";
export type { TaskSyncRepositoryPort } from "./application/ports/task-sync-repository.js";
export { ProcessIncomingMessageUseCase } from "./application/use-cases/process-incoming-message.js";
export type { ProcessIncomingMessageResult } from "./application/use-cases/process-incoming-message.js";
export { AssistantContextBuilder } from "./application/services/assistant-context-builder.js";
export type { AssistantContext } from "./application/services/assistant-context-builder.js";
export { HistoryImportService } from "./application/services/history-import-service.js";
export type { HistoryImportMessage, HistoryImportOptions, HistoryImportResult } from "./application/services/history-import-service.js";
export { LiveMessageBufferService } from "./application/services/live-message-buffer-service.js";
export type { LiveMessageBufferResult } from "./application/services/live-message-buffer-service.js";
export { MemoryQueryService } from "./application/services/memory-query-service.js";
export { ConversationSummaryService } from "./domain/memory/conversation-summary.js";
export type { CreateConversationSummaryInput } from "./domain/memory/conversation-summary.js";
export type { BufferedMessage } from "./domain/assistant/buffered-message.js";
export {
  DEFAULT_GROUP_ASSISTANT_SETTINGS,
  createGroupAssistantSettings,
} from "./domain/assistant/group-assistant-settings.js";
export type {
  AssistantReplyMode,
  CreateGroupAssistantSettingsInput,
  GroupAssistantSettings,
  MessageAnalysisMode,
} from "./domain/assistant/group-assistant-settings.js";
export { memoryRecordText, projectIdFromName } from "./domain/memory/memory-record.js";
export type {
  BlockerMemory,
  DeadlineMemory,
  DecisionMemory,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRecordType,
  MemorySource,
  ProjectMemory,
  ProjectReference,
  SummaryMemory,
} from "./domain/memory/memory-record.js";
export type {
  AuditedExtractedTask,
  ProcessingAuditRecord,
  ProcessingAuditStep,
  ProcessingStepName,
  ProcessingStepStatus,
} from "./domain/observability/audit.js";
export type { RedactedContent, SensitiveFinding, SensitiveFindingKind } from "./domain/security/redaction.js";
export { Task } from "./domain/tasks/task.js";
export type { CreateTaskInput, SourceReference, TaskId, TaskPriority, TaskSnapshot, TaskStatus } from "./domain/tasks/task.js";
export { TaskCandidatePolicy } from "./domain/tasks/task-extraction.js";
export type { ExtractedTaskCandidate } from "./domain/tasks/task-extraction.js";
export { TaskValidationService, normalizeTaskTitle } from "./domain/tasks/task-validation.js";
export type { TaskValidationResult, TaskValidationWarning, TaskValidationWarningCode } from "./domain/tasks/task-validation.js";
export { RegexSecretDetector } from "./infrastructure/security/regex-secret-detector.js";
export { RuleBasedTaskExtractor } from "./infrastructure/reasoning/rule-based-task-extractor.js";
export { RuleBasedMemoryExtractor } from "./infrastructure/reasoning/rule-based-memory-extractor.js";
export { AesGcmEncryption } from "./infrastructure/security/aes-gcm-encryption.js";
export { EncryptedJsonFileStore } from "./infrastructure/memory/encrypted-json-file-store.js";
export { LocalTaskRepository } from "./infrastructure/memory/local-task-repository.js";
export { LocalMemoryRecordRepository } from "./infrastructure/memory/local-memory-record-repository.js";
export { SemanticMemoryRetrievalService } from "./infrastructure/memory/semantic-memory-retrieval-service.js";
export { LocalTaskSyncRepository } from "./infrastructure/memory/local-task-sync-repository.js";
export { InMemoryMetricsCollector } from "./infrastructure/observability/in-memory-metrics-collector.js";
export { LocalAuditRepository } from "./infrastructure/observability/local-audit-repository.js";
export { openSqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
export type { SqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
export { SqliteAuditRepository } from "./infrastructure/sqlite/sqlite-audit-repository.js";
export { SqliteGroupAssistantSettingsRepository } from "./infrastructure/sqlite/sqlite-group-assistant-settings-repository.js";
export { SqliteLiveMessageBufferRepository } from "./infrastructure/sqlite/sqlite-live-message-buffer-repository.js";
export { SqliteMemoryRecordRepository } from "./infrastructure/sqlite/sqlite-memory-record-repository.js";
export { SqliteTaskRepository } from "./infrastructure/sqlite/sqlite-task-repository.js";
export { SqliteTaskSyncRepository } from "./infrastructure/sqlite/sqlite-task-sync-repository.js";
export { TelegramUpdateMapper } from "./infrastructure/messaging/telegram/telegram-update-mapper.js";
export type { TelegramUpdate } from "./infrastructure/messaging/telegram/telegram-update-mapper.js";
export { NotionMcpTaskProvider } from "./infrastructure/tasks/notion-mcp-task-provider.js";
export type { NotionMcpTaskProviderConfig } from "./infrastructure/tasks/notion-mcp-task-provider.js";
export { StdioMcpClient } from "./infrastructure/tasks/stdio-mcp-client.js";
export type { JsonValue, McpClient } from "./infrastructure/tasks/mcp-client.js";
export { ConsoleLogger } from "./infrastructure/logger/console-logger.js";
export { LocalGroupAssistantSettingsRepository } from "./infrastructure/assistant/local-group-assistant-settings-repository.js";
export { LocalLiveMessageBufferRepository } from "./infrastructure/assistant/local-live-message-buffer-repository.js";
export { createTelegramWebhookHandler } from "./interfaces/telegram-webhook/create-telegram-webhook-handler.js";
export type { EnvStorePort } from "./application/ports/env-store.js";
export { DotenvFileStore } from "./infrastructure/config/dotenv-file-store.js";
export type {
  TelegramBotInfo,
  TelegramClientPort,
  TelegramWebhookInfo,
} from "./application/ports/telegram-client.js";
export { TelegramHttpClient } from "./infrastructure/messaging/telegram/telegram-http-client.js";
export { Router } from "./interfaces/http/router.js";
export type { JsonHandler, JsonResult, RequestContext } from "./interfaces/http/router.js";
export { createStaticHandler } from "./interfaces/http/create-static-handler.js";
export { registerApiRoutes } from "./interfaces/http/api/register-api-routes.js";
export type { ApiDependencies } from "./interfaces/http/api/register-api-routes.js";
export { parseTelegramExport } from "./interfaces/http/api/create-history-routes.js";
