/** Home's "Get started" list: what a new installation still needs, read from the saved settings. */
import {href} from './routes';
import type {SettingsView} from './settings';

export type SetupStep = {
  id: 'model' | 'key' | 'token' | 'owner' | 'telegram';
  title: string;
  /** What to do, or what is missing until it's done. */
  detail: string;
  done: boolean;
  /** Nocheh works without it, but only in part. */
  warning?: boolean;
  action: string;
  link: string;
};

export function setupSteps(view: SettingsView): SetupStep[] {
  const field = (key: string) => view.fields.find(f => f.key === key);
  const saved = (key: string) => field(key)?.value ?? '';
  const providers = view.providers?.list ?? [];
  const name = (id: string) => providers.find(p => p.id === id)?.name ?? id;
  const hasKey = (id: string) => providers.find(p => p.id === id)?.has_key === true;
  const models = href('settings', {view: 'models'});
  const telegram = href('settings', {view: 'telegram'});

  // A part without its own provider uses the main one.
  const main = saved('NOCHEH_PROVIDER');
  const model = (view.providers?.parts ?? []).every(part => !!(saved(part.provider_setting) || main));

  // Memory search and voice notes name their own provider, OpenAI unless changed.
  const search = saved('NOCHEH_EMBEDDING_PROVIDER') || 'openai';
  const voice = saved('NOCHEH_TRANSCRIPTION_PROVIDER') || 'openai';
  const searchKey = hasKey(search);
  const voiceKey = hasKey(voice);
  // Name only the keys still missing; once none is, the providers in use.
  const missing = [...new Set([searchKey ? '' : search, voiceKey ? '' : voice].filter(Boolean))];
  const names = (missing.length ? missing : [...new Set([search, voice])]).map(name);
  const keyTitle =
    names.length === 1
      ? `Add ${/^[aeiou]/i.test(names[0]!) ? 'an' : 'a'} ${names[0]} key`
      : `Add ${names.join(' and ')} keys`;

  return [
    {
      id: 'model',
      title: 'Choose a model',
      detail:
        'Add a provider and choose the model Nocheh answers with. Until then, messages are kept and answered later.',
      done: model,
      action: 'Choose a model',
      link: models,
    },
    {
      id: 'key',
      title: keyTitle,
      detail:
        !searchKey && !voiceKey
          ? search === voice
            ? 'Memory search and voice notes need it. Until then, voice notes are only kept, not turned into text.'
            : `Memory search needs the ${name(search)} key and voice notes the ${name(voice)} key. Until then, voice notes are only kept, not turned into text.`
          : !searchKey
            ? 'Memory search needs it.'
            : 'Voice notes need it. Until then, they are only kept, not turned into text.',
      done: searchKey && voiceKey,
      warning: true,
      action: 'Add the key',
      link: models,
    },
    {
      id: 'token',
      title: 'Connect your Telegram bot',
      detail: 'Create a bot with @BotFather in Telegram, then paste its token and save.',
      done: !!field('TELEGRAM_BOT_TOKEN')?.configured,
      action: 'Add the token',
      link: telegram,
    },
    {
      id: 'owner',
      title: 'Add your Telegram ID',
      detail: 'Send your bot any message in Telegram, then press Find my ID. Only you can manage Nocheh.',
      done: !!saved('TELEGRAM_OWNER_ID'),
      action: 'Find my ID',
      link: telegram,
    },
    {
      id: 'telegram',
      title: 'Turn Telegram on',
      detail: 'Nocheh receives and answers your Telegram messages once it’s on.',
      done: saved('TELEGRAM_ENABLED') === 'true',
      action: 'Turn it on',
      link: telegram,
    },
  ];
}
