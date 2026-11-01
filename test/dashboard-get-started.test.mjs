import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  entryPoints: ['dashboard/lib/get-started.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {setupSteps} = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

const parts = ['REPLY', 'MEMORY', 'GUARD'].map(name => ({
  id: name.toLowerCase(),
  provider_setting: `NOCHEH_${name}_PROVIDER`,
}));
function view(values, keys = {}, configured = {}) {
  return {
    fields: Object.entries(values).map(([key, value]) => ({key, value, configured: !!configured[key]})),
    providers: {
      list: [
        {id: 'openai', name: 'OpenAI', has_key: !!keys.openai},
        {id: 'anthropic', name: 'Anthropic', has_key: !!keys.anthropic},
        {id: 'gateway', name: 'Gateway', has_key: !!keys.gateway},
      ],
      parts,
    },
  };
}
const byId = steps => Object.fromEntries(steps.map(step => [step.id, step]));

test('a fresh installation has every step open, and the key step is a warning', () => {
  const steps = setupSteps(view({TELEGRAM_ENABLED: 'false', TELEGRAM_OWNER_ID: ''}));
  assert.deepEqual(
    steps.map(step => step.id),
    ['model', 'key', 'token', 'owner', 'telegram'],
  );
  assert.ok(steps.every(step => !step.done));
  assert.equal(byId(steps).key.title, 'Add an OpenAI key');
  assert.equal(byId(steps).key.warning, true);
});

test('the main model covers every part, and a part of its own counts too', () => {
  assert.equal(byId(setupSteps(view({NOCHEH_PROVIDER: 'anthropic'}))).model.done, true);
  assert.equal(byId(setupSteps(view({NOCHEH_REPLY_PROVIDER: 'anthropic'}))).model.done, false);
  assert.equal(
    byId(setupSteps(view({NOCHEH_REPLY_PROVIDER: 'a', NOCHEH_MEMORY_PROVIDER: 'a', NOCHEH_GUARD_PROVIDER: 'a'}))).model
      .done,
    true,
  );
});

test('the key step follows the providers memory search and voice notes use', () => {
  const custom = byId(setupSteps(view({NOCHEH_EMBEDDING_PROVIDER: 'gateway'}, {openai: true}))).key;
  // Only the missing key is asked for.
  assert.equal(custom.title, 'Add a Gateway key');
  assert.equal(custom.detail, 'Memory search needs it.');
  assert.equal(custom.done, false);
  const voice = byId(setupSteps(view({NOCHEH_EMBEDDING_PROVIDER: 'gateway'}, {gateway: true}))).key;
  assert.equal(voice.title, 'Add an OpenAI key');
  assert.match(voice.detail, /^Voice notes need it/);
  const both = byId(setupSteps(view({NOCHEH_EMBEDDING_PROVIDER: 'gateway'}))).key;
  assert.equal(both.title, 'Add Gateway and OpenAI keys');
  assert.match(both.detail, /^Memory search needs the Gateway key and voice notes the OpenAI key\./);
  assert.equal(byId(setupSteps(view({}, {openai: true}))).key.done, true);
});

test('Telegram steps read the saved token, owner ID and switch', () => {
  const steps = byId(
    setupSteps(
      view(
        {TELEGRAM_BOT_TOKEN: null, TELEGRAM_OWNER_ID: '42', TELEGRAM_ENABLED: 'true'},
        {},
        {TELEGRAM_BOT_TOKEN: true},
      ),
    ),
  );
  assert.equal(steps.token.done, true);
  assert.equal(steps.owner.done, true);
  assert.equal(steps.telegram.done, true);
  assert.equal(steps.owner.link, '#settings?view=telegram');
});
