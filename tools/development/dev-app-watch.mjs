// Run the app and rebuild generated assets inside its existing Compose service. The app starts after the first
// finished build, restarts after each later one, and starts again if it exits on its own (dev-node-run.mjs).
import {readdir, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {DevProcess} from './dev-node-run.mjs';

const inputs = ['src', 'test', 'dashboard', 'tools/build/build.mjs',
  'tools/build/build-dashboard.mjs', 'tsconfig.json', 'tsconfig.dashboard.json'];
const excluded = new Set(['dist', '__pycache__', 'node_modules']);
let stopping = false;
const app = new DevProcess(['dist/src/main.js'], {name: 'Development app'});

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

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  void app.stop();
});
let previous = '';
while (!stopping) {
  try {
    const current = await snapshot();
    if (current !== previous) {
      previous = current;
      if (await build()) {
        const revision = `${Date.now()}\n`;
        await writeFile('dashboard/dist/.dev-revision', revision);
        await writeFile('dist/.dev-ready', revision);
        console.log(`Development assets ready: ${revision.trim()}`);
        await app.restart();
      } else console.error('Development build failed; the app keeps running the last finished build.');
    }
  } catch (error) { console.error('Development source scan failed:', error); }
  await new Promise(resolve => setTimeout(resolve, 750));
}
