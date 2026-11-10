import {useSettings} from '../../lib/settings';
import {Button, Card, CardHeader, Input, Segmented, Select, SettingRow} from '../../ui/core';
import {Unsaved} from './telegram';
import {PasswordSettings} from './password';

const offsiteKeys = [
  'NOCHEH_OFFSITE',
  'NOCHEH_OFFSITE_ENDPOINT',
  'NOCHEH_OFFSITE_BUCKET',
  'NOCHEH_OFFSITE_REGION',
  'NOCHEH_OFFSITE_ACCESS_KEY_ID',
  'NOCHEH_OFFSITE_SECRET_ACCESS_KEY',
  'NOCHEH_OFFSITE_PASSPHRASE',
  'NOCHEH_OFFSITE_KEEP',
];

export const privacyKeys = [
  'NOCHEH_GUARD_MODE',
  'NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS',
  'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS',
  'NOCHEH_BACKUP_SCHEDULE',
  'NOCHEH_BACKUP_TIME',
  'NOCHEH_BACKUP_TIME_ZONE',
  'NOCHEH_BACKUP_KEEP',
  ...offsiteKeys,
];

const keepPresets = ['3', '7', '14', '30'];

function zones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch {
    return ['UTC'];
  }
}

/** Encrypted off-site copies of finished backups in the owner's own S3-compatible storage (ADR-0227). */
function OffsiteSettings() {
  const s = useSettings();
  const on = s.value('NOCHEH_OFFSITE') === 's3';
  const configured = (key: string) => !!s.field(key)?.configured;
  const keep = s.value('NOCHEH_OFFSITE_KEEP') || '14';
  const customKeep = !keepPresets.includes(keep);
  const text = (key: string, title: string, description: string, placeholder: string, secret = false) => (
    <SettingRow
      htmlFor={key}
      title={
        <>
          {title}
          <Unsaved show={s.changed(key)} />
        </>
      }
      description={description}
    >
      <Input
        id={key}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        placeholder={secret && configured(key) ? 'Saved. Type to replace.' : placeholder}
        value={s.value(key)}
        disabled={s.busy}
        // A secret is kept exactly as typed: trimming on every key would drop the spaces between words.
        onChange={e => s.set(key, secret ? e.target.value : e.target.value.trim())}
      />
    </SettingRow>
  );
  return (
    <Card>
      <CardHeader
        title="Off-site copies"
        description="After each automatic backup, an encrypted copy goes to your own storage, such as a Cloudflare R2 bucket. It is locked with your passphrase on this machine, so the storage only ever holds scrambled data."
        className="pb-3"
      />
      <div className="border-t border-line">
        <SettingRow
          title={
            <>
              Send off-site copies
              <Unsaved show={s.changed('NOCHEH_OFFSITE')} />
            </>
          }
          description={on ? 'On: a copy of each new automatic backup.' : 'Off: backups stay only on this machine.'}
        >
          <div className="flex sm:justify-end">
            <Segmented
              label="Send off-site copies"
              value={on ? 's3' : 'off'}
              disabled={s.busy}
              onChange={value => s.set('NOCHEH_OFFSITE', value)}
              options={[
                {value: 's3', label: 'On'},
                {value: 'off', label: 'Off'},
              ]}
            />
          </div>
        </SettingRow>
        {on && (
          <>
            {text(
              'NOCHEH_OFFSITE_ENDPOINT',
              'Storage address',
              'The S3 address of your storage. For Cloudflare R2: https://<account id>.r2.cloudflarestorage.com',
              'https://…r2.cloudflarestorage.com',
            )}
            {text('NOCHEH_OFFSITE_BUCKET', 'Bucket', 'Make an empty bucket just for these copies.', 'nocheh-backups')}
            {text('NOCHEH_OFFSITE_REGION', 'Region', 'R2 uses auto. Other providers name a region.', 'auto')}
            {text(
              'NOCHEH_OFFSITE_ACCESS_KEY_ID',
              'Access key ID',
              'From an API token that can read and write this bucket only.',
              'Access key ID',
            )}
            {text(
              'NOCHEH_OFFSITE_SECRET_ACCESS_KEY',
              'Secret access key',
              'Kept on this machine and never shown again.',
              'Secret access key',
              true,
            )}
            {text(
              'NOCHEH_OFFSITE_PASSPHRASE',
              'Passphrase',
              'At least 16 characters, without quotes or backslashes. Write it down somewhere safe away from this machine: without it, no copy can be opened, not even by us. Changing it applies to new copies only.',
              'A long phrase you will not forget',
              true,
            )}
            <SettingRow
              htmlFor="NOCHEH_OFFSITE_KEEP"
              title={
                <>
                  Keep
                  <Unsaved show={s.changed('NOCHEH_OFFSITE_KEEP')} />
                </>
              }
              description="Older copies in the bucket are deleted after each new one."
            >
              <div className="flex gap-2 sm:justify-end">
                <Select
                  id="NOCHEH_OFFSITE_KEEP"
                  aria-label="Off-site copies to keep"
                  value={customKeep ? 'custom' : keep}
                  disabled={s.busy}
                  onChange={e => s.set('NOCHEH_OFFSITE_KEEP', e.target.value === 'custom' ? '10' : e.target.value)}
                >
                  <option value="3">Last 3</option>
                  <option value="7">Last 7</option>
                  <option value="14">Last 14</option>
                  <option value="30">Last 30</option>
                  <option value="custom">Other…</option>
                </Select>
                {customKeep && (
                  <Input
                    aria-label="Off-site copies to keep, number"
                    className="w-20"
                    inputMode="numeric"
                    value={keep}
                    disabled={s.busy}
                    onChange={e => s.set('NOCHEH_OFFSITE_KEEP', e.target.value.replace(/\D/g, '').slice(0, 3))}
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
      <PasswordSettings />
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
      {has('NOCHEH_OFFSITE') && <OffsiteSettings />}
    </>
  );
}
