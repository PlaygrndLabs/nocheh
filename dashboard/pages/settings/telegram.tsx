import {useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {useSettings} from '../../lib/settings';
import {href} from '../../lib/routes';
import {Badge, Button, Card, CardHeader, Input, Notice, Segmented, SettingRow, Switch} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {errorWords, when} from '../memory/shared';
import {LinkButton} from '../../ui/link-button';

export const telegramKeys = [
  'TELEGRAM_ENABLED',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_ID',
  'TELEGRAM_GROUP_REPLIES',
  'TELEGRAM_BOT_NAMES',
  'TELEGRAM_GROUP_IDS',
  'TELEGRAM_GROUP_ACCESS',
  'TELEGRAM_TOPIC_MEMORY',
  'TELEGRAM_TYPING',
  'TELEGRAM_PROBLEM_NOTICES',
  'NOCHEH_DASHBOARD_URL',
  'NOCHEH_MINI_APP_URL',
  'CLOUDFLARE_TUNNEL_TOKEN',
];

/** Marks a control whose value differs from the saved one. */
export function Unsaved({show}: {show: boolean}) {
  return show ? (
    <Badge tone="warn" className="ml-2 align-middle">
      Not saved
    </Badge>
  ) : null;
}

type MiniAppLock = {
  password_set: boolean;
  changed_at: number | null;
  sessions: {created_at: number; last_seen_at: number}[];
  paused_until: number | null;
};
const passwordErrors: Record<string, string> = {
  password_too_short: 'Use at least 8 characters.',
  password_too_long: 'Use at most 200 characters.',
};

/**
 * The mini app's password and the phones signed in with it. These save at
 * once with their own buttons: the password is never part of the settings
 * that Save at the top writes.
 */
function MiniAppPassword() {
  const lock = useResource<MiniAppLock>('/mini-app/lock');
  const feedback = useFeedback();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const data = lock.data;
  const phones = data?.sessions.length ?? 0;
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
      await refreshResources();
    } catch (e) {
      setProblem(passwordErrors[(e as Error)?.message] ?? errorWords(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run('password', async () => {
      await apiPost('/mini-app/lock/password', {password});
      setPassword('');
      feedback.toast(
        data?.password_set ? 'Password changed. Every phone signs in again with the new one.' : 'Password set.',
      );
    });
  const signOutAll = async () => {
    const ok = await feedback.confirm({
      title: 'Sign out every phone?',
      body: 'Each phone asks for the mini app password again the next time it opens the mini app.',
      confirm: 'Sign out everywhere',
      danger: true,
    });
    if (ok)
      await run('sign-out', async () => {
        await apiPost('/mini-app/lock/sign-out-all', {});
        feedback.toast('Every phone is signed out.');
      });
  };
  return (
    <>
      <SettingRow
        title={
          <>
            Password
            {data && !data.password_set && (
              <Badge tone="warn" className="ml-2 align-middle">
                Not set
              </Badge>
            )}
          </>
        }
        description={
          problem ? (
            <span className="text-bad" role="alert">
              {problem}
            </span>
          ) : data?.password_set ? (
            `Each phone asks for it once.${data.changed_at ? ' Changed ' + when(new Date(data.changed_at).toISOString()) + '.' : ''} A new password signs every phone out.`
          ) : (
            'The mini app stays locked until you set one. Each phone asks for it once.'
          )
        }
        htmlFor="mini-app-password"
      >
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (password && !busy) void save();
          }}
        >
          <Input
            id="mini-app-password"
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={data?.password_set ? 'New password' : 'At least 8 characters'}
            disabled={!!busy || !data}
            onChange={e => setPassword(e.target.value)}
          />
          <Button type="submit" busy={busy === 'password'} disabled={!password || !!busy}>
            {data?.password_set ? 'Change' : 'Set'}
          </Button>
        </form>
      </SettingRow>
      {data?.password_set && (
        <SettingRow
          title="Signed-in phones"
          description={
            data.paused_until
              ? `Sign-in is paused after too many wrong passwords, until ${when(new Date(data.paused_until).toISOString())}.`
              : phones
                ? `${phones} ${phones === 1 ? 'phone is' : 'phones are'} signed in. Last used ${when(new Date(data.sessions[0]!.last_seen_at).toISOString())}.`
                : 'No phone is signed in.'
          }
        >
          <div className="flex sm:justify-end">
            <Button
              variant="danger"
              busy={busy === 'sign-out'}
              disabled={!phones || !!busy}
              onClick={() => void signOutAll()}
            >
              Sign out everywhere
            </Button>
          </div>
        </SettingRow>
      )}
    </>
  );
}

export function TelegramSettings() {
  const s = useSettings();
  const identities = useResource<any>('/telegram/identities');
  const owner = s.value('TELEGRAM_OWNER_ID');
  const known = (identities.data?.groups ?? []).flatMap((g: any) => g.users ?? []).find((u: any) => u.id === owner);
  const enabled = s.value('TELEGRAM_ENABLED') === 'true';
  const token = s.field('TELEGRAM_BOT_TOKEN');
  const tunnel = s.field('CLOUDFLARE_TUNNEL_TOKEN');
  const miniApp = s.value('NOCHEH_MINI_APP_URL');
  const groups = s
    .value('TELEGRAM_GROUP_IDS')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  return (
    <>
      {!enabled && (
        <Notice tone="warn" title="Telegram is off">
          Nocheh doesn’t receive or answer Telegram messages until you turn it on and save.
        </Notice>
      )}
      <Card>
        <CardHeader title="Connection" description="The bot Nocheh uses and who owns it." className="pb-3" />
        <div className="border-t border-line">
          <SettingRow
            title={
              <>
                Telegram
                <Unsaved show={s.changed('TELEGRAM_ENABLED')} />
              </>
            }
            description="Receive and answer messages."
            htmlFor="telegram-enabled"
          >
            <div className="flex sm:justify-end">
              <Switch
                id="telegram-enabled"
                label="Telegram"
                checked={enabled}
                disabled={s.busy}
                onChange={on => s.set('TELEGRAM_ENABLED', on ? 'true' : 'false')}
              />
            </div>
          </SettingRow>
          <SettingRow
            title={
              <>
                Show typing while working
                <Unsaved show={s.changed('TELEGRAM_TYPING')} />
              </>
            }
            description="Shows “typing…” in the chat or topic while Nocheh works on a reply."
            htmlFor="telegram-typing"
          >
            <div className="flex sm:justify-end">
              <Switch
                id="telegram-typing"
                label="Show typing while working"
                checked={s.value('TELEGRAM_TYPING') !== 'false'}
                disabled={s.busy}
                onChange={on => s.set('TELEGRAM_TYPING', on ? 'true' : 'false')}
              />
            </div>
          </SettingRow>
          <SettingRow
            title={
              <>
                Tell me about problems
                <Unsaved show={s.changed('TELEGRAM_PROBLEM_NOTICES')} />
              </>
            }
            description="Messages your private chat about each new failure or problem, such as failed work or a model that refused. The same problem repeats at most once an hour, and only when it gets worse."
            htmlFor="telegram-problem-notices"
          >
            <div className="flex sm:justify-end">
              <Switch
                id="telegram-problem-notices"
                label="Tell me about problems"
                checked={s.value('TELEGRAM_PROBLEM_NOTICES') !== 'false'}
                disabled={s.busy}
                onChange={on => s.set('TELEGRAM_PROBLEM_NOTICES', on ? 'true' : 'false')}
              />
            </div>
          </SettingRow>
          <SettingRow
            title={
              <>
                Dashboard address
                <Unsaved show={s.changed('NOCHEH_DASHBOARD_URL')} />
              </>
            }
            description="Where Open under a problem notice and review links go when the mini app is off. Leave empty for this computer’s own address, which opens only on this computer."
            htmlFor="dashboard-url"
          >
            <Input
              id="dashboard-url"
              inputMode="url"
              value={s.value('NOCHEH_DASHBOARD_URL')}
              placeholder="https://nocheh.example.com"
              disabled={s.busy}
              onChange={e => s.set('NOCHEH_DASHBOARD_URL', e.target.value.trim())}
            />
          </SettingRow>
          <SettingRow
            title={
              <>
                Bot token
                <Unsaved show={s.changed('TELEGRAM_BOT_TOKEN')} />
              </>
            }
            description={
              token?.configured
                ? 'A token is saved. Paste a new one only to replace it.'
                : 'From @BotFather in Telegram.'
            }
            htmlFor="telegram-token"
          >
            <Input
              id="telegram-token"
              type="password"
              autoComplete="off"
              value={s.value('TELEGRAM_BOT_TOKEN')}
              placeholder={token?.configured ? '****' : 'Paste the bot token'}
              disabled={s.busy}
              onChange={e => s.set('TELEGRAM_BOT_TOKEN', e.target.value.trim())}
            />
          </SettingRow>
          <SettingRow
            title={
              <>
                Your Telegram user ID
                <Unsaved show={s.changed('TELEGRAM_OWNER_ID')} />
              </>
            }
            description={
              known
                ? `This is ${known.name}${known.username ? ' (' + known.username + ')' : ''}. Only you can manage Nocheh.`
                : 'The number for your own Telegram account. Only you can manage Nocheh.'
            }
            htmlFor="telegram-owner"
          >
            <Input
              id="telegram-owner"
              inputMode="numeric"
              value={owner}
              placeholder="123456789"
              disabled={s.busy}
              onChange={e => s.set('TELEGRAM_OWNER_ID', e.target.value.trim())}
            />
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="In groups"
          description={
            <>
              Which groups Nocheh is in and who may talk to it there are set in{' '}
              <a className="font-medium text-accent-text hover:underline" href={href('chats')}>
                Chats
              </a>
              .
            </>
          }
          className="pb-3"
        />
        <div className="border-t border-line">
          <SettingRow
            title={
              <>
                Groups Nocheh is on in
                <Unsaved show={s.changed('TELEGRAM_GROUP_IDS')} />
              </>
            }
            description={
              groups.length
                ? `On in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}.`
                : 'No groups are selected. Your private messages with Nocheh still work.'
            }
          >
            <div className="flex sm:justify-end">
              <LinkButton href={href('chats')}>Choose in Chats</LinkButton>
            </div>
          </SettingRow>
          <SettingRow
            title={
              <>
                When Nocheh answers
                <Unsaved show={s.changed('TELEGRAM_GROUP_REPLIES')} />
              </>
            }
            description={
              s.value('TELEGRAM_GROUP_REPLIES') === 'all'
                ? 'It may answer any message from someone allowed to talk to it.'
                : 'Only when someone replies to it, mentions it, or starts a message with one of its names. Every message is still kept.'
            }
          >
            <div className="flex sm:justify-end">
              <Segmented
                label="When Nocheh answers in groups"
                value={s.value('TELEGRAM_GROUP_REPLIES') === 'all' ? 'all' : 'addressed'}
                disabled={s.busy}
                onChange={value => s.set('TELEGRAM_GROUP_REPLIES', value)}
                options={[
                  {value: 'addressed', label: 'When called'},
                  {value: 'all', label: 'Every message'},
                ]}
              />
            </div>
          </SettingRow>
          <SettingRow
            title={
              <>
                Names that call Nocheh
                <Unsaved show={s.changed('TELEGRAM_BOT_NAMES')} />
              </>
            }
            description="Separate names with commas. Its Telegram name and @username always work too."
            htmlFor="telegram-names"
          >
            <Input
              id="telegram-names"
              value={s.value('TELEGRAM_BOT_NAMES')}
              placeholder="Nocheh, نوچه"
              disabled={s.busy}
              onChange={e => s.set('TELEGRAM_BOT_NAMES', e.target.value)}
            />
          </SettingRow>
          <SettingRow
            title={
              <>
                Topic memory
                <Unsaved show={s.changed('TELEGRAM_TOPIC_MEMORY')} />
              </>
            }
            description={
              s.value('TELEGRAM_TOPIC_MEMORY') === 'topic'
                ? 'Each topic of a group remembers only its own messages.'
                : 'All topics of a group share one memory.'
            }
          >
            <div className="flex sm:justify-end">
              <Segmented
                label="Topic memory"
                value={s.value('TELEGRAM_TOPIC_MEMORY') === 'topic' ? 'topic' : 'group'}
                disabled={s.busy}
                onChange={value => s.set('TELEGRAM_TOPIC_MEMORY', value)}
                options={[
                  {value: 'group', label: 'Whole group'},
                  {value: 'topic', label: 'Each topic'},
                ]}
              />
            </div>
          </SettingRow>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Mini app"
          description="Home, Inbox and Tasks on your phone, from the button next to the message box in your private chat with Nocheh. Only your Telegram account can open it, with the password below; Settings and System stay here."
          className="pb-3"
        />
        <div className="border-t border-line">
          <SettingRow
            title={
              <>
                Address
                <Unsaved show={s.changed('NOCHEH_MINI_APP_URL')} />
              </>
            }
            description={
              miniApp
                ? 'The public address your Cloudflare tunnel sends to the mini app.'
                : 'Leave empty to keep the mini app off.'
            }
            htmlFor="mini-app-url"
          >
            <Input
              id="mini-app-url"
              inputMode="url"
              value={miniApp}
              placeholder="https://nocheh.example.com"
              disabled={s.busy}
              onChange={e => s.set('NOCHEH_MINI_APP_URL', e.target.value.trim())}
            />
          </SettingRow>
          <SettingRow
            title={
              <>
                Tunnel token
                <Unsaved show={s.changed('CLOUDFLARE_TUNNEL_TOKEN')} />
              </>
            }
            description={
              tunnel?.configured
                ? 'A token is saved. Paste a new one only to replace it.'
                : 'From Cloudflare Zero Trust, Networks, Tunnels, for the tunnel that points to the mini app.'
            }
            htmlFor="mini-app-tunnel"
          >
            <Input
              id="mini-app-tunnel"
              type="password"
              autoComplete="off"
              value={s.value('CLOUDFLARE_TUNNEL_TOKEN')}
              placeholder={tunnel?.configured ? '****' : 'Paste the tunnel token'}
              disabled={s.busy}
              onChange={e => s.set('CLOUDFLARE_TUNNEL_TOKEN', e.target.value.trim())}
            />
          </SettingRow>
          <MiniAppPassword />
        </div>
      </Card>
    </>
  );
}
