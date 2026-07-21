import type { JsonHandler, JsonResult } from "../router.js";
import { SessionAuth } from "../auth/session-auth.js";

export function createAuthRoutes(auth: SessionAuth): {
  readonly status: JsonHandler;
  readonly login: JsonHandler;
  readonly logout: JsonHandler;
} {
  return {
    status: (context): JsonResult => ({
      status: 200,
      body: { ok: true, ...auth.status(context.raw) },
    }),
    login: (context): JsonResult => {
      if (!auth.isConfigured()) {
        return { status: 503, body: { ok: false, error: "App auth is not configured" } };
      }
      const body = isRecord(context.body) ? context.body : {};
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!auth.verifyCredentials(username, password)) {
        return { status: 401, body: { ok: false, error: "Invalid username or password" } };
      }
      return {
        status: 200,
        body: { ok: true, username },
        headers: { "set-cookie": auth.createCookie(username) },
      };
    },
    logout: (): JsonResult => ({
      status: 200,
      body: { ok: true },
      headers: { "set-cookie": auth.clearCookie() },
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
