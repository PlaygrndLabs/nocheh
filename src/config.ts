import { readFileSync } from 'node:fs';
import { DEFAULT_TRUSTED, DETECTOR_VERSION } from './guard.js';
import { assistantPolicy } from './assistant-policy.js';

export function secret(name: string): string {
  const path = process.env[`${name}_FILE`];
  const value = path ? readFileSync(path, 'utf8').trim() : process.env[name]?.trim();
  if (!value || value.length < 24) throw new Error(`Missing or short ${name}`);
  return value;
}

export type Service = 'archive' | 'worker' | 'guard';
export function settings() {
  const service = process.env.NOCHEH_SERVICE ?? 'archive';
  if (!['archive', 'worker', 'guard'].includes(service)) throw new Error('Invalid service');
  const mode = process.env.GUARD_MODE ?? 'auto';
  if (!['off', 'on', 'auto'].includes(mode)) throw new Error('Invalid guard mode');
  const trusted:unknown=JSON.parse(process.env.GUARD_TRUSTED_ENDPOINTS ?? JSON.stringify(DEFAULT_TRUSTED));
  if (!Array.isArray(trusted) || trusted.some(v=>typeof v!=='string' || !['http:','https:'].includes(new URL(v).protocol))) throw new Error('Invalid trusted endpoints');
  return {
    service: service as Service, host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8780),
    token: secret('SERVICE_TOKEN'), databasePassword: secret('PGPASSWORD'),
    dataDir: process.env.NOCHEH_DATA_DIR ?? '/data',
    hermesUrl: process.env.HERMES_URL ?? 'http://hermes:8781',
    guardMode: mode as 'off' | 'on' | 'auto',
    guardTrusted:trusted as string[],detectorVersion:`${DETECTOR_VERSION}:${process.env.NOCHEH_MODEL ?? 'gpt-5.6-sol'}`,
    assistant:assistantPolicy(process.env.ASSISTANT_POLICY_FILE),
  };
}
export type Settings = ReturnType<typeof settings>;
