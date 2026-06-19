import { createServer } from "node:http";
import { join } from "node:path";
import type { ExternalTask, TaskProviderPort } from "./application/ports/task-provider.js";
import { SystemClock } from "./application/ports/clock.js";
import { ProcessIncomingMessageUseCase } from "./application/use-cases/process-incoming-message.js";
import type { Task } from "./domain/tasks/task.js";
import { ConsoleLogger } from "./infrastructure/logger/console-logger.js";
import { EncryptedJsonFileStore } from "./infrastructure/memory/encrypted-json-file-store.js";
import { LocalAuditRepository } from "./infrastructure/observability/local-audit-repository.js";
import { LocalMemoryRecordRepository } from "./infrastructure/memory/local-memory-record-repository.js";
import { LocalTaskRepository } from "./infrastructure/memory/local-task-repository.js";
import { LocalTaskSyncRepository } from "./infrastructure/memory/local-task-sync-repository.js";
import { InMemoryMetricsCollector } from "./infrastructure/observability/in-memory-metrics-collector.js";
import { RuleBasedTaskExtractor } from "./infrastructure/reasoning/rule-based-task-extractor.js";
import { AesGcmEncryption } from "./infrastructure/security/aes-gcm-encryption.js";
import { RegexSecretDetector } from "./infrastructure/security/regex-secret-detector.js";
import { StdioMcpClient } from "./infrastructure/tasks/stdio-mcp-client.js";
import { NotionMcpTaskProvider } from "./infrastructure/tasks/notion-mcp-task-provider.js";
import { createDeveloperDashboardHandler } from "./interfaces/dashboard/create-developer-dashboard-handler.js";
import { createTelegramWebhookHandler } from "./interfaces/telegram-webhook/create-telegram-webhook-handler.js";

class UnconfiguredNotionProvider implements TaskProviderPort {
  public async upsertTask(_task: Task): Promise<ExternalTask> {
    throw new Error("Notion MCP is not configured. Set NOTION_MCP_COMMAND and NOTION_DATABASE_ID.");
  }
}

const logger = new ConsoleLogger();
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const encryptionSecret = process.env.LOCAL_ENCRYPTION_SECRET ?? "local-development-secret-change-me";
const encryption = new AesGcmEncryption(encryptionSecret);
const metrics = new InMemoryMetricsCollector();

const taskRepository = new LocalTaskRepository(
  new EncryptedJsonFileStore(join(dataDir, "tasks.enc.json"), encryption, []),
);
const memoryRepository = new LocalMemoryRecordRepository(
  new EncryptedJsonFileStore(join(dataDir, "memory.enc.json"), encryption, []),
);
const syncRepository = new LocalTaskSyncRepository(
  new EncryptedJsonFileStore(join(dataDir, "task-sync.enc.json"), encryption, []),
);
const auditRepository = new LocalAuditRepository(
  new EncryptedJsonFileStore(join(dataDir, "audit.enc.json"), encryption, []),
);

const taskProvider = createTaskProvider();
const useCase = new ProcessIncomingMessageUseCase(
  new RegexSecretDetector(),
  new RuleBasedTaskExtractor(),
  taskRepository,
  memoryRepository,
  syncRepository,
  taskProvider,
  new SystemClock(),
  logger,
  auditRepository,
  metrics,
);

const telegramWebhook = createTelegramWebhookHandler(useCase, logger);
const dashboard = createDeveloperDashboardHandler(auditRepository, metrics);

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url === "/dashboard") {
    await dashboard(request, response);
    return;
  }

  if (request.url === "/telegram/webhook") {
    await telegramWebhook(request, response);
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(port, host, () => {
  logger.info("Dev server listening", {
    host,
    port,
    dashboard: `http://${host}:${port}/dashboard`,
    webhook: `http://${host}:${port}/telegram/webhook`,
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

function splitArgs(value: string): readonly string[] {
  return value.trim().length === 0 ? [] : value.trim().split(/\s+/);
}
