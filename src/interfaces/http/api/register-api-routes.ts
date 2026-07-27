import type { ClockPort } from "../../../application/ports/clock.js";
import type { AuditRepositoryPort } from "../../../application/ports/audit-repository.js";
import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { GroupAssistantSettingsRepositoryPort } from "../../../application/ports/group-assistant-settings-repository.js";
import type { MetricsCollectorPort } from "../../../application/ports/metrics.js";
import type { TelegramClientPort } from "../../../application/ports/telegram-client.js";
import type { HistoryImportService } from "../../../application/services/history-import-service.js";
import type { LiveMessageBufferService } from "../../../application/services/live-message-buffer-service.js";
import type { MemoryGraphRepositoryPort } from "../../../application/ports/memory-graph-repository.js";
import type { Router } from "../router.js";
import type { SuggestionRepositoryPort } from "../../../application/ports/suggestion-repository.js";
import type { SettingsService } from "../../../application/services/settings-service.js";
import { createAuthRoutes } from "./create-auth-routes.js";
import { createBrainRoutes } from "./create-brain-routes.js";
import { createConfigRoutes } from "./create-config-routes.js";
import { createHistoryRoutes } from "./create-history-routes.js";
import { createMockRoutes } from "./create-mock-routes.js";
import { createNoteRoutes } from "./create-note-routes.js";
import { createObservabilityRoutes } from "./create-observability-routes.js";
import { createSettingsRoutes } from "./create-settings-routes.js";
import { createSetupRoutes } from "./create-setup-routes.js";
import { createTelegramRoutes } from "./create-telegram-routes.js";
import type { SessionAuth } from "../auth/session-auth.js";

/** Dependencies the UI API needs, supplied from the composition root. */
export interface ApiDependencies {
  readonly envStore: EnvStorePort;
  readonly telegramClient: TelegramClientPort;
  readonly historyImportService: HistoryImportService;
  readonly liveProcessor: LiveMessageBufferService;
  readonly settingsRepository: GroupAssistantSettingsRepositoryPort;
  readonly settingsService: SettingsService;
  readonly auditRepository: AuditRepositoryPort;
  readonly memoryGraphRepository: MemoryGraphRepositoryPort;
  readonly suggestionRepository: SuggestionRepositoryPort;
  readonly metrics: MetricsCollectorPort;
  readonly clock: ClockPort;
  readonly auth: SessionAuth;
}

/** Registers every `/api/*` route on the given router. */
export function registerApiRoutes(router: Router, deps: ApiDependencies): Router {
  const auth = createAuthRoutes(deps.auth);
  const setup = createSetupRoutes(deps.envStore);
  const telegram = createTelegramRoutes(deps.telegramClient, deps.envStore);
  const history = createHistoryRoutes(deps.historyImportService);
  const mock = createMockRoutes(deps.liveProcessor, deps.clock);
  const settings = createSettingsRoutes(deps.settingsRepository, deps.clock);
  const config = createConfigRoutes(deps.settingsService);
  const observability = createObservabilityRoutes(deps.auditRepository, deps.metrics);
  const brain = createBrainRoutes(deps.memoryGraphRepository, deps.suggestionRepository);
  const note = createNoteRoutes(deps.liveProcessor);

  router
    .get("/api/auth/status", auth.status)
    .post("/api/auth/login", auth.login)
    .post("/api/auth/logout", auth.logout)
    .get("/api/setup/status", setup.getStatus)
    .get("/api/env", setup.getEnv)
    .put("/api/env", setup.putEnv)
    .post("/api/telegram/connect", telegram.connect)
    .get("/api/telegram/status", telegram.status)
    .get("/api/telegram/access", telegram.getAccess)
    .put("/api/telegram/access", telegram.putAccess)
    .post("/api/history/import", history.importHistory)
    .post("/api/mock/inject", mock.inject)
    .post("/api/mock/flush", mock.flush)
    .post("/api/mock/reaction", mock.reaction)
    .get("/api/settings/:conversationId", settings.get)
    .put("/api/settings/:conversationId", settings.put)
    .get("/api/config", config.get)
    .put("/api/config/redaction", config.putRedaction)
    .get("/api/metrics", observability.metrics)
    .get("/api/audit", observability.audit)
    .get("/api/conversations", observability.conversations)
    .get("/api/conversations/:conversationId", observability.conversation)
    .get("/api/brain/graph", brain.graph)
    .get("/api/brain/suggestions", brain.suggestions)
    .post("/api/brain/note", note.submit)
    .post("/api/brain/suggestions/:id/approve", brain.approveSuggestion)
    .post("/api/brain/suggestions/:id/reject", brain.rejectSuggestion)
    .post("/api/brain/suggestions/:id/archive", brain.archiveSuggestion)
    .put("/api/brain/suggestions/:id", brain.editSuggestion);

  return router;
}
