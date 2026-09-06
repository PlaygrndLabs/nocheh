import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function authorize(req: IncomingMessage, token: string): void {
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(req.headers.authorization ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'unauthorized');
}
export async function readJson(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > max) throw new HttpError(413, 'body_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'invalid_json'); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'expected_object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 100000): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'invalid_string');
  return value;
}
export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
}
