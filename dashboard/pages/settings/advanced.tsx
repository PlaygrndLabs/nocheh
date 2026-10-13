import {useSettings, type SettingsView} from '../../lib/settings';
import {settingLabel, settingLabels} from '../../lib/setting-labels';
import {Card, CardHeader, Input, SettingRow, Switch} from '../../ui/core';
import {Unsaved, telegramKeys} from './telegram';
import {speedKeys} from './speed';
import {privacyKeys} from './privacy';

const modelKey = (key: string) =>
  /^NOCHEH_(PROVIDER|MODEL|PROVIDERS|PROVIDER_KEYS|(REPLY|MEMORY|GUARD|EMBEDDING)_(PROVIDER|MODEL))$/.test(key) ||
  key === 'OPENAI_API_KEY' ||
  key === 'ANTHROPIC_API_KEY';

/** Editable settings that have no section of their own. */
export function advancedKeys(data: SettingsView | null): string[] {
  return (data?.fields ?? [])
    .filter(f => f.editable && !modelKey(f.key) && ![...telegramKeys, ...speedKeys, ...privacyKeys].includes(f.key))
    .map(f => f.key);
}

export function AdvancedSettings() {
  const s = useSettings();
  const keys = advancedKeys(s.data);
  return (
    <Card>
      <CardHeader
        title="Advanced"
        description="Rarely needed. Change these only if you know what they do."
        className="pb-3"
      />
      <div className="border-t border-line">
        {keys.map(key => {
          const field = s.field(key)!;
          return (
            <SettingRow
              key={key}
              htmlFor={'adv-' + key}
              title={
                <>
                  {settingLabel(key)}
                  <Unsaved show={s.changed(key)} />
                </>
              }
              description={settingLabels[key] ? <code className="text-xs">{key}</code> : undefined}
            >
              {['true', 'false'].includes(s.saved(key)) ? (
                <div className="flex sm:justify-end">
                  <Switch
                    id={'adv-' + key}
                    label={settingLabel(key)}
                    checked={s.value(key) === 'true'}
                    disabled={s.busy}
                    onChange={on => s.set(key, on ? 'true' : 'false')}
                  />
                </div>
              ) : (
                <Input
                  id={'adv-' + key}
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={s.value(key)}
                  placeholder={field.secret && field.configured ? '••••••••' : ''}
                  disabled={s.busy}
                  onChange={e => s.set(key, e.target.value)}
                />
              )}
            </SettingRow>
          );
        })}
      </div>
    </Card>
  );
}
