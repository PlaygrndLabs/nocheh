import type { ExternalTask, TaskProviderPort } from "../../application/ports/task-provider.js";
import type { Task } from "../../domain/tasks/task.js";
import type { JsonValue, McpClient } from "./mcp-client.js";

/** Configuration for mapping internal tasks into a Notion MCP tool call. */
export interface NotionMcpTaskProviderConfig {
  readonly providerName: "notion";
  readonly createToolName: string;
  readonly updateToolName: string;
  readonly databaseId: string;
}

/** Task provider that synchronizes tasks by calling Notion MCP tools. */
export class NotionMcpTaskProvider implements TaskProviderPort {
  public constructor(
    private readonly client: McpClient,
    private readonly config: NotionMcpTaskProviderConfig,
  ) {}

  /** Creates or updates a Notion task page and returns provider sync state. */
  public async upsertTask(task: Task, existing?: ExternalTask): Promise<ExternalTask> {
    const payload = this.toPayload(task, existing);
    const result = await this.client.callTool(
      existing === undefined ? this.config.createToolName : this.config.updateToolName,
      payload,
    );

    const externalId = this.extractExternalId(result) ?? existing?.externalId;
    if (externalId === undefined) {
      throw new Error("Notion MCP response did not include an external task id.");
    }

    return {
      provider: this.config.providerName,
      externalId,
      taskId: task.id,
    };
  }

  private toPayload(task: Task, existing?: ExternalTask): Record<string, JsonValue> {
    return {
      databaseId: this.config.databaseId,
      ...(existing === undefined ? {} : { pageId: existing.externalId }),
      task: {
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status: task.status,
        priority: task.priority,
        assignee: task.assignee ?? null,
        dueAt: task.dueAt?.toISOString() ?? null,
        source: {
          platform: task.source.platform,
          conversationId: task.source.conversationId,
          messageId: task.source.messageId,
          occurredAt: task.source.occurredAt.toISOString(),
        },
      },
    };
  }

  private extractExternalId(result: JsonValue): string | undefined {
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      return undefined;
    }
    const id = result.id ?? result.pageId ?? result.externalId;
    return typeof id === "string" ? id : undefined;
  }
}
