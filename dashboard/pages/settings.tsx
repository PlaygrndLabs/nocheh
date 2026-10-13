/** Settings: short sections, each a tab in the address. Every edit is saved from the bottom save bar. */
import {useSettings} from '../lib/settings';
import {useView} from '../lib/navigation';
import {LoadError, LoadingRows, Card} from '../ui/core';
import {Page, Tabs} from '../ui/page';
import {ModelSettings} from './settings/models';
import {TelegramSettings, telegramKeys} from './settings/telegram';
import {SpeedSettings, speedKeys} from './settings/speed';
import {PrivacySettings, privacyKeys} from './settings/privacy';
import {AssistantSettings} from './settings/assistant';
import {AdvancedSettings, advancedKeys} from './settings/advanced';
import {loadSettings} from '../lib/settings';

const views = ['telegram', 'models', 'speed', 'privacy', 'assistant', 'advanced'] as const;
const labels: Record<(typeof views)[number], string> = {
  telegram: 'Telegram',
  models: 'Models',
  speed: 'Speed',
  privacy: 'Privacy & data',
  assistant: 'Assistant',
  advanced: 'Advanced',
};
const modelKey = (key: string) =>
  /^NOCHEH_(PROVIDER|MODEL|PROVIDERS|PROVIDER_KEYS|(REPLY|MEMORY|GUARD|EMBEDDING)_(PROVIDER|MODEL))$/.test(key) ||
  key === 'OPENAI_API_KEY' ||
  key === 'ANTHROPIC_API_KEY';

export default function Settings() {
  const [view, setView] = useView(views);
  const settings = useSettings();
  const edited = Object.keys(settings.changes);
  const sectionOf = (key: string): (typeof views)[number] =>
    modelKey(key)
      ? 'models'
      : telegramKeys.includes(key)
        ? 'telegram'
        : speedKeys.includes(key)
          ? 'speed'
          : privacyKeys.includes(key)
            ? 'privacy'
            : advancedKeys(settings.data).includes(key)
              ? 'advanced'
              : 'telegram';
  const editedIn = new Set(edited.map(sectionOf));

  let body: React.ReactNode;
  if (view === 'assistant') body = <AssistantSettings />;
  else if (!settings.data)
    body = settings.error ? (
      <LoadError what="settings" onRetry={() => void loadSettings()} />
    ) : (
      <Card>
        <LoadingRows rows={4} />
      </Card>
    );
  else
    body = (
      <>
        {settings.error && <LoadError what="the latest settings" onRetry={() => void loadSettings()} />}
        {view === 'telegram' && <TelegramSettings />}
        {view === 'models' && <ModelSettings />}
        {view === 'speed' && <SpeedSettings />}
        {view === 'privacy' && <PrivacySettings />}
        {view === 'advanced' && <AdvancedSettings />}
      </>
    );

  return (
    <Page
      title="Settings"
      tabs={
        <Tabs
          label="Settings sections"
          value={view}
          onChange={setView}
          tabs={views.map(id => ({
            id,
            label: (
              <>
                {labels[id]}
                {editedIn.has(id) && <span aria-label="(unsaved)" className="size-1.5 rounded-full bg-warn" />}
              </>
            ),
          }))}
        />
      }
    >
      {body}
    </Page>
  );
}
