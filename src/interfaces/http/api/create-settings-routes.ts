import {
  createGroupAssistantSettings,
  type AssistantReplyMode,
  type CreateGroupAssistantSettingsInput,
  type MessageAnalysisMode,
} from "../../../domain/assistant/group-assistant-settings.js";
import type { ProjectHint } from "../../../domain/assistant/project-hint.js";
import type { ClockPort } from "../../../application/ports/clock.js";
import type { GroupAssistantSettingsRepositoryPort } from "../../../application/ports/group-assistant-settings-repository.js";
import type { JsonHandler } from "../router.js";

const ANALYSIS_MODES: readonly MessageAnalysisMode[] = ["immediate", "batch"];
const REPLY_MODES: readonly AssistantReplyMode[] = ["silent", "mention", "active", "digest"];
const PROJECT_HINTS: readonly ProjectHint[] = ["single", "multi"];

export interface SettingsRoutes {
  readonly get: JsonHandler;
  readonly put: JsonHandler;
}

/** Per-conversation assistant settings. GET returns defaults if none are stored. */
export function createSettingsRoutes(
  repository: GroupAssistantSettingsRepositoryPort,
  clock: ClockPort,
): SettingsRoutes {
  return {
    get: async ({ params }) => {
      const conversationId = params.conversationId ?? "";
      const stored = await repository.findByConversationId(conversationId);
      const settings = stored ?? createGroupAssistantSettings({ conversationId }, clock.now());
      return { status: 200, body: { ok: true, settings, isDefault: stored === undefined } };
    },

    put: async ({ params, body }) => {
      const conversationId = params.conversationId ?? "";
      const input = buildInput(conversationId, (body ?? {}) as Record<string, unknown>);
      const settings = createGroupAssistantSettings(input, clock.now());
      await repository.save(settings);
      return { status: 200, body: { ok: true, settings } };
    },
  };
}

function buildInput(conversationId: string, body: Record<string, unknown>): CreateGroupAssistantSettingsInput {
  return {
    conversationId,
    ...(isAnalysisMode(body.analysisMode) ? { analysisMode: body.analysisMode } : {}),
    ...(isReplyMode(body.replyMode) ? { replyMode: body.replyMode } : {}),
    ...(isProjectHint(body.projectHint) ? { projectHint: body.projectHint } : {}),
    ...numeric(body, "analysisIntervalSeconds"),
    ...numeric(body, "maxMessagesPerBatch"),
    ...numeric(body, "maxAiContextTokens"),
    ...numeric(body, "maxRetrievedMemories"),
    ...numeric(body, "maxRecentMessages"),
    ...numeric(body, "summaryEveryMessages"),
    ...numeric(body, "summaryEveryMinutes"),
  };
}

function numeric(body: Record<string, unknown>, key: string): Record<string, number> {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function isAnalysisMode(value: unknown): value is MessageAnalysisMode {
  return typeof value === "string" && (ANALYSIS_MODES as readonly string[]).includes(value);
}

function isReplyMode(value: unknown): value is AssistantReplyMode {
  return typeof value === "string" && (REPLY_MODES as readonly string[]).includes(value);
}

function isProjectHint(value: unknown): value is ProjectHint {
  return typeof value === "string" && (PROJECT_HINTS as readonly string[]).includes(value);
}
