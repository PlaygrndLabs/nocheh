// Restricted to synthetic regression fixtures for shared repository algorithms.
import {settings as runtimeSettings,secret,type Settings} from '../src/config.js';
export function settings():Settings {
  return {...runtimeSettings(),storageLayout:'legacy',databasePassword:secret('PGPASSWORD')};
}
export type {Settings} from '../src/config.js';
