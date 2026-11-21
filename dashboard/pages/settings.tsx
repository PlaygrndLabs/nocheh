/** Settings: short sections, each a tab in the address. Every edit is saved from the bottom save bar. */
import {useSettings} from '../lib/settings';
import {useSubTab, useView} from '../lib/navigation';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {LoadError, LoadingRows, Card} from '../ui/core';
import {Page, SubPanel, SubTabs, Tabs} from '../ui/page';
import {ModelSettings} from './settings/models';
import {TelegramSettings, UnsavedDot, telegramKeys} from './settings/telegram';
import {SpeedSettings, speedKeys} from './settings/speed';
import {PrivacySettings, privacyKeys} from './settings/privacy';
import {AssistantSettings} from './settings/assistant';
import {TaskSettingsPanel} from './settings/tasks';
import {ConnectionSettings} from './settings/connections';
import {GithubConnection} from './settings/github';
import {MachineSettings} from './settings/machines';
import {AdvancedSettings, advancedKeys} from './settings/advanced';
import {loadSettings} from '../lib/settings';

const views = tabIds('settings');
const labels = pageTabs.settings;
const modelKey = (key: string) =>
  /^NOCHEH_(PROVIDER|MODEL|PROVIDERS|PROVIDER_KEYS|(REPLY|MEMORY|GUARD|EMBEDDING)_(PROVIDER|MODEL))$/.test(key) ||
  key === 'OPENAI_API_KEY' ||
  key === 'ANTHROPIC_API_KEY';

const connections = ['notion', 'github'] as const;

/** Each outside service on its own sub-tab. Both stay on the page, so a sign-in that returns is finished whichever is open. */
function Connections() {
  const [tab, setTab] = useSubTab(connections);
  return (
    <>
      <SubTabs
        label="Connections"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'notion', label: 'Notion'},
          {id: 'github', label: 'GitHub'},
        ]}
      />
      <SubPanel id="notion" current={tab}>
        <ConnectionSettings />
      </SubPanel>
      <SubPanel id="github" current={tab}>
        <GithubConnection />
      </SubPanel>
    </>
  );
}

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
  else if (view === 'tasks') body = <TaskSettingsPanel />;
  else if (view === 'connections') body = <Connections />;
  else if (view === 'machines') body = <MachineSettings />;
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
      saveable
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
                <UnsavedDot show={editedIn.has(id)} />
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
