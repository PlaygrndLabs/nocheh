import { build } from 'esbuild';
import {mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

// One local, lazy-loaded module. No remote scripts or duplicated React runtime.
await build({
  entryPoints: ['services/hermes/dashboard/graph-3d.js'],
  outfile: 'services/hermes/dashboard/dist/graph-3d.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
if (process.env.NOCHEH_DEV_BUILD !== '1') await rm('dashboard/dist',{recursive:true,force:true});
await mkdir('dashboard/dist',{recursive:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.dashboard.json'],{stdio:'inherit'});
execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','dashboard/tailwind.css','-o','dashboard/dist/tailwind.css','--minify'],{stdio:'inherit'});
await build({entryPoints:{app:'dashboard/app.tsx'},tsconfig:'tsconfig.dashboard.json',outdir:'dashboard/dist',chunkNames:'chunks/[name]-[hash]',splitting:true,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await writeFile('dashboard/dist/style.css',(await readFile('dashboard/dist/tailwind.css','utf8'))+'\n'+await readFile('dashboard/style.css','utf8'));
await copyFile('dashboard/index.html','dashboard/dist/index.html');
await copyFile('services/hermes/dashboard/dist/graph-3d.js','dashboard/dist/graph-3d.js');
