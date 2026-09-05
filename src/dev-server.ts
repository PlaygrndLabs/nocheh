import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalTask, TaskProviderPort } from "./application/ports/task-provider.js";
import { SystemClock } from "./application/ports/clock.js";
import { SystemIdGenerator } from "./application/ports/id-generator.js";
import { ProcessIncomingMessageUseCase } from "./application/use-cases/process-incoming-message.js";
import type { Task } from "./domain/tasks/task.js";
import { HistoryImportService } from "./application/services/history-import-service.js";
import { AssistantContextBuilder } from "./application/services/assistant-context-builder.js";
import { LiveMessageBufferService } from "./application/services/live-message-buffer-service.js";
import { ConsoleLogger } from "./infrastructure/logger/console-logger.js";
import { InMemoryMetricsCollector } from "./infrastructure/observability/in-memory-metrics-collector.js";
import { AnthropicMemoryGraphAnalyzer } from "./infrastructure/reasoning/anthropic-memory-graph-analyzer.js";
import { NvidiaMemoryGraphAnalyzer } from "./infrastructure/reasoning/nvidia-memory-graph-analyzer.js";
import { NvidiaOmniMediaUnderstanding } from "./infrastructure/reasoning/nvidia-omni-media-understanding.js";
import { GeminiMediaUnderstanding } from "./infrastructure/reasoning/gemini-media-understanding.js";
import { MediaUnderstandingRouter } from "./application/services/media-understanding-router.js";
import { MediaUnderstandingService } from "./application/services/media-understanding-service.js";
import type { MediaUnderstandingPort } from "./application/ports/media-understanding.js";
import type { MessageAttachmentKind } from "./domain/messaging/message-attachment.js";
import { TelegramAttachmentFetcher } from "./infrastructure/messaging/telegram/telegram-attachment-fetcher.js";
import { SqliteMediaUnderstandingCache } from "./infrastructure/sqlite/sqlite-media-understanding-cache.js";
import { OpenAiCompatibleTextCompletion } from "./infrastructure/reasoning/openai-compatible-text-completion.js";
import { GeminiTextCompletion } from "./infrastructure/reasoning/gemini-text-completion.js";
import { AnthropicTextCompletion } from "./infrastructure/reasoning/anthropic-text-completion.js";
import type { TextCompletionPort } from "./application/ports/text-completion.js";
import type { SecretDetectorPort } from "./application/ports/secret-detector.js";
import { LlmSecretDetector } from "./infrastructure/security/llm-secret-detector.js";
import {
  GuardedSecretDetector,
  type SecretGuardFailurePolicy,
} from "./infrastructure/security/guarded-secret-detector.js";
import {
  aiProviderIds,
  aiProviderRoleSupport,
  findAiModelRole,
  findAiProvider,
  normalizeAiProviderId,
  providersForRole,
  requiredAiProviderEnvKeys,
  type AiModelRole,
  type AiProviderDescriptor,
} from "./application/config/ai-provider-catalog.js";
import { NoopMemoryGraphAnalyzer, type MemoryGraphAnalyzerPort } from "./application/ports/memory-graph-analyzer.js";
import { AesGcmEncryption } from "./infrastructure/security/aes-gcm-encryption.js";
import { ConfigurableSecretDetector } from "./infrastructure/security/configurable-secret-detector.js";
import { SettingsService } from "./application/services/settings-service.js";
import { openSqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
import { SqliteAppConfigRepository } from "./infrastructure/sqlite/sqlite-app-config-repository.js";
import { SqliteAuditRepository } from "./infrastructure/sqlite/sqlite-audit-repository.js";
import { SqliteGroupAssistantSettingsRepository } from "./infrastructure/sqlite/sqlite-group-assistant-settings-repository.js";
import { SqliteLiveMessageBufferRepository } from "./infrastructure/sqlite/sqlite-live-message-buffer-repository.js";
import { SqliteMemoryGraphRepository } from "./infrastructure/sqlite/sqlite-memory-graph-repository.js";
import { SqliteMemoryRecordRepository } from "./infrastructure/sqlite/sqlite-memory-record-repository.js";
import { SqliteMemoryEmbeddingRepository } from "./infrastructure/sqlite/sqlite-memory-embedding-repository.js";
import { EmbeddingIndexingMemoryRecordRepository } from "./application/services/memory-embedding-indexer.js";
import { HybridMemoryRetrievalService } from "./infrastructure/memory/hybrid-memory-retrieval-service.js";
import { NvidiaEmbedding } from "./infrastructure/memory/nvidia-embedding.js";
import { GeminiEmbedding } from "./infrastructure/memory/gemini-embedding.js";
import { OpenAiEmbedding } from "./infrastructure/memory/openai-embedding.js";
import { MeteredEmbedding } from "./infrastructure/memory/metered-embedding.js";
import type { EmbeddingPort } from "./application/ports/embedding.js";
import { SqliteSuggestionRepository } from "./infrastructure/sqlite/sqlite-suggestion-repository.js";
import { SqliteTaskRepository } from "./infrastructure/sqlite/sqlite-task-repository.js";
import { SqliteTaskSyncRepository } from "./infrastructure/sqlite/sqlite-task-sync-repository.js";
import { StdioMcpClient } from "./infrastructure/tasks/stdio-mcp-client.js";
import { NotionMcpTaskProvider } from "./infrastructure/tasks/notion-mcp-task-provider.js";
import { createTelegramWebhookHandler } from "./interfaces/telegram-webhook/create-telegram-webhook-handler.js";
import { DotenvFileStore } from "./infrastructure/config/dotenv-file-store.js";
import { TelegramHttpClient } from "./infrastructure/messaging/telegram/telegram-http-client.js";
import { Router } from "./interfaces/http/router.js";
import { createStaticHandler } from "./interfaces/http/create-static-handler.js";
import { registerApiRoutes } from "./interfaces/http/api/register-api-routes.js";
import { authNotConfigured, SessionAuth, unauthorized } from "./interfaces/http/auth/session-auth.js";

class UnconfiguredNotionProvider implements TaskProviderPort {
  public async upsertTask(_task: Task): Promise<ExternalTask> {
    throw new Error("Notion MCP is not configured. Set NOTION_MCP_COMMAND and NOTION_DATABASE_ID.");
  }
}

loadDotenvFile(join(process.cwd(), ".env"));

const logger = new ConsoleLogger();
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const databasePath = process.env.DATABASE_PATH ?? join(dataDir, "nocheh.sqlite");
const encryptionSecret = process.env.LOCAL_ENCRYPTION_SECRET ?? "local-development-secret-change-me";
const encryption = new AesGcmEncryption(encryptionSecret);
const sessionAuth = new SessionAuth({
  ...(process.env.APP_AUTH_USERNAME === undefined ? {} : { username: process.env.APP_AUTH_USERNAME }),
  ...(process.env.APP_AUTH_PASSWORD === undefined ? {} : { password: process.env.APP_AUTH_PASSWORD }),
  sessionSecret: process.env.APP_AUTH_SESSION_SECRET || encryptionSecret,
  secureCookie: process.env.APP_AUTH_SECURE_COOKIE === "true",
});
const database = openSqliteDatabase(databasePath);
const metrics = new InMemoryMetricsCollector();
const appConfigRepository = new SqliteAppConfigRepository(database, encryption);
const settingsService = new SettingsService(appConfigRepository, logger);
await settingsService.init();
const secretDetector = new ConfigurableSecretDetector(settingsService);
const clock = new SystemClock();
const idGenerator = new SystemIdGenerator();
const envStore = new DotenvFileStore(join(process.cwd(), ".env"));
const telegramClient = new TelegramHttpClient();

const taskRepository = new SqliteTaskRepository(database, encryption);
const memoryRecordStore = new SqliteMemoryRecordRepository(database, encryption);
const memoryEmbeddingRepository = new SqliteMemoryEmbeddingRepository(database, encryption, clock);
const embedder = createEmbedding();
// Retrieval is built before the write path so the indexer can drop its vector cache.
const memoryRetrieval = new HybridMemoryRetrievalService(
  memoryRecordStore,
  memoryEmbeddingRepository,
  embedder,
  logger,
);
/**
 * Writes go through the indexer only when an embedding model is configured.
 *
 * With no embedding role this is the plain SQLite repository and retrieval falls back to
 * word overlap, so the feature is absent rather than half-present.
 */
const memoryEmbeddingIndexer = embedder === undefined
  ? undefined
  : new EmbeddingIndexingMemoryRecordRepository(
    memoryRecordStore,
    memoryEmbeddingRepository,
    embedder,
    logger,
    () => { memoryRetrieval.invalidate(); },
  );
const memoryRepository = memoryEmbeddingIndexer ?? memoryRecordStore;
const memoryGraphRepository = new SqliteMemoryGraphRepository(database, encryption);
const suggestionRepository = new SqliteSuggestionRepository(database, encryption);
const syncRepository = new SqliteTaskSyncRepository(database, encryption);
const auditRepository = new SqliteAuditRepository(database, encryption);
const settingsRepository = new SqliteGroupAssistantSettingsRepository(database);
const liveBufferRepository = new SqliteLiveMessageBufferRepository(database, encryption);

const taskProvider = createTaskProvider();
const mediaUnderstanding = createMediaUnderstandingService();
/**
 * The read path: every window becomes a recall query before it is analysed.
 *
 * Built after the graph and suggestion repositories because it reads all three. Recall
 * degrades on its own (word overlap with no embedding role, nothing with an empty
 * window), so this is always wired rather than gated on a provider.
 */
const assistantContextBuilder = new AssistantContextBuilder(memoryRetrieval, {
  graphRepository: memoryGraphRepository,
  suggestionRepository,
});
// The buffer path keeps pattern redaction (cheap, on the webhook ack path); the
// analysis gate uses the guard model with patterns as its emergency fallback.
const guardDetector = createGuardedSecretDetector();
const useCase = new ProcessIncomingMessageUseCase(
  guardDetector,
  createMemoryGraphAnalyzer(),
  taskRepository,
  memoryRepository,
  syncRepository,
  taskProvider,
  clock,
  logger,
  auditRepository,
  metrics,
  memoryGraphRepository,
  suggestionRepository,
  idGenerator,
  mediaUnderstanding,
  assistantContextBuilder,
);

const liveProcessor = new LiveMessageBufferService(
  liveBufferRepository,
  settingsRepository,
  useCase,
  secretDetector,
  clock,
  logger,
  {
    analysisMode: envAnalysisMode(),
    analysisIntervalSeconds: numberEnv("LIVE_ANALYSIS_INTERVAL_SECONDS", 300),
    maxMessagesPerBatch: numberEnv("LIVE_MAX_MESSAGES_PER_BATCH", 50),
    maxAiContextTokens: numberEnv("MAX_AI_CONTEXT_TOKENS", 4000),
    maxRetrievedMemories: numberEnv("MAX_RETRIEVED_MEMORIES", 12),
    maxRecentMessages: numberEnv("MAX_RECENT_MESSAGES", 30),
    summaryEveryMessages: numberEnv("SUMMARY_EVERY_MESSAGES", 100),
    summaryEveryMinutes: numberEnv("SUMMARY_EVERY_MINUTES", 60),
  },
  numberEnv("SECRET_GUARD_MAX_ATTEMPTS", 5),
);

const historyImportService = new HistoryImportService(liveProcessor, secretDetector, clock, logger);

const telegramWebhook = createTelegramWebhookHandler(liveProcessor, logger, {
  allowedChatIds: () => csvSet(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
  allowedUserIds: () => csvSet(process.env.TELEGRAM_ALLOWED_USER_IDS),
});

const apiRouter = registerApiRoutes(new Router(), {
  envStore,
  telegramClient,
  historyImportService,
  liveProcessor,
  settingsRepository,
  settingsService,
  auditRepository,
  memoryGraphRepository,
  suggestionRepository,
  metrics,
  clock,
  auth: sessionAuth,
  ...(memoryEmbeddingIndexer === undefined ? {} : { memoryEmbeddingIndexer }),
});

const webDistDir = process.env.WEB_DIST_DIR ?? join(process.cwd(), "web", "dist");
const staticHandler = createStaticHandler(webDistDir);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/telegram/webhook") {
    await telegramWebhook(request, response);
    return;
  }

  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) {
    if (!sessionAuth.isConfigured()) {
      writeJson(response, authNotConfigured());
      return;
    }
    if (sessionAuth.verifyRequest(request) === undefined) {
      writeJson(response, unauthorized());
      return;
    }
  }

  if (await apiRouter.handle(request, response)) {
    return;
  }

  if (await staticHandler(request, response)) {
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "Not found" }));
});

if (!sessionAuth.isConfigured()) {
  logger.warn("App auth is not configured. Set APP_AUTH_USERNAME and APP_AUTH_PASSWORD before testing private data.");
}

if (memoryEmbeddingIndexer !== undefined) {
  // Reported, never done automatically: a backfill is one paid model call per record, so
  // switching the role on must not quietly spend money at boot.
  const [records, indexed] = await Promise.all([
    memoryRecordStore.findAll(),
    memoryEmbeddingRepository.indexedRecordIds(),
  ]);
  const pending = records.length - indexed.length;
  if (pending > 0) {
    logger.warn("Memory records have no embedding yet; recall falls back to word overlap for them.", {
      pending,
      indexed: indexed.length,
      action: "POST /api/memory/reindex",
    });
  }
}

if (envAnalysisMode() === "immediate") {
  logger.warn(
    "MESSAGE_ANALYSIS_MODE=immediate analyses inside the webhook request. Analysis can take minutes, so Telegram will time out and retry. Use batch unless you are testing.",
  );
}

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  logger.info("Dev server listening", {
    host,
    port,
    client: `http://${displayHost}:${port}/app`,
    webhook: `http://${displayHost}:${port}/telegram/webhook`,
  });
});

/**
 * Flush sweep: the only thing that runs analysis in batch mode.
 *
 * The webhook used to flush inline, which meant Telegram's own timeout fired during a
 * 200s analysis and it retried the same update. Now the webhook only buffers and this
 * timer owns analysis, so `FLUSH_SWEEP_INTERVAL_SECONDS` is also the worst-case delay
 * between a due batch and its analysis.
 *
 * One sweep at a time. `flushDue` walks conversations sequentially and the buffer
 * service refuses a second flush of the same conversation, but a slow sweep would still
 * overlap the next tick and start concurrent model calls across conversations. For a
 * single owner, serialising is cheaper and keeps clear of provider rate limits.
 */
const flushSweepSeconds = numberEnv("FLUSH_SWEEP_INTERVAL_SECONDS", 60);
let sweepRunning = false;
const flushSweep = setInterval(() => {
  if (sweepRunning) {
    logger.warn("Flush sweep still running; skipping this tick.", { intervalSeconds: flushSweepSeconds });
    return;
  }
  sweepRunning = true;
  const startedAt = Date.now();
  void liveProcessor.flushDue().then((flushed) => {
    if (flushed > 0) {
      logger.info("Flush sweep processed due batches", { flushed, durationMs: Date.now() - startedAt });
    }
  }).catch((error: unknown) => {
    logger.error("Flush sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    sweepRunning = false;
  });
}, flushSweepSeconds * 1000);
// Never hold the process open for the timer alone.
flushSweep.unref();

function createTaskProvider(): TaskProviderPort {
  const command = process.env.NOTION_MCP_COMMAND;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (command === undefined || databaseId === undefined) {
    return new UnconfiguredNotionProvider();
  }

  return new NotionMcpTaskProvider(
    new StdioMcpClient(command, splitArgs(process.env.NOTION_MCP_ARGS ?? "")),
    {
      providerName: "notion",
      createToolName: process.env.NOTION_MCP_CREATE_TOOL ?? "notion_create_task",
      updateToolName: process.env.NOTION_MCP_UPDATE_TOOL ?? "notion_update_task",
      databaseId,
    },
  );
}

interface ResolvedAiRole {
  readonly provider: AiProviderDescriptor;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Resolves the provider and model configured for a role.
 *
 * Roles degrade independently and never throw: an unconfigured or misconfigured
 * role is disabled with a warning so one missing model cannot take the pipeline
 * down. Returns undefined when the role cannot run.
 */
function resolveAiRole(role: AiModelRole): ResolvedAiRole | undefined {
  const descriptor = findAiModelRole(role);
  if (descriptor === undefined) {
    return undefined;
  }

  const providerId = normalizeAiProviderId(process.env[descriptor.providerEnvKey]);
  if (providerId === undefined) {
    logger.warn(`AI role "${role}" is not configured (${descriptor.providerEnvKey} is empty).`, {
      consequence: descriptor.whenUnset,
    });
    return undefined;
  }

  const provider = findAiProvider(providerId);
  if (provider === undefined) {
    logger.warn(`Unknown provider for AI role "${role}". Role disabled.`, {
      provider: providerId,
      supported: aiProviderIds().join(", "),
    });
    return undefined;
  }

  const support = aiProviderRoleSupport(provider, role);
  if (support === undefined) {
    logger.warn(`Provider cannot fill AI role "${role}". Role disabled.`, {
      provider: provider.id,
      supported: providersForRole(role).map((candidate) => candidate.id).join(", "),
    });
    return undefined;
  }

  const missing = requiredAiProviderEnvKeys(provider, role).filter((key) => trimmedEnv(key) === undefined);
  if (missing.length > 0) {
    logger.warn(`AI role "${role}" is selected but required env keys are missing. Role disabled.`, {
      provider: provider.id,
      missing: missing.join(", "),
      consequence: descriptor.whenUnset,
    });
    return undefined;
  }

  const model = trimmedEnv(support.modelEnvKey) ?? support.defaultModel ?? "";
  logger.info(`AI role "${role}" configured.`, { provider: provider.id, model });
  return { provider, model, apiKey: trimmedEnv(provider.apiKeyEnvKey) ?? "" };
}

function createMemoryGraphAnalyzer(): MemoryGraphAnalyzerPort {
  const resolved = resolveAiRole("text_analysis");
  if (resolved === undefined) {
    logger.warn("Running in dry-run mode: no analysis will be produced.");
    return new NoopMemoryGraphAnalyzer();
  }

  const { provider, model, apiKey } = resolved;
  const maxTokens = numberEnv("MAX_AI_OUTPUT_TOKENS", 4000);

  switch (provider.id) {
    case "nvidia": {
      const baseUrl = trimmedEnv("NVIDIA_BASE_URL");
      return new NvidiaMemoryGraphAnalyzer({
        apiKey,
        model,
        maxTokens,
        logger,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(process.env.NVIDIA_JSON_RESPONSE_FORMAT === "false" ? { jsonResponseFormat: false } : {}),
      });
    }
    case "openai": {
      const baseUrl = trimmedEnv("OPENAI_BASE_URL") ?? "https://api.openai.com/v1/chat/completions";
      return new NvidiaMemoryGraphAnalyzer({
        apiKey,
        provider: provider.id,
        model,
        maxTokens,
        logger,
        baseUrl,
      });
    }
    case "anthropic":
      return new AnthropicMemoryGraphAnalyzer({ apiKey, model, maxTokens, logger });
    default:
      logger.warn("AI provider has a catalog entry but no text-analysis adapter. Running in dry-run mode.", {
        provider: provider.id,
      });
      return new NoopMemoryGraphAnalyzer();
  }
}

/** Builds the perception adapter for one attachment kind, or undefined when unconfigured. */
function createMediaUnderstanding(
  role: "image_understanding" | "audio_understanding",
  kind: MessageAttachmentKind,
): MediaUnderstandingPort | undefined {
  const resolved = resolveAiRole(role);
  if (resolved === undefined) {
    return undefined;
  }

  const { provider, model, apiKey } = resolved;
  switch (provider.id) {
    case "nvidia": {
      const baseUrl = trimmedEnv("NVIDIA_BASE_URL");
      return new NvidiaOmniMediaUnderstanding({
        apiKey,
        model,
        supportedKinds: [kind],
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    }
    case "gemini": {
      const baseUrl = trimmedEnv("GEMINI_BASE_URL");
      return new GeminiMediaUnderstanding({
        apiKey,
        model,
        supportedKinds: [kind],
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    }
    default:
      logger.warn("Provider has a catalog entry but no media adapter. Role disabled.", {
        provider: provider.id,
        role,
      });
      return undefined;
  }
}

/**
 * Wires image and audio perception. Kinds are configured separately so they can use
 * one omni model or two specialised ones. Undefined when neither kind is configured,
 * which leaves attachments recorded but undescribed.
 */
function createMediaUnderstandingService(): MediaUnderstandingService | undefined {
  const image = createMediaUnderstanding("image_understanding", "image");
  const audio = createMediaUnderstanding("audio_understanding", "audio");
  if (image === undefined && audio === undefined) {
    return undefined;
  }

  const router = new MediaUnderstandingRouter({
    ...(image === undefined ? {} : { image }),
    ...(audio === undefined ? {} : { audio }),
  });
  const fetcher = new TelegramAttachmentFetcher(telegramClient, () => trimmedEnv("TELEGRAM_BOT_TOKEN"));
  return new MediaUnderstandingService(
    router,
    [fetcher],
    logger,
    clock,
    {
      maxAttachmentsPerWindow: numberEnv("MEDIA_MAX_ATTACHMENTS_PER_WINDOW", 8),
      maxDownloadBytes: numberEnv("MEDIA_MAX_DOWNLOAD_BYTES", 20 * 1024 * 1024),
      maxInlineBytes: numberEnv("MEDIA_MAX_INLINE_BYTES", 5 * 1024 * 1024),
    },
    new SqliteMediaUnderstandingCache(database, encryption),
  );
}

/** Builds the embedding client for memory recall, or undefined when the role is unset. */
function createEmbedding(): EmbeddingPort | undefined {
  const adapter = createEmbeddingAdapter();
  // Wrapped here, not at each call site, so recall, write-through indexing and backfill
  // are all counted in /api/metrics without any of them knowing about metrics.
  return adapter === undefined ? undefined : new MeteredEmbedding(adapter, metrics);
}

function createEmbeddingAdapter(): EmbeddingPort | undefined {
  // resolveAiRole already reports an unset role and its consequence from the catalog.
  const resolved = resolveAiRole("embedding");
  if (resolved === undefined) {
    return undefined;
  }

  const { provider, model, apiKey } = resolved;
  switch (provider.id) {
    case "nvidia": {
      const baseUrl = trimmedEnv("NVIDIA_EMBEDDING_BASE_URL");
      return new NvidiaEmbedding({
        apiKey,
        model,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(process.env.NVIDIA_EMBEDDING_INPUT_TYPE === "false" ? { sendInputType: false } : {}),
      });
    }
    case "gemini": {
      const baseUrl = trimmedEnv("GEMINI_BASE_URL");
      return new GeminiEmbedding({ apiKey, model, ...(baseUrl === undefined ? {} : { baseUrl }) });
    }
    case "openai": {
      const baseUrl = trimmedEnv("OPENAI_EMBEDDING_BASE_URL");
      return new OpenAiEmbedding({ apiKey, model, ...(baseUrl === undefined ? {} : { baseUrl }) });
    }
    default:
      logger.warn("Embedding provider has a catalog entry but no adapter; recall uses word overlap only.", {
        provider: provider.id,
      });
      return undefined;
  }
}

/** Builds a provider-agnostic single-turn completion client for a role, if configured. */
function createTextCompletion(role: AiModelRole, maxTokens: number): TextCompletionPort | undefined {
  const resolved = resolveAiRole(role);
  if (resolved === undefined) {
    return undefined;
  }

  const { provider, model, apiKey } = resolved;
  switch (provider.id) {
    case "nvidia": {
      const baseUrl = trimmedEnv("NVIDIA_BASE_URL");
      return new OpenAiCompatibleTextCompletion({
        provider: provider.id,
        apiKey,
        model,
        maxTokens,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    }
    case "gemini": {
      const baseUrl = trimmedEnv("GEMINI_BASE_URL");
      return new GeminiTextCompletion({
        apiKey,
        model,
        maxTokens,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    }
    case "anthropic":
      return new AnthropicTextCompletion({ apiKey, model, maxTokens });
    default:
      logger.warn("Provider has a catalog entry but no completion adapter. Role disabled.", {
        provider: provider.id,
        role,
      });
      return undefined;
  }
}

/**
 * Builds the pre-analysis secret gate.
 *
 * Without a guard model this is just the pattern detector, which is the behaviour
 * Nocheh has always had. With one, the model becomes authoritative and patterns
 * become the emergency fallback.
 */
function createGuardedSecretDetector(): SecretDetectorPort {
  const completion = createTextCompletion("secret_guard", numberEnv("SECRET_GUARD_MAX_OUTPUT_TOKENS", 4000));
  if (completion === undefined) {
    logger.warn("Secret guard model is not configured. Redaction uses pattern rules only.");
    return secretDetector;
  }

  const guard = new LlmSecretDetector(completion, settingsService, logger, {
    maxInputCharacters: numberEnv("SECRET_GUARD_MAX_INPUT_CHARACTERS", 24_000),
  });
  const onFailure: SecretGuardFailurePolicy = process.env.SECRET_GUARD_ON_FAILURE === "degrade_to_patterns"
    ? "degrade_to_patterns"
    : "fail_closed";
  logger.info("Secret guard configured.", { onFailure });
  return new GuardedSecretDetector(guard, secretDetector, logger, { onFailure });
}

function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function splitArgs(value: string): readonly string[] {
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/);
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envAnalysisMode(): "immediate" | "batch" {
  return process.env.MESSAGE_ANALYSIS_MODE === "immediate" ? "immediate" : "batch";
}

function loadDotenvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    // A real process env value wins, but an empty one (common with
    // `VAR: ${VAR:-}` in compose) must not shadow the .env file.
    if (key.length === 0 || (process.env[key] ?? "").length > 0) {
      continue;
    }
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0));
}

function writeJson(
  response: ServerResponse,
  result: { readonly status: number; readonly body: unknown },
): void {
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
}
