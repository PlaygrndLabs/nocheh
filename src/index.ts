export type { IncomingMessage, MessageReaction } from "./application/dto/incoming-message.js";
export { isEmptyMessage } from "./application/dto/incoming-message.js";
export type {
  MessageAttachment,
  MessageAttachmentKind,
  MessageAttachmentVariant,
  MessageAttachmentUnderstanding,
} from "./domain/messaging/message-attachment.js";
export {
  UNDERSTANDABLE_ATTACHMENT_KINDS,
  isUnderstandableAttachment,
  selectAttachmentVariant,
  describeAttachment,
} from "./domain/messaging/message-attachment.js";
export type { IncomingReactionEvent } from "./application/dto/incoming-reaction-event.js";
export type { NoteInput } from "./application/dto/incoming-note.js";
export type { ConversationWindow, ProjectHint } from "./application/dto/conversation-window.js";
export { singleMessageWindow, windowAnchor } from "./application/dto/conversation-window.js";
export type { AssistantAiAnalysis, AssistantAiPort } from "./application/ports/assistant-ai.js";
export { NoopAssistantAi } from "./application/ports/assistant-ai.js";
export type { AuditRepositoryPort } from "./application/ports/audit-repository.js";
export { NoopAuditRepository } from "./application/ports/audit-repository.js";
export type { ClockPort } from "./application/ports/clock.js";
export { SystemClock } from "./application/ports/clock.js";
export type { EncryptionPort } from "./application/ports/encryption.js";
export type { GroupAssistantSettingsRepositoryPort } from "./application/ports/group-assistant-settings-repository.js";
export type { IdGeneratorPort } from "./application/ports/id-generator.js";
export { SystemIdGenerator } from "./application/ports/id-generator.js";
export type { IncomingMessageProcessorPort, ConversationWindowProcessorPort, ConversationProcessorPort, ReactionProcessorPort, NoteProcessorPort } from "./application/ports/incoming-message-processor.js";
export type { LiveMessageBufferRepositoryPort } from "./application/ports/live-message-buffer-repository.js";
export type { LoggerPort } from "./application/ports/logger.js";
export { NoopLogger } from "./application/ports/logger.js";
export type {
  AnalysisCandidateTarget,
  AnalyzedMemoryCandidate,
  AnalyzedStatusUpdate,
  AnalyzedTaskCandidate,
  ConversationAnalysisInput,
  MemoryGraphAnalysis,
  MemoryGraphAnalyzerPort,
} from "./application/ports/memory-graph-analyzer.js";
export { NoopMemoryGraphAnalyzer } from "./application/ports/memory-graph-analyzer.js";
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
export type { MemoryGraphRepositoryPort } from "./application/ports/memory-graph-repository.js";
export type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "./application/ports/memory-retrieval.js";
export type { MemoryBenchmarkBackendPort } from "./application/ports/memory-benchmark-backend.js";
export type { EmbeddingKind, EmbeddingPort, EmbeddingRequest, EmbeddingResult } from "./application/ports/embedding.js";
export type { MemoryEmbedding, MemoryEmbeddingRepositoryPort } from "./application/ports/memory-embedding-repository.js";
export type { MetricsCollectorPort, MetricsSnapshot } from "./application/ports/metrics.js";
export { NoopMetricsCollector } from "./application/ports/metrics.js";
export type { SecretDetectorPort } from "./application/ports/secret-detector.js";
export type { TextCompletionPort, TextCompletionInput, TextCompletionResult } from "./application/ports/text-completion.js";
export type { MediaUnderstandingPort, MediaUnderstandingInput, MediaUnderstandingResult, FetchedAttachment } from "./application/ports/media-understanding.js";
export type { AttachmentFetcherPort } from "./application/ports/attachment-fetcher.js";
export { AttachmentFetchError } from "./application/ports/attachment-fetcher.js";
export type { MediaUnderstandingCachePort } from "./application/ports/media-understanding-cache.js";
export { NoopMediaUnderstandingCache } from "./application/ports/media-understanding-cache.js";
export { MediaUnderstandingService, DEFAULT_MEDIA_UNDERSTANDING_LIMITS } from "./application/services/media-understanding-service.js";
export type { MediaUnderstandingLimits, MediaUnderstandingOutcome } from "./application/services/media-understanding-service.js";
export { MediaUnderstandingRouter } from "./application/services/media-understanding-router.js";
export { WindowRedactionService } from "./application/services/window-redaction-service.js";
export type { WindowRedactionResult } from "./application/services/window-redaction-service.js";
export type { AppConfigRepositoryPort } from "./application/ports/app-config-repository.js";
export type { RedactionPolicyProvider } from "./application/ports/redaction-policy-provider.js";
export type { SuggestionRepositoryPort } from "./application/ports/suggestion-repository.js";
export type { TaskExtractorPort } from "./application/ports/task-extractor.js";
export type { ExternalTask, TaskProviderPort } from "./application/ports/task-provider.js";
export type { TaskRepositoryPort } from "./application/ports/task-repository.js";
export type { TaskSyncRepositoryPort } from "./application/ports/task-sync-repository.js";
export { ProcessIncomingMessageUseCase } from "./application/use-cases/process-incoming-message.js";
export type { ProcessIncomingMessageResult } from "./application/use-cases/process-incoming-message.js";
export { AssistantContextBuilder } from "./application/services/assistant-context-builder.js";
export type {
  AssistantContext,
  AssistantContextBuildOptions,
  AssistantContextBuilderDependencies,
} from "./application/services/assistant-context-builder.js";
export { HistoryImportService } from "./application/services/history-import-service.js";
export type { HistoryImportMessage, HistoryImportOptions, HistoryImportResult } from "./application/services/history-import-service.js";
export { LiveMessageBufferService } from "./application/services/live-message-buffer-service.js";
export type { LiveMessageBufferResult } from "./application/services/live-message-buffer-service.js";
export { MemoryGraphQueryService } from "./application/services/memory-graph-query-service.js";
export { MemoryBenchmarkService, createMemoryBenchmarkReport } from "./application/services/memory-benchmark-service.js";
export type { MemoryBenchmarkRunInput } from "./application/services/memory-benchmark-service.js";
export type { MemoryGraphNeighborhood } from "./application/services/memory-graph-query-service.js";
export { MemoryQueryService } from "./application/services/memory-query-service.js";
export { SuggestionService } from "./application/services/suggestion-service.js";
export { SettingsService } from "./application/services/settings-service.js";
export { validateAiAnalysisOutput } from "./application/services/ai-analysis-contract.js";
export type {
  AiAnalysisItemEnvelope,
  AiAnalysisValidationOptions,
  AiAnalysisWarning,
  ProviderNeutralAiAnalysisOutput,
} from "./application/services/ai-analysis-contract.js";
export { ConversationSummaryService } from "./domain/memory/conversation-summary.js";
export type { CreateConversationSummaryInput } from "./domain/memory/conversation-summary.js";
export type { BufferedMessage } from "./domain/assistant/buffered-message.js";
export { isQuarantined } from "./domain/assistant/buffered-message.js";
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
export { memoryRecordSummary, memoryRecordText, projectIdFromName } from "./domain/memory/memory-record.js";
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
export {
  MEMORY_BENCHMARK_CATEGORIES,
  isMemoryBenchmarkCategory,
  validateMemoryBenchmarkCorpus,
  validateMemoryBenchmarkManifest,
  validateMemoryBenchmarkQuestions,
} from "./domain/evaluation/memory-benchmark.js";
export type {
  MemoryBenchmarkCategory,
  MemoryBenchmarkCategoryScore,
  MemoryBenchmarkEvidence,
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkQuestionScore,
  MemoryBenchmarkRecall,
  MemoryBenchmarkReport,
  MemoryBenchmarkSystemManifest,
  MemoryBenchmarkThresholds,
  MemoryBenchmarkUsage,
  PercentileSummary,
} from "./domain/evaluation/memory-benchmark.js";
export {
  createMemoryEdge,
  createMemoryNode,
  isMemoryGraphScope,
  isMemoryGraphStatus,
  isMemoryNodeKind,
  isMemoryPayloadKind,
  isMemoryRelation,
  normalizeGraphId,
  normalizeGraphLabel,
  validateConfidence,
  validateTemporalRange,
  ASSET_TYPES,
  CONTENT_PLATFORMS,
  GOAL_STATUSES,
  IDEA_STATUSES,
  INVESTMENT_MARKETS,
  MEMORY_GRAPH_SCOPES,
  MEMORY_GRAPH_STATUSES,
  MEMORY_NODE_KINDS,
  MEMORY_PAYLOAD_FIELD_SPECS,
  MEMORY_PAYLOAD_KINDS,
  MEMORY_RELATIONS,
  RISK_LEVELS,
  ROUTINE_CADENCES,
  SKILL_LEVELS,
} from "./domain/memory/memory-graph.js";
export type {
  CreateMemoryEdgeInput,
  CreateMemoryNodeInput,
  AssetMemoryPayload,
  ContentPlanMemoryPayload,
  ExpandedMemoryPayload,
  GoalMemoryPayload,
  GoalStatus,
  IdeaMemoryPayload,
  IdeaStatus,
  InsightMemoryPayload,
  InvestmentThesisMemoryPayload,
  LearningPlanMemoryPayload,
  MemoryPayloadKind,
  MemoryEdge,
  MemoryEdgeId,
  MemoryGraphPayload,
  MemoryGraphScope,
  MemoryGraphSource,
  MemoryGraphStatus,
  MemoryNode,
  MemoryNodeId,
  MemoryNodeKind,
  MemoryRelation,
  OpportunityMemoryPayload,
  PersonMemoryPayload,
  PersonalRuleMemoryPayload,
  PreferenceMemoryPayload,
  AssetType,
  ContentPlatform,
  InvestmentMarket,
  RiskLevel,
  RiskMemoryPayload,
  RoutineCadence,
  SkillLevel,
  RoutineExperimentMemoryPayload,
  RoutineMemoryPayload,
  SkillMemoryPayload,
  StyleRuleMemoryPayload,
} from "./domain/memory/memory-graph.js";
export {
  acceptSuggestion,
  archiveSuggestion,
  convertSuggestion,
  createActionSuggestion,
  createStrategicSuggestion,
  isExternalActionKind,
  isStrategicSuggestionKind,
  isSuggestionRiskLevel,
  isSuggestionStatus,
  rejectSuggestion,
  EXTERNAL_ACTION_KINDS,
  STRATEGIC_SUGGESTION_KINDS,
  SUGGESTION_RISK_LEVELS,
  SUGGESTION_STATUSES,
} from "./domain/memory/strategic-suggestion.js";
export type {
  ActionSuggestion,
  CreateActionSuggestionInput,
  CreateStrategicSuggestionInput,
  ExternalActionKind,
  StrategicSuggestion,
  StrategicSuggestionKind,
  Suggestion,
  SuggestionId,
  SuggestionRiskLevel,
  SuggestionStatus,
} from "./domain/memory/strategic-suggestion.js";
export type {
  AiTokenUsage,
  AuditedExtractedTask,
  ProcessingAuditRecord,
  ProcessingAuditStep,
  ProcessingStepName,
  ProcessingStepStatus,
} from "./domain/observability/audit.js";
export type { RedactedContent, SensitiveFinding, SensitiveFindingKind } from "./domain/security/redaction.js";
export {
  DEFAULT_REDACTION_POLICY,
  DEFAULT_REDACTION_PLACEHOLDER,
  REDACTION_CATEGORIES,
  compileCustomPattern,
  isSensitiveFindingKind,
  normalizeRedactionPolicy,
  normalizeRegexFlags,
  renderPlaceholder,
} from "./domain/security/redaction-policy.js";
export type {
  CustomRedactionPattern,
  RedactionPolicy,
  RedactionPolicyPatch,
} from "./domain/security/redaction-policy.js";
export { APP_CONFIG_KEYS, DEFAULT_APP_CONFIG } from "./domain/config/app-config.js";
export type { AppConfig } from "./domain/config/app-config.js";
export { Task } from "./domain/tasks/task.js";
export type { CreateTaskInput, SourceReference, TaskId, TaskPriority, TaskSnapshot, TaskStatus } from "./domain/tasks/task.js";
export { TaskCandidatePolicy } from "./domain/tasks/task-extraction.js";
export type { ExtractedTaskCandidate } from "./domain/tasks/task-extraction.js";
export { TaskValidationService, normalizeTaskTitle } from "./domain/tasks/task-validation.js";
export type { TaskValidationResult, TaskValidationWarning, TaskValidationWarningCode } from "./domain/tasks/task-validation.js";
export { RegexSecretDetector } from "./infrastructure/security/regex-secret-detector.js";
export {
  createSyntheticMemoryBenchmarkFixture,
  memoryBenchmarkManifestSha256,
  saltedMemoryBenchmarkCorpusSha256,
} from "./infrastructure/evaluation/memory-benchmark-fixture.js";
export type { SyntheticMemoryBenchmarkFixture } from "./infrastructure/evaluation/memory-benchmark-fixture.js";
export { NochehMemoryBenchmarkBackend } from "./infrastructure/evaluation/nocheh-memory-benchmark-backend.js";
export type {
  NochehBenchmarkCostModel,
  NochehBenchmarkStorageProbe,
  NochehMemoryBenchmarkBackendDependencies,
  NochehMemoryBenchmarkBackendOptions,
} from "./infrastructure/evaluation/nocheh-memory-benchmark-backend.js";
export { ConfigurableSecretDetector } from "./infrastructure/security/configurable-secret-detector.js";
export { BUILT_IN_SECRET_PATTERNS } from "./infrastructure/security/built-in-secret-patterns.js";
export { redactWithPatterns, redactLiterals, MINIMUM_LITERAL_SECRET_LENGTH } from "./infrastructure/security/redaction-engine.js";
export type { CompiledSecretPattern, LiteralSecretMatch } from "./infrastructure/security/redaction-engine.js";
export { LlmSecretDetector, SecretGuardUnavailableError, guardSystemPrompt } from "./infrastructure/security/llm-secret-detector.js";
export type { LlmSecretDetectorConfig } from "./infrastructure/security/llm-secret-detector.js";
export { GuardedSecretDetector } from "./infrastructure/security/guarded-secret-detector.js";
export type { GuardedSecretDetectorConfig, SecretGuardFailurePolicy } from "./infrastructure/security/guarded-secret-detector.js";
export { AnthropicMemoryGraphAnalyzer } from "./infrastructure/reasoning/anthropic-memory-graph-analyzer.js";
export type { AnthropicMemoryGraphAnalyzerConfig } from "./infrastructure/reasoning/anthropic-memory-graph-analyzer.js";
export { NvidiaMemoryGraphAnalyzer, NVIDIA_DEFAULT_BASE_URL } from "./infrastructure/reasoning/nvidia-memory-graph-analyzer.js";
export type { NvidiaMemoryGraphAnalyzerConfig } from "./infrastructure/reasoning/nvidia-memory-graph-analyzer.js";
export {
  AI_MODEL_ROLES,
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER_ID,
  aiModelEnvKeys,
  aiModelRoleIds,
  aiProviderEnvKeys,
  aiProviderIds,
  aiProviderRoleSupport,
  aiProviderSecretEnvKeys,
  aiRoleProviderEnvKeys,
  findAiModelRole,
  findAiProvider,
  normalizeAiProviderId,
  providersForRole,
  requiredAiProviderEnvKeys,
} from "./application/config/ai-provider-catalog.js";
export type {
  AiModelRole,
  AiModelRoleDescriptor,
  AiProviderDescriptor,
  AiProviderRoleSupport,
} from "./application/config/ai-provider-catalog.js";
export { AesGcmEncryption } from "./infrastructure/security/aes-gcm-encryption.js";
export { EncryptedJsonFileStore } from "./infrastructure/memory/encrypted-json-file-store.js";
export { LocalTaskRepository } from "./infrastructure/memory/local-task-repository.js";
export { LocalMemoryRecordRepository } from "./infrastructure/memory/local-memory-record-repository.js";
export { SemanticMemoryRetrievalService } from "./infrastructure/memory/semantic-memory-retrieval-service.js";
export { lexicalScore } from "./infrastructure/memory/lexical-score.js";
export {
  HybridMemoryRetrievalService,
  DEFAULT_LEXICAL_WEIGHT,
  DEFAULT_SIMILARITY_FLOOR,
} from "./infrastructure/memory/hybrid-memory-retrieval-service.js";
export { NvidiaEmbedding, NVIDIA_DEFAULT_EMBEDDING_URL } from "./infrastructure/memory/nvidia-embedding.js";
export { GeminiEmbedding } from "./infrastructure/memory/gemini-embedding.js";
export { MeteredEmbedding } from "./infrastructure/memory/metered-embedding.js";
export { SqliteMemoryEmbeddingRepository } from "./infrastructure/sqlite/sqlite-memory-embedding-repository.js";
export {
  EmbeddingIndexingMemoryRecordRepository,
  DEFAULT_BACKFILL_BATCH_SIZE,
} from "./application/services/memory-embedding-indexer.js";
export type { MemoryEmbeddingBackfillResult } from "./application/services/memory-embedding-indexer.js";
export { dotProduct, normalizeVector } from "./shared/vector.js";
export { LocalTaskSyncRepository } from "./infrastructure/memory/local-task-sync-repository.js";
export { InMemoryMetricsCollector } from "./infrastructure/observability/in-memory-metrics-collector.js";
export { LocalAuditRepository } from "./infrastructure/observability/local-audit-repository.js";
export { openSqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
export type { SqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
export { SqliteAppConfigRepository } from "./infrastructure/sqlite/sqlite-app-config-repository.js";
export { SqliteAuditRepository } from "./infrastructure/sqlite/sqlite-audit-repository.js";
export { SqliteGroupAssistantSettingsRepository } from "./infrastructure/sqlite/sqlite-group-assistant-settings-repository.js";
export { SqliteLiveMessageBufferRepository } from "./infrastructure/sqlite/sqlite-live-message-buffer-repository.js";
export { SqliteMemoryGraphRepository } from "./infrastructure/sqlite/sqlite-memory-graph-repository.js";
export { SqliteMemoryRecordRepository } from "./infrastructure/sqlite/sqlite-memory-record-repository.js";
export { SqliteSuggestionRepository } from "./infrastructure/sqlite/sqlite-suggestion-repository.js";
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
export { TelegramAttachmentFetcher } from "./infrastructure/messaging/telegram/telegram-attachment-fetcher.js";
export { NvidiaOmniMediaUnderstanding } from "./infrastructure/reasoning/nvidia-omni-media-understanding.js";
export type { NvidiaOmniMediaUnderstandingConfig } from "./infrastructure/reasoning/nvidia-omni-media-understanding.js";
export { GeminiMediaUnderstanding } from "./infrastructure/reasoning/gemini-media-understanding.js";
export type { GeminiMediaUnderstandingConfig } from "./infrastructure/reasoning/gemini-media-understanding.js";
export { OpenAiCompatibleTextCompletion } from "./infrastructure/reasoning/openai-compatible-text-completion.js";
export { GeminiTextCompletion } from "./infrastructure/reasoning/gemini-text-completion.js";
export { AnthropicTextCompletion } from "./infrastructure/reasoning/anthropic-text-completion.js";
export { SqliteMediaUnderstandingCache } from "./infrastructure/sqlite/sqlite-media-understanding-cache.js";
export { Router } from "./interfaces/http/router.js";
export type { JsonHandler, JsonResult, RequestContext } from "./interfaces/http/router.js";
export { createStaticHandler } from "./interfaces/http/create-static-handler.js";
export { registerApiRoutes } from "./interfaces/http/api/register-api-routes.js";
export type { ApiDependencies } from "./interfaces/http/api/register-api-routes.js";
export { parseTelegramExport } from "./interfaces/http/api/create-history-routes.js";
export { createBrainRoutes } from "./interfaces/http/api/create-brain-routes.js";
export { createConfigRoutes } from "./interfaces/http/api/create-config-routes.js";
export { createNoteRoutes } from "./interfaces/http/api/create-note-routes.js";
