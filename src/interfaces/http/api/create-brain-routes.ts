import { SuggestionService } from "../../../application/services/suggestion-service.js";
import type { MemoryGraphRepositoryPort } from "../../../application/ports/memory-graph-repository.js";
import type { SuggestionRepositoryPort } from "../../../application/ports/suggestion-repository.js";
import type { Suggestion } from "../../../domain/memory/strategic-suggestion.js";
import type { JsonHandler, JsonResult, RequestContext } from "../router.js";

export function createBrainRoutes(
  graphRepository: MemoryGraphRepositoryPort,
  suggestionRepository: SuggestionRepositoryPort,
): {
  readonly graph: JsonHandler;
  readonly suggestions: JsonHandler;
  readonly approveSuggestion: JsonHandler;
  readonly rejectSuggestion: JsonHandler;
  readonly archiveSuggestion: JsonHandler;
  readonly editSuggestion: JsonHandler;
} {
  const service = new SuggestionService(suggestionRepository);

  return {
    graph: async (): Promise<JsonResult> => {
      const nodes = await graphRepository.listNodes();
      const edgeMap = new Map<string, Awaited<ReturnType<typeof graphRepository.listEdgesForNode>>[number]>();
      for (const node of nodes) {
        for (const edge of await graphRepository.listEdgesForNode(node.id)) {
          edgeMap.set(edge.id, edge);
        }
      }
      return { status: 200, body: { nodes, edges: [...edgeMap.values()] } };
    },
    suggestions: async (context): Promise<JsonResult> => {
      const status = context.query.get("status");
      const suggestions = status === null
        ? await suggestionRepository.findPending()
        : await suggestionRepository.findByStatus(status as Suggestion["status"]);
      return { status: 200, body: { suggestions } };
    },
    approveSuggestion: async (context): Promise<JsonResult> => {
      const suggestion = await service.accept(requiredParam(context, "id"));
      return { status: 200, body: { suggestion } };
    },
    rejectSuggestion: async (context): Promise<JsonResult> => {
      const suggestion = await service.reject(requiredParam(context, "id"));
      return { status: 200, body: { suggestion } };
    },
    archiveSuggestion: async (context): Promise<JsonResult> => {
      const suggestion = await service.archive(requiredParam(context, "id"));
      return { status: 200, body: { suggestion } };
    },
    editSuggestion: async (context): Promise<JsonResult> => {
      const current = await suggestionRepository.findById(requiredParam(context, "id"));
      if (current === undefined) {
        return { status: 404, body: { ok: false, error: "Suggestion not found" } };
      }
      const body = isRecord(context.body) ? context.body : {};
      const updated: Suggestion = {
        ...current,
        ...(typeof body.title === "string" && body.title.trim().length > 0 ? { title: body.title.trim() } : {}),
        ...(typeof body.rationale === "string" && body.rationale.trim().length > 0 ? { rationale: body.rationale.trim() } : {}),
        ...(body.riskLevel === "low" || body.riskLevel === "medium" || body.riskLevel === "high" ? { riskLevel: body.riskLevel } : {}),
        updatedAt: new Date(),
      };
      await suggestionRepository.save(updated);
      return { status: 200, body: { suggestion: updated } };
    },
  };
}

function requiredParam(context: RequestContext, key: string): string {
  const value = context.params[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing route param: ${key}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
