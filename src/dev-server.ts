import { createServer } from "node:http";
import { join } from "node:path";
import type { ExternalTask, TaskProviderPort } from "./application/ports/task-provider.js";
import { SystemClock } from "./application/ports/clock.js";
import { ProcessIncomingMessageUseCase } from "./application/use-cases/process-incoming-message.js";
import type { Task } from "./domain/tasks/task.js";
import { HistoryImportService } from "./application/services/history-import-service.js";
import { LiveMessageBufferService } from "./application/services/live-message-buffer-service.js";
import { ConsoleLogger } from "./infrastructure/logger/console-logger.js";
import { InMemoryMetricsCollector } from "./infrastructure/observability/in-memory-metrics-collector.js";
import { AnthropicMemoryGraphAnalyzer } from "./infrastructure/reasoning/anthropic-memory-graph-analyzer.js";
import { RuleBasedMemoryGraphAnalyzer } from "./infrastructure/reasoning/rule-based-memory-graph-analyzer.js";
import { RuleBasedMemoryExtractor } from "./infrastructure/reasoning/rule-based-memory-extractor.js";
import { RuleBasedTaskExtractor } from "./infrastructure/reasoning/rule-based-task-extractor.js";
import { AesGcmEncryption } from "./infrastructure/security/aes-gcm-encryption.js";
import { RegexSecretDetector } from "./infrastructure/security/regex-secret-detector.js";
import { openSqliteDatabase } from "./infrastructure/sqlite/sqlite-database.js";
import { SqliteAuditRepository } from "./infrastructure/sqlite/sqlite-audit-repository.js";
import { SqliteGroupAssistantSettingsRepository } from "./infrastructure/sqlite/sqlite-group-assistant-settings-repository.js";
import { SqliteLiveMessageBufferRepository } from "./infrastructure/sqlite/sqlite-live-message-buffer-repository.js";
import { SqliteMemoryGraphRepository } from "./infrastructure/sqlite/sqlite-memory-graph-repository.js";
import { SqliteMemoryRecordRepository } from "./infrastructure/sqlite/sqlite-memory-record-repository.js";
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

class UnconfiguredNotionProvider implements TaskProviderPort {
  public async upsertTask(_task: Task): Promise<ExternalTask> {
    throw new Error("Notion MCP is not configured. Set NOTION_MCP_COMMAND and NOTION_DATABASE_ID.");
  }
}

const logger = new ConsoleLogger();
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const databasePath = process.env.DATABASE_PATH ?? join(dataDir, "nocheh.sqlite");
const encryptionSecret = process.env.LOCAL_ENCRYPTION_SECRET ?? "local-development-secret-change-me";
const encryption = new AesGcmEncryption(encryptionSecret);
const database = openSqliteDatabase(databasePath);
const metrics = new InMemoryMetricsCollector();
const secretDetector = new RegexSecretDetector();
const clock = new SystemClock();
const envStore = new DotenvFileStore(join(process.cwd(), ".env"));
const telegramClient = new TelegramHttpClient();

const taskRepository = new SqliteTaskRepository(database, encryption);
const memoryRepository = new SqliteMemoryRecordRepository(database, encryption);
const memoryGraphRepository = new SqliteMemoryGraphRepository(database, encryption);
const suggestionRepository = new SqliteSuggestionRepository(database, encryption);
const syncRepository = new SqliteTaskSyncRepository(database, encryption);
const auditRepository = new SqliteAuditRepository(database, encryption);
const settingsRepository = new SqliteGroupAssistantSettingsRepository(database);
const liveBufferRepository = new SqliteLiveMessageBufferRepository(database, encryption);

const taskProvider = createTaskProvider();
const useCase = new ProcessIncomingMessageUseCase(
  secretDetector,
  new RuleBasedTaskExtractor(),
  taskRepository,
  memoryRepository,
  syncRepository,
  taskProvider,
  clock,
  logger,
  auditRepository,
  metrics,
  new RuleBasedMemoryExtractor(),
  createMemoryGraphAnalyzer(),
  memoryGraphRepository,
  suggestionRepository,
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
);

const historyImportService = new HistoryImportService(liveProcessor, secretDetector, clock, logger);

const telegramWebhook = createTelegramWebhookHandler(liveProcessor, logger);

const apiRouter = registerApiRoutes(new Router(), {
  envStore,
  telegramClient,
  historyImportService,
  liveProcessor,
  settingsRepository,
  auditRepository,
  memoryGraphRepository,
  suggestionRepository,
  metrics,
  clock,
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

  if (await apiRouter.handle(request, response)) {
    return;
  }

  if (await staticHandler(request, response)) {
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  logger.info("Dev server listening", {
    host,
    port,
    client: `http://${displayHost}:${port}/app`,
    webhook: `http://${displayHost}:${port}/telegram/webhook`,
  });
});

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

function createMemoryGraphAnalyzer() {
  if (process.env.AI_PROVIDER !== "anthropic") {
    return new RuleBasedMemoryGraphAnalyzer();
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (
    apiKey === undefined || apiKey.trim().length === 0
    || model === undefined || model.trim().length === 0
  ) {
    return new RuleBasedMemoryGraphAnalyzer();
  }

  return new AnthropicMemoryGraphAnalyzer({
    apiKey,
    model,
  });
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
