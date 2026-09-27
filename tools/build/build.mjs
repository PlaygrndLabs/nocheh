import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import './build-dashboard.mjs';
if (process.env.NOCHEH_DEV_BUILD !== '1') rmSync(new URL('../../dist', import.meta.url), {recursive: true, force: true});
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {stdio: 'inherit'});
process.exit(result.status ?? 1);
