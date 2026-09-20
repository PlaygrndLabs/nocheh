import { readFileSync } from 'node:fs';
import { DEFAULT_TRUSTED, DETECTOR_VERSION } from './guard.js';
import { assistantPolicy } from './assistant-policy.js';
import {storageLayout} from './stores/config.js';

export function secret(name: string): string {
  const path = process.env[`${name}_FILE`];
  const value = process.env[name]?.trim() ?? (path ? readFileSync(path, 'utf8').trim() : undefined);
  if (!value || value.length < 24) throw new Error(`Missing or short ${name}`);
  return value;
}

export type Service = 'nocheh-app';
export function settings() {
  const layout=storageLayout();
  const service = process.env.NOCHEH_SERVICE ?? 'nocheh-app';
  if (service!=='nocheh-app') throw new Error('Invalid service');
  const mode = process.env.GUARD_MODE === 'auto' ? 'on' : process.env.GUARD_MODE ?? 'on';
  if (!['off', 'on'].includes(mode)) throw new Error('Invalid guard mode');
  const trusted:unknown=JSON.parse(process.env.GUARD_TRUSTED_ENDPOINTS ?? JSON.stringify(DEFAULT_TRUSTED));
  if (!Array.isArray(trusted) || trusted.some(v=>typeof v!=='string' || !['http:','https:'].includes(new URL(v).protocol))) throw new Error('Invalid trusted endpoints');
  return {
    service: service as Service, host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8780),
    token: secret('SERVICE_TOKEN'), databasePassword: layout==='legacy'?secret('PGPASSWORD'):'',storageLayout:layout,
    dataDir: process.env.NOCHEH_DATA_DIR ?? '/data',
    hermesUrl: process.env.HERMES_URL ?? 'http://hermes:8781',
    honchoUrl:process.env.HONCHO_URL??'http://honcho-api:8000',
    memoryToken:process.env.NOCHEH_MEMORY_TOKEN??'',
    guardMode: mode as 'off' | 'on',
    guardTrusted:trusted as string[],detectorVersion:`${DETECTOR_VERSION}:${process.env.NOCHEH_MODEL ?? 'gpt-5.6-sol'}`,
    assistant:assistantPolicy(process.env.ASSISTANT_POLICY_FILE),
  };
}
export type Settings = ReturnType<typeof settings>;
