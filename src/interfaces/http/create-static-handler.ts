import { readFile } from "node:fs/promises";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const ROUTE_PREFIX = "/app";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves the built single-page app under `/app`. Returns false for any other
 * path so the dev server can fall through to its 404 handler. Extensionless
 * `/app/*` paths fall back to `index.html` for client-side routing.
 */
export function createStaticHandler(
  rootDir: string,
): (request: HttpIncomingMessage, response: ServerResponse) => Promise<boolean> {
  const root = resolve(rootDir);

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path !== ROUTE_PREFIX && !path.startsWith(`${ROUTE_PREFIX}/`)) {
      return false;
    }

    const relative = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, "");
    const hasExtension = extname(relative).length > 0;
    const target = relative.length === 0 || !hasExtension ? "index.html" : relative;

    const resolved = resolve(join(root, target));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      write(response, 403, "Forbidden", "text/plain; charset=utf-8");
      return true;
    }

    try {
      const file = await readFile(resolved);
      const contentType = CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream";
      response.writeHead(200, { "content-type": contentType });
      response.end(file);
    } catch {
      // Fall back to the SPA shell for unknown extensionless paths; 404 otherwise.
      if (hasExtension) {
        write(response, 404, "Not found", "text/plain; charset=utf-8");
        return true;
      }
      try {
        const shell = await readFile(resolve(join(root, "index.html")));
        response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] as string });
        response.end(shell);
      } catch {
        write(response, 404, "Dashboard build not found. Run `npm run build:web`.", "text/plain; charset=utf-8");
      }
    }
    return true;
  };
}

function write(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}
