import test from "node:test";
import assert from "node:assert/strict";
import { SessionAuth } from "../src/interfaces/http/auth/session-auth.js";
import { createAuthRoutes } from "../src/interfaces/http/api/create-auth-routes.js";
import type { RequestContext } from "../src/interfaces/http/router.js";

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    method: "GET",
    path: "/",
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    raw: { headers: {} } as RequestContext["raw"],
    ...overrides,
  };
}

test("auth routes issue and verify a private app session", async () => {
  const auth = new SessionAuth({
    username: "mak",
    password: "secret-password",
    sessionSecret: "test-session-secret",
    secureCookie: false,
  });
  const routes = createAuthRoutes(auth);

  const login = await routes.login(context({
    method: "POST",
    body: { username: "mak", password: "secret-password" },
  }));

  assert.equal(login.status, 200);
  const cookie = login.headers?.["set-cookie"];
  assert.match(cookie ?? "", /nocheh_session=/);
  assert.match(cookie ?? "", /HttpOnly/);

  const status = await routes.status(context({
    raw: { headers: { cookie } } as RequestContext["raw"],
  }));

  assert.equal(status.status, 200);
  assert.equal((status.body as { authenticated: boolean }).authenticated, true);
  assert.equal((status.body as { username: string }).username, "mak");
});

test("auth routes reject bad credentials and unconfigured auth", async () => {
  const configured = createAuthRoutes(new SessionAuth({
    username: "mak",
    password: "secret-password",
    sessionSecret: "test-session-secret",
    secureCookie: false,
  }));

  const badLogin = await configured.login(context({
    method: "POST",
    body: { username: "mak", password: "wrong" },
  }));
  assert.equal(badLogin.status, 401);

  const unconfigured = createAuthRoutes(new SessionAuth({
    sessionSecret: "test-session-secret",
    secureCookie: false,
  }));
  const missingConfig = await unconfigured.login(context({
    method: "POST",
    body: { username: "mak", password: "secret-password" },
  }));
  assert.equal(missingConfig.status, 503);
});
