import { build } from 'esbuild';

// One local, lazy-loaded module. No remote scripts or duplicated React runtime.
await build({
  entryPoints: ['integrations/hermes/dashboard/graph-3d.js'],
  outfile: 'integrations/hermes/dashboard/dist/graph-3d.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'eof',
});
