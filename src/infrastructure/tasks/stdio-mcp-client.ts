import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonValue, McpClient } from "./mcp-client.js";

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
}

/** Lightweight JSON-RPC over stdio MCP client for local MCP servers. */
export class StdioMcpClient implements McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly process: ChildProcessWithoutNullStreams;

  public constructor(command: string, args: readonly string[]) {
    this.process = spawn(command, [...args], { stdio: "pipe" });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", () => undefined);
    this.process.on("exit", (code) => {
      for (const request of this.pending.values()) {
        request.reject(new Error(`MCP process exited with code ${code ?? "unknown"}.`));
      }
      this.pending.clear();
    });
  }

  /** Calls an MCP tool through the standard `tools/call` method. */
  public async callTool(name: string, arguments_: Record<string, JsonValue>): Promise<JsonValue> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: arguments_,
      },
    };

    const promise = new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private handleLine(line: string): void {
    const response = JSON.parse(line) as JsonRpcResponse;
    if (response.id === undefined) {
      return;
    }

    const pending = this.pending.get(response.id);
    if (pending === undefined) {
      return;
    }

    this.pending.delete(response.id);
    if (response.error !== undefined) {
      pending.reject(new Error(response.error.message ?? "MCP tool call failed."));
      return;
    }
    pending.resolve(response.result ?? null);
  }
}
