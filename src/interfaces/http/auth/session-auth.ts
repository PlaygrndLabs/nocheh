import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage as HttpIncomingMessage } from "node:http";

const COOKIE_NAME = "nocheh_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface SessionAuthConfig {
  readonly username?: string;
  readonly password?: string;
  readonly sessionSecret: string;
  readonly secureCookie: boolean;
}

export interface AuthSessionStatus {
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly username?: string;
}

interface SessionPayload {
  readonly sub: string;
  readonly exp: number;
  readonly nonce: string;
}

/** Single-owner session auth for the local/private dashboard API. */
export class SessionAuth {
  public constructor(private readonly config: SessionAuthConfig) {}

  public status(request: HttpIncomingMessage): AuthSessionStatus {
    const configured = this.isConfigured();
    if (!configured) {
      return { configured, authenticated: false };
    }
    const username = this.verifyRequest(request);
    return {
      configured,
      authenticated: username !== undefined,
      ...(username === undefined ? {} : { username }),
    };
  }

  public isConfigured(): boolean {
    return hasText(this.config.username) && hasText(this.config.password) && hasText(this.config.sessionSecret);
  }

  public verifyCredentials(username: string, password: string): boolean {
    if (!this.isConfigured()) {
      return false;
    }
    return timingSafeStringEqual(username, this.config.username ?? "")
      && timingSafeStringEqual(password, this.config.password ?? "");
  }

  public verifyRequest(request: HttpIncomingMessage): string | undefined {
    if (!this.isConfigured()) {
      return undefined;
    }
    const token = parseCookies(request.headers.cookie ?? "")[COOKIE_NAME];
    if (token === undefined) {
      return undefined;
    }
    return this.verifyToken(token);
  }

  public createCookie(username: string): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: username,
      exp: now + MAX_AGE_SECONDS,
      nonce: randomBytes(12).toString("base64url"),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(encodedPayload);
    return cookieHeader(`${encodedPayload}.${signature}`, MAX_AGE_SECONDS, this.config.secureCookie);
  }

  public clearCookie(): string {
    return cookieHeader("", 0, this.config.secureCookie);
  }

  private verifyToken(token: string): string | undefined {
    const [encodedPayload, signature] = token.split(".");
    if (encodedPayload === undefined || signature === undefined || this.sign(encodedPayload) !== signature) {
      return undefined;
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      return undefined;
    }
    if (!hasText(payload.sub) || !Number.isInteger(payload.exp)) {
      return undefined;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return undefined;
    }
    return payload.sub;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(payload).digest("base64url");
  }
}

export function unauthorized(): { readonly status: number; readonly body: unknown } {
  return { status: 401, body: { ok: false, error: "Authentication required" } };
}

export function authNotConfigured(): { readonly status: number; readonly body: unknown } {
  return { status: 503, body: { ok: false, error: "App auth is not configured" } };
}

function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${securePart}`;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
