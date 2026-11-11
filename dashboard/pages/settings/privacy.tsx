import {useState} from 'react';
import {ExternalLink} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {adoptSavedSettings, useSettings, type SettingsView} from '../../lib/settings';
import {operationError} from '../../lib/system-format';
import {Button, Card, CardHeader, Input, Notice, Segmented, Select, SettingRow} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {Unsaved} from './telegram';
import {PasswordSettings} from './password';

const offsiteKeys = [
  'NOCHEH_OFFSITE',
  'NOCHEH_OFFSITE_PROVIDER',
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

type Provider = 'cloudflare' | 'backblaze' | 'other';
type Connected = {
  status: 'connected';
  provider: Exclude<Provider, 'other'>;
  bucket: string;
  account?: string;
  lock_days?: number;
  setup_token_deleted?: boolean;
  settings: SettingsView;
  saved_on: string;
};
type ChooseAccount = {status: 'choose_account'; accounts: {id: string; name: string}[]};

// Cloudflare's token page, already filled in: R2 to make the bucket and its lock, and API tokens to make the
// bucket-only key. Nocheh deletes this setup token once it is done (ADR-0236).
const cloudflareTokenPage =
  'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=' +
  encodeURIComponent(
    JSON.stringify([
      {key: 'workers_r2', type: 'edit'},
      {key: 'account_api_tokens', type: 'edit'},
    ]),
  ) +
  '&name=' +
  encodeURIComponent('Nocheh setup');
const cloudflareR2Page = 'https://dash.cloudflare.com/?to=/:account/r2/overview';
const cloudflareTokensPage = 'https://dash.cloudflare.com/?to=/:account/api-tokens';
const backblazeKeysPage = 'https://secure.backblaze.com/app_keys.htm';
const storageKeys = [
  'NOCHEH_OFFSITE_PROVIDER',
  'NOCHEH_OFFSITE_ENDPOINT',
  'NOCHEH_OFFSITE_BUCKET',
  'NOCHEH_OFFSITE_REGION',
  'NOCHEH_OFFSITE_ACCESS_KEY_ID',
  'NOCHEH_OFFSITE_SECRET_ACCESS_KEY',
];

function OutLink({href, children}: {href: string; children: React.ReactNode}) {
  return (
    <a className="text-accent-text underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Encrypted off-site copies of finished backups in the owner's own storage (ADR-0229, ADR-0236). */
function OffsiteSettings() {
  const s = useSettings();
  const feedback = useFeedback();
  const on = s.value('NOCHEH_OFFSITE') === 's3';
  // Cloudflare and Backblaze are saved by Connect, so choosing one only changes what this card shows. Other S3 is
  // saved with Save, together with the fields typed for it.
  const [viewing, setViewing] = useState<Provider | null>(null);
  const provider = (
    s.changed('NOCHEH_OFFSITE_PROVIDER')
      ? s.value('NOCHEH_OFFSITE_PROVIDER')
      : (viewing ?? (s.saved('NOCHEH_OFFSITE_PROVIDER') || 'cloudflare'))
  ) as Provider;
  const configured = (key: string) => !!s.field(key)?.configured;
  const keep = s.value('NOCHEH_OFFSITE_KEEP') || '14';
  const customKeep = !keepPresets.includes(keep);
  // Storage counts as connected once Nocheh saved this provider with every storage setting.
  const connected =
    provider !== 'other' &&
    s.saved('NOCHEH_OFFSITE_PROVIDER') === provider &&
    ['NOCHEH_OFFSITE_ENDPOINT', 'NOCHEH_OFFSITE_BUCKET', 'NOCHEH_OFFSITE_ACCESS_KEY_ID'].every(key => !!s.saved(key)) &&
    configured('NOCHEH_OFFSITE_SECRET_ACCESS_KEY');
  const [again, setAgain] = useState(false);
  const [token, setToken] = useState('');
  const [keyId, setKeyId] = useState('');
  const [key, setKey] = useState('');
  const [account, setAccount] = useState('');
  const [accounts, setAccounts] = useState<ChooseAccount['accounts'] | null>(null);
  const [askAccount, setAskAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  // A Cloudflare connect that stops after the setup token was accepted leaves that token in place for another try.
  const [problem, setProblem] = useState<{text: string; tokenLeft: boolean} | null>(null);
  const [done, setDone] = useState<Connected | null>(null);
  const showForm = provider !== 'other' && (!connected || again);

  const forgetAccount = () => {
    setAccount('');
    setAccounts(null);
    setAskAccount(false);
  };
  const pick = (value: Provider) => {
    // Leaving Other S3 drops what was typed for it; choosing it is the one storage edit Save writes.
    s.setMany(
      Object.fromEntries(
        storageKeys.map(key => [
          key,
          key === 'NOCHEH_OFFSITE_PROVIDER' && value === 'other' ? 'other' : s.field(key)?.secret ? '' : s.saved(key),
        ]),
      ),
    );
    setViewing(value === 'other' ? null : value);
    forgetAccount();
    setProblem(null);
    setDone(null);
    setAgain(false);
  };
  const connect = async () => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const answer = await apiPost<Connected | ChooseAccount>(
        '/offsite/connect',
        provider === 'cloudflare' ? {provider, token, ...(account ? {account} : {})} : {provider, key_id: keyId, key},
      );
      if (answer.status === 'choose_account') {
        setAccounts(answer.accounts);
        setAccount(answer.accounts[0]?.id ?? '');
        return;
      }
      adoptSavedSettings(answer.settings, storageKeys, answer.saved_on);
      setDone(answer);
      setViewing(null);
      setToken('');
      setKey('');
      setKeyId('');
      forgetAccount();
      setAgain(false);
      feedback.toast('Storage connected.');
    } catch (error) {
      const code = (error as ApiError).message;
      if (code === 'offsite_cloudflare_account_needed') setAskAccount(true);
      setProblem({
        text: operationError(code),
        tokenLeft:
          provider === 'cloudflare' &&
          code.startsWith('offsite_') &&
          ![
            'offsite_cloudflare_token_invalid',
            'offsite_cloudflare_token_refused',
            'offsite_cloudflare_account_needed',
          ].includes(code),
      });
    } finally {
      setBusy(false);
    }
  };
  const ready =
    provider === 'cloudflare'
      ? !!token.trim() && (!askAccount || /^[0-9a-f]{32}$/.test(account))
      : !!keyId.trim() && !!key.trim();

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
  const connectButton = (
    <Button variant="primary" busy={busy} disabled={!ready || s.busy || busy} onClick={() => void connect()}>
      Connect
    </Button>
  );
  return (
    <Card>
      <CardHeader
        title="Off-site copies"
        description="After each automatic backup, an encrypted copy goes to your own storage. It is locked with your passphrase on this machine, so the storage only ever holds scrambled data."
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
            <SettingRow
              title={
                <>
                  Storage
                  <Unsaved show={s.changed('NOCHEH_OFFSITE_PROVIDER')} />
                </>
              }
              description={
                provider === 'cloudflare'
                  ? 'Cloudflare R2: free up to 10 GB. Nocheh sets it up from one token.'
                  : provider === 'backblaze'
                    ? 'Backblaze B2: free up to 10 GB. Nocheh reads the rest from one key.'
                    : 'Any other S3-compatible storage. You fill in its address and keys.'
              }
            >
              <div className="flex sm:justify-end">
                <Segmented
                  label="Storage"
                  size="sm"
                  value={provider}
                  disabled={s.busy || busy}
                  onChange={pick}
                  options={[
                    {value: 'cloudflare', label: 'Cloudflare'},
                    {value: 'backblaze', label: 'Backblaze'},
                    {value: 'other', label: 'Other S3'},
                  ]}
                />
              </div>
            </SettingRow>
            {(problem || done) && (
              <div className="border-t border-line px-5 py-4">
                {problem ? (
                  <Notice tone="bad">
                    {problem.text}
                    {problem.tokenLeft && (
                      <>
                        {' '}
                        The setup token stays in Cloudflare so you can try again. Once you are done with it, delete
                        “Nocheh setup” in <OutLink href={cloudflareTokensPage}>Cloudflare’s API tokens</OutLink>.
                      </>
                    )}
                  </Notice>
                ) : (
                  done && (
                    <Notice tone="good" title={'Connected to bucket ' + done.bucket + '.'}>
                      {done.lock_days
                        ? `Each copy is locked for ${done.lock_days} days, so nobody can delete it early, not even with this machine’s key. `
                        : ''}
                      {done.setup_token_deleted === false && (
                        <>
                          Nocheh couldn’t delete the setup token. Delete “Nocheh setup” in{' '}
                          <OutLink href={cloudflareTokensPage}>Cloudflare’s API tokens</OutLink>.{' '}
                        </>
                      )}
                      {s.saved('NOCHEH_OFFSITE') === 's3' && configured('NOCHEH_OFFSITE_PASSPHRASE')
                        ? 'New copies go there from now on.'
                        : 'Now type your passphrase below and save.'}
                    </Notice>
                  )
                )}
              </div>
            )}
            {provider !== 'other' && connected && !again && (
              <SettingRow
                title={provider === 'cloudflare' ? 'Cloudflare R2' : 'Backblaze B2'}
                description={
                  `Connected. Copies go to bucket ${s.saved('NOCHEH_OFFSITE_BUCKET')}.` +
                  (provider === 'cloudflare'
                    ? ' Nocheh keeps a key for this bucket only, and each copy is locked for 7 days.'
                    : '')
                }
              >
                <div className="flex sm:justify-end">
                  <Button
                    size="sm"
                    disabled={s.busy}
                    onClick={() => {
                      forgetAccount();
                      setProblem(null);
                      setDone(null);
                      setAgain(true);
                    }}
                  >
                    Connect again
                  </Button>
                </div>
              </SettingRow>
            )}
            {showForm && provider === 'cloudflare' && (
              <>
                <SettingRow
                  title="1. Make a setup token"
                  description={
                    <>
                      Cloudflare opens with the right permissions already chosen. Click Continue to summary, then Create
                      Token, and copy it. First time with R2? <OutLink href={cloudflareR2Page}>Turn on R2</OutLink>{' '}
                      first.
                    </>
                  }
                >
                  <div className="flex sm:justify-end">
                    <Button size="sm" asChild>
                      <a href={cloudflareTokenPage} target="_blank" rel="noreferrer">
                        Open Cloudflare <ExternalLink aria-hidden className="size-3.5" />
                      </a>
                    </Button>
                  </div>
                </SettingRow>
                <SettingRow
                  htmlFor="offsite-cloudflare-token"
                  title="2. Paste it here"
                  description="Nocheh makes the bucket and a key for that bucket only, tests it, then deletes the setup token. The token itself is never saved."
                >
                  <div className="flex gap-2">
                    <Input
                      id="offsite-cloudflare-token"
                      type="password"
                      autoComplete="off"
                      placeholder="Setup token"
                      value={token}
                      disabled={s.busy || busy}
                      onChange={e => {
                        // Another token may reach other accounts.
                        setToken(e.target.value.trim());
                        forgetAccount();
                      }}
                    />
                    {!accounts && !askAccount && connectButton}
                  </div>
                </SettingRow>
                {accounts && (
                  <SettingRow
                    htmlFor="offsite-cloudflare-account"
                    title="Cloudflare account"
                    description="This token reaches more than one account. Pick the one for the copies."
                  >
                    <div className="flex gap-2">
                      <Select
                        id="offsite-cloudflare-account"
                        value={account}
                        disabled={busy}
                        onChange={e => setAccount(e.target.value)}
                      >
                        {accounts.map(row => (
                          <option key={row.id} value={row.id}>
                            {row.name || row.id}
                          </option>
                        ))}
                      </Select>
                      {connectButton}
                    </div>
                  </SettingRow>
                )}
                {askAccount && !accounts && (
                  <SettingRow
                    htmlFor="offsite-cloudflare-account-id"
                    title="Account ID"
                    description="Cloudflare didn’t say which account this token is for. Copy the Account ID from your Cloudflare account home."
                  >
                    <div className="flex gap-2">
                      <Input
                        id="offsite-cloudflare-account-id"
                        autoComplete="off"
                        placeholder="32 letters and digits"
                        value={account}
                        disabled={busy}
                        onChange={e => setAccount(e.target.value.trim().toLowerCase())}
                      />
                      {connectButton}
                    </div>
                  </SettingRow>
                )}
              </>
            )}
            {showForm && provider === 'backblaze' && (
              <>
                <SettingRow
                  title="1. Make a key"
                  description="In Backblaze, create a private bucket and set its Lifecycle Settings to Keep only the last version, so deleted copies free their space. Then create an application key with Read and Write access to that bucket only."
                >
                  <div className="flex sm:justify-end">
                    <Button size="sm" asChild>
                      <a href={backblazeKeysPage} target="_blank" rel="noreferrer">
                        Open Backblaze <ExternalLink aria-hidden className="size-3.5" />
                      </a>
                    </Button>
                  </div>
                </SettingRow>
                <SettingRow
                  htmlFor="offsite-backblaze-key-id"
                  title="2. Paste it here"
                  description="Nocheh finds the bucket and its address, and tests the key before saving it."
                >
                  <div className="flex flex-col gap-2">
                    <Input
                      id="offsite-backblaze-key-id"
                      aria-label="Key ID"
                      autoComplete="off"
                      placeholder="keyID"
                      value={keyId}
                      disabled={s.busy || busy}
                      onChange={e => setKeyId(e.target.value.trim())}
                    />
                    <div className="flex gap-2">
                      <Input
                        aria-label="Application key"
                        type="password"
                        autoComplete="off"
                        placeholder="applicationKey"
                        value={key}
                        disabled={s.busy || busy}
                        onChange={e => setKey(e.target.value.trim())}
                      />
                      {connectButton}
                    </div>
                  </div>
                </SettingRow>
              </>
            )}
            {provider === 'other' && (
              <>
                {text(
                  'NOCHEH_OFFSITE_ENDPOINT',
                  'Storage address',
                  'The https S3 address of your storage, such as https://s3.eu-central-1.example.com',
                  'https://…',
                )}
                {text(
                  'NOCHEH_OFFSITE_BUCKET',
                  'Bucket',
                  'Make an empty bucket just for these copies.',
                  'nocheh-backups',
                )}
                {text('NOCHEH_OFFSITE_REGION', 'Region', 'The region your storage names, or auto.', 'auto')}
                {text(
                  'NOCHEH_OFFSITE_ACCESS_KEY_ID',
                  'Access key ID',
                  'From a key that can read and write this bucket only.',
                  'Access key ID',
                )}
                {text(
                  'NOCHEH_OFFSITE_SECRET_ACCESS_KEY',
                  'Secret access key',
                  'Kept on this machine and never shown again.',
                  'Secret access key',
                  true,
                )}
              </>
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
              description="Older copies are deleted after each new one. Copies still locked by the storage stay until their lock ends."
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
