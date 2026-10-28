import {useSettings} from '../../lib/settings';
import {Button, Card, CardHeader, Input, Segmented, Select, SettingRow} from '../../ui/core';
import {Unsaved} from './telegram';

export const privacyKeys = [
  'NOCHEH_GUARD_MODE',
  'NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS',
  'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS',
  'NOCHEH_BACKUP_SCHEDULE',
  'NOCHEH_BACKUP_TIME',
  'NOCHEH_BACKUP_TIME_ZONE',
  'NOCHEH_BACKUP_KEEP',
];

const keepPresets = ['3', '7', '14', '30'];

function zones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch {
    return ['UTC'];
  }
}

/** Daily automatic backups: on or off, the time and time zone they run at, and how many to keep. */
function BackupSettings() {
  const s = useSettings();
  const on = (s.value('NOCHEH_BACKUP_SCHEDULE') || 'daily') === 'daily';
  const zone = s.value('NOCHEH_BACKUP_TIME_ZONE') || 'UTC';
  const keep = s.value('NOCHEH_BACKUP_KEEP') || '7';
  const customKeep = !keepPresets.includes(keep);
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changed = (...keys: string[]) => keys.some(key => s.changed(key));
  return (
    <Card>
      <CardHeader
        title="Automatic backups"
        description="A full backup on this machine every day, like Back up now in System › Backups. Saving new messages pauses for a moment while it runs."
        className="pb-3"
      />
      <div className="border-t border-line">
        <SettingRow
          title={
            <>
              Back up every day
              <Unsaved show={changed('NOCHEH_BACKUP_SCHEDULE')} />
            </>
          }
          description={on ? 'On: one backup a day at the time below.' : 'Off: backups run only when you start them.'}
        >
          <div className="flex sm:justify-end">
            <Segmented
              label="Back up every day"
              value={on ? 'daily' : 'off'}
              disabled={s.busy}
              onChange={value => s.set('NOCHEH_BACKUP_SCHEDULE', value)}
              options={[
                {value: 'daily', label: 'On'},
                {value: 'off', label: 'Off'},
              ]}
            />
          </div>
        </SettingRow>
        {on && (
          <>
            <SettingRow
              htmlFor="NOCHEH_BACKUP_TIME"
              title={
                <>
                  Time
                  <Unsaved show={changed('NOCHEH_BACKUP_TIME', 'NOCHEH_BACKUP_TIME_ZONE')} />
                </>
              }
              description="Pick a quiet hour. If the machine is off then, the backup runs when it is back."
            >
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Input
                  id="NOCHEH_BACKUP_TIME"
                  type="time"
                  className="w-28"
                  value={s.value('NOCHEH_BACKUP_TIME') || '04:00'}
                  disabled={s.busy}
                  onChange={e => e.target.value && s.set('NOCHEH_BACKUP_TIME', e.target.value.slice(0, 5))}
                />
                <Select
                  aria-label="Backup time zone"
                  className="w-56"
                  value={zone}
                  disabled={s.busy}
                  onChange={e => s.set('NOCHEH_BACKUP_TIME_ZONE', e.target.value)}
                >
                  {[...new Set(['UTC', zone, ...zones()])].map(item => (
                    <option key={item} value={item}>
                      {item.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
                {device && device !== zone && (
                  <Button size="sm" disabled={s.busy} onClick={() => s.set('NOCHEH_BACKUP_TIME_ZONE', device)}>
                    Use this device’s ({device.replace(/_/g, ' ')})
                  </Button>
                )}
              </div>
            </SettingRow>
            <SettingRow
              htmlFor="NOCHEH_BACKUP_KEEP"
              title={
                <>
                  Keep
                  <Unsaved show={changed('NOCHEH_BACKUP_KEEP')} />
                </>
              }
              description="Older automatic backups are deleted. Backups you start yourself are never deleted."
            >
              <div className="flex gap-2 sm:justify-end">
                <Select
                  id="NOCHEH_BACKUP_KEEP"
                  aria-label="Automatic backups to keep"
                  value={customKeep ? 'custom' : keep}
                  disabled={s.busy}
                  onChange={e => s.set('NOCHEH_BACKUP_KEEP', e.target.value === 'custom' ? '10' : e.target.value)}
                >
                  <option value="3">Last 3</option>
                  <option value="7">Last 7</option>
                  <option value="14">Last 14</option>
                  <option value="30">Last 30</option>
                  <option value="custom">Other…</option>
                </Select>
                {customKeep && (
                  <Input
                    aria-label="Automatic backups to keep, number"
                    className="w-20"
                    inputMode="numeric"
                    value={keep}
                    disabled={s.busy}
                    onChange={e => s.set('NOCHEH_BACKUP_KEEP', e.target.value.replace(/\D/g, '').slice(0, 3))}
                  />
                )}
              </div>
            </SettingRow>
          </>
        )}
      </div>
    </Card>
  );
}

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
      {has('NOCHEH_BACKUP_SCHEDULE') && <BackupSettings />}
    </>
  );
}
