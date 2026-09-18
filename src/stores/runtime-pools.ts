import {connectStores} from './connections.js';
import {storageConfiguration} from './config.js';

/** Runtime processes never receive or use the installation administrator login. */
export function runtimeStores(env:NodeJS.ProcessEnv=process.env) {
  if(env.PGPASSWORD||env.PGPASSWORD_FILE||env.INNGEST_POSTGRES_PASSWORD||env.INNGEST_POSTGRES_PASSWORD_FILE)throw Error('bootstrap_credential_not_allowed');
  const {connection,passwords}=storageConfiguration(env);return connectStores(connection,passwords);
}
