import type { ClockPort } from "../../../application/ports/clock.js";
import type { AuditRepositoryPort } from "../../../application/ports/audit-repository.js";
import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { GroupAssistantSettingsRepositoryPort } from "../../../application/ports/group-assistant-settings-repository.js";
import type { MetricsCollectorPort } from "../../../application/ports/metrics.js";
import type { TelegramClientPort } from "../../../application/ports/telegram-client.js";
import type { HistoryImportService } from "../../../application/services/history-import-service.js";
import type { LiveMessageBufferService } from "../../../application/services/live-message-buffer-service.js";
import type { Router } from "../router.js";
import { createHistoryRoutes } from "./create-history-routes.js";
import { createMockRoutes } from "./create-mock-routes.js";
import { createObservabilityRoutes } from "./create-observability-routes.js";
import { createSettingsRoutes } from "./create-settings-routes.js";
import { createSetupRoutes } from "./create-setup-routes.js";
import { createTelegramRoutes } from "./create-telegram-routes.js";

/** Dependencies the dashboard API needs, supplied from the composition root. */
export interface ApiDependencies {
  readonly envStore: EnvStorePort;
  readonly telegramClient: TelegramClientPort;
  readonly historyImportService: HistoryImportService;
  readonly liveProcessor: LiveMessageBufferService;
  readonly settingsRepository: GroupAssistantSettingsRepositoryPort;
  readonly auditRepository: AuditRepositoryPort;
  readonly metrics: MetricsCollectorPort;
  readonly clock: ClockPort;
}

/** Registers every `/api/*` route on the given router. */
export function registerApiRoutes(router: Router, deps: ApiDependencies): Router {
  const setup = createSetupRoutes(deps.envStore);
  const telegram = createTelegramRoutes(deps.telegramClient, deps.envStore);
  const history = createHistoryRoutes(deps.historyImportService);
  const mock = createMockRoutes(deps.liveProcessor, deps.clock);
  const settings = createSettingsRoutes(deps.settingsRepository, deps.clock);
  const observability = createObservabilityRoutes(deps.auditRepository, deps.metrics);

  router
    .get("/api/setup/status", setup.getStatus)
    .get("/api/env", setup.getEnv)
    .put("/api/env", setup.putEnv)
    .post("/api/telegram/connect", telegram.connect)
    .get("/api/telegram/status", telegram.status)
    .post("/api/history/import", history.importHistory)
    .post("/api/mock/inject", mock.inject)
    .post("/api/mock/flush", mock.flush)
    .get("/api/settings/:conversationId", settings.get)
    .put("/api/settings/:conversationId", settings.put)
    .get("/api/metrics", observability.metrics)
    .get("/api/audit", observability.audit)
    .get("/api/conversations", observability.conversations)
    .get("/api/conversations/:conversationId", observability.conversation);

  return router;
}
