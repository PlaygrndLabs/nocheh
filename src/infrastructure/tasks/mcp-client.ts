/** JSON value accepted by MCP tool calls. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** Minimal MCP client capability required by task-provider adapters. */
export interface McpClient {
  callTool(name: string, arguments_: Record<string, JsonValue>): Promise<JsonValue>;
}
