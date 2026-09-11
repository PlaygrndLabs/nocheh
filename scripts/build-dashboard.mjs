import { build } from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';

// One local, lazy-loaded module. No remote scripts or duplicated React runtime.
await build({
  entryPoints: ['integrations/hermes/dashboard/graph-3d.js'],
  outfile: 'integrations/hermes/dashboard/dist/graph-3d.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
await mkdir('web/dist',{recursive:true});
await build({entryPoints:['web/app.js'],outfile:'web/dist/app.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await copyFile('web/style.css','web/dist/style.css');
await copyFile('web/index.html','web/dist/index.html');
await copyFile('integrations/hermes/dashboard/dist/graph-3d.js','web/dist/graph-3d.js');
