// Rebuild generated assets inside the development Compose project, without
// rebuilding images or requiring a host Node installation.
import {readdir, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

const inputs = ['src', 'web', 'integrations/hermes/dashboard', 'scripts/build.mjs',
  'scripts/build-dashboard.mjs', 'tsconfig.json', 'tsconfig.web.json'];
const excluded = new Set(['dist', '__pycache__', 'node_modules']);
let stopping = false;

async function snapshot() {
  const files = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path, {withFileTypes: true})) {
        if (!excluded.has(entry.name) && !entry.name.startsWith('.'))
          await visit(`${path}/${entry.name}`);
      }
    } else if (info.isFile()) {
      files.push(`${path}:${info.size}:${info.mtimeMs}`);
    }
  }
  for (const path of inputs) await visit(path);
  return files.sort().join('\n');
}

function build() {
  return new Promise(resolve => {
    const child = spawn('npm', ['run', 'build'], {
      env: {...process.env, NOCHEH_DEV_BUILD: '1'}, stdio: 'inherit',
    });
    child.on('error', error => { console.error(error); resolve(false); });
    child.on('exit', code => resolve(code === 0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
let previous = '';
while (!stopping) {
  try {
    const current = await snapshot();
    if (current !== previous) {
      previous = current;
      if (await build()) {
        const revision = `${Date.now()}\n`;
        await writeFile('web/dist/.dev-revision', revision);
        await writeFile('dist/.dev-ready', revision);
        console.log(`Development assets ready: ${revision.trim()}`);
      } else console.error('Development build failed; waiting for a source fix.');
    }
  } catch (error) { console.error('Development source scan failed:', error); }
  await new Promise(resolve => setTimeout(resolve, 750));
}
