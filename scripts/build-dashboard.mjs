import { build } from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

// One local, lazy-loaded module. No remote scripts or duplicated React runtime.
await build({
  entryPoints: ['integrations/hermes/dashboard/graph-3d.js'],
  outfile: 'integrations/hermes/dashboard/dist/graph-3d.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
await mkdir('web/dist',{recursive:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.web.json'],{stdio:'inherit'});
execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','web/tailwind.css','-o','web/dist/tailwind.css','--minify'],{stdio:'inherit'});
await build({entryPoints:{app:'web/app.tsx'},tsconfig:'tsconfig.web.json',outdir:'web/dist',chunkNames:'chunks/[name]-[hash]',splitting:true,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await writeFile('web/dist/style.css',(await readFile('web/dist/tailwind.css','utf8'))+'\n'+await readFile('web/style.css','utf8'));
await copyFile('web/index.html','web/dist/index.html');
await copyFile('integrations/hermes/dashboard/dist/graph-3d.js','web/dist/graph-3d.js');
