import {useSettings} from '../../lib/settings';
import {Card, CardHeader, Input, Segmented, Select, SettingRow} from '../../ui/core';
import {Unsaved} from './telegram';

export const privacyKeys = [
  'NOCHEH_GUARD_MODE',
  'NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS',
  'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS',
];

const presets = ['0', '14', '30', '90', '180', '365'];

/** Days to keep something; 0 keeps it forever. */
function Retention({setting, label}: {setting: string; label: string}) {
  const s = useSettings();
  const value = s.value(setting) || '0';
  const custom = !presets.includes(value);
  return (
    <div className="flex gap-2">
      <Select
        id={setting}
        aria-label={label}
        value={custom ? 'custom' : value}
        disabled={s.busy}
        onChange={e => s.set(setting, e.target.value === 'custom' ? '60' : e.target.value)}
      >
        <option value="0">Forever</option>
        <option value="14">2 weeks</option>
        <option value="30">30 days</option>
        <option value="90">90 days</option>
        <option value="180">6 months</option>
        <option value="365">1 year</option>
        <option value="custom">Other…</option>
      </Select>
      {custom && (
        <Input
          aria-label={label + ' in days'}
          className="w-24"
          inputMode="numeric"
          value={value}
          disabled={s.busy}
          onChange={e => s.set(setting, e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
      )}
    </div>
  );
}

export function PrivacySettings() {
  const s = useSettings();
  const has = (key: string) => !!s.field(key);
  return (
    <>
      <Card>
        <CardHeader
          title="Secret check"
          description="Protects passwords and keys that appear in your messages."
          className="pb-3"
        />
        <div className="border-t border-line">
          <SettingRow
            title={
              <>
                Hide secrets from the assistant
                <Unsaved show={s.changed('NOCHEH_GUARD_MODE')} />
              </>
            }
            description={
              s.value('NOCHEH_GUARD_MODE') === 'off'
                ? 'Off: the assistant and memory use your original messages.'
                : 'On: the assistant and memory use a copy with secrets removed. Originals are always kept unchanged.'
            }
          >
            <div className="flex sm:justify-end">
              <Segmented
                label="Hide secrets from the assistant"
                value={s.value('NOCHEH_GUARD_MODE') === 'off' ? 'off' : 'on'}
                disabled={s.busy}
                onChange={value => s.set('NOCHEH_GUARD_MODE', value)}
                options={[
                  {value: 'on', label: 'On'},
                  {value: 'off', label: 'Off'},
                ]}
              />
            </div>
          </SettingRow>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="How long to keep records"
          description="Your messages and files are always kept. These are only Nocheh’s own work records."
          className="pb-3"
        />
        <div className="border-t border-line">
          {has('NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS') && (
            <SettingRow
              htmlFor="NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS"
              title={
                <>
                  Work history
                  <Unsaved show={s.changed('NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS')} />
                </>
              }
              description="Background work runs and reply timings. Receipts are never deleted."
            >
              <Retention setting="NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS" label="Keep work history" />
            </SettingRow>
          )}
          {has('NOCHEH_HERMES_JOURNAL_RETENTION_DAYS') && (
            <SettingRow
              htmlFor="NOCHEH_HERMES_JOURNAL_RETENTION_DAYS"
              title={
                <>
                  Delivery logs
                  <Unsaved show={s.changed('NOCHEH_HERMES_JOURNAL_RETENTION_DAYS')} />
                </>
              }
              description="Logs of replies the assistant finished sending. Unfinished ones are never deleted."
            >
              <Retention setting="NOCHEH_HERMES_JOURNAL_RETENTION_DAYS" label="Keep delivery logs" />
            </SettingRow>
          )}
        </div>
      </Card>
    </>
  );
}
