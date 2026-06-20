import { Buffer } from "node:buffer";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";

/** Parsed request passed to a JSON route handler. */
export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly raw: HttpIncomingMessage;
}

/** Result returned by a JSON route handler. */
export interface JsonResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export type JsonHandler = (context: RequestContext) => Promise<JsonResult> | JsonResult;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: JsonHandler;
}

/** Minimal method + path router for JSON endpoints on the raw http server. */
export class Router {
  private readonly routes: Route[] = [];

  public get(pattern: string, handler: JsonHandler): this {
    return this.add("GET", pattern, handler);
  }

  public post(pattern: string, handler: JsonHandler): this {
    return this.add("POST", pattern, handler);
  }

  public put(pattern: string, handler: JsonHandler): this {
    return this.add("PUT", pattern, handler);
  }

  /** Matches and dispatches a request. Returns false when no route matched. */
  public async handle(request: HttpIncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const segments = splitPath(path);

    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }
      const params = matchSegments(route.segments, segments);
      if (params === undefined) {
        continue;
      }

      try {
        const body = await parseBody(request);
        const result = await route.handler({ method, path, params, query: url.searchParams, body, raw: request });
        write(response, result.status, result.body, result.headers);
      } catch (error) {
        write(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    return false;
  }

  private add(method: string, pattern: string, handler: JsonHandler): this {
    this.routes.push({ method, segments: splitPath(pattern), handler });
    return this;
  }
}

function splitPath(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Returns extracted params when the route matches, otherwise undefined. */
function matchSegments(
  routeSegments: readonly string[],
  requestSegments: readonly string[],
): Record<string, string> | undefined {
  if (routeSegments.length !== requestSegments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index];
    const requestSegment = requestSegments[index];
    if (routeSegment === undefined || requestSegment === undefined) {
      return undefined;
    }

    if (routeSegment.startsWith(":")) {
      params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
      continue;
    }

    if (routeSegment !== requestSegment) {
      return undefined;
    }
  }
  return params;
}

async function parseBody(request: HttpIncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw);
}

function write(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
