import { readFileSync } from 'node:fs';

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
  return {
    service: service as Service, host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8780),
    token: secret('SERVICE_TOKEN'), databasePassword: secret('PGPASSWORD'),
    dataDir: process.env.NOCHEH_DATA_DIR ?? '/data',
    hermesUrl: process.env.HERMES_URL ?? 'http://hermes:8781',
    guardMode: mode as 'off' | 'on' | 'auto',
  };
}
export type Settings = ReturnType<typeof settings>;
