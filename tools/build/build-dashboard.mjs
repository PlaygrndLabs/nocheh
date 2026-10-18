import { build } from 'esbuild';
import {mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

if (process.env.NOCHEH_DEV_BUILD !== '1') await rm('dashboard/dist',{recursive:true,force:true});
await mkdir('dashboard/dist',{recursive:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.dashboard.json'],{stdio:'inherit'});
execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','dashboard/tailwind.css','-o','dashboard/dist/tailwind.css','--minify'],{stdio:'inherit'});
await build({entryPoints:{app:'dashboard/app.tsx'},tsconfig:'tsconfig.dashboard.json',outdir:'dashboard/dist',chunkNames:'chunks/[name]-[hash]',splitting:true,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await copyFile('dashboard/dist/tailwind.css','dashboard/dist/style.css');
await copyFile('dashboard/index.html','dashboard/dist/index.html');
