import {useResource} from '../../lib/resource';
import {useSettings} from '../../lib/settings';
import {href} from '../../lib/routes';
import {Badge, Card, CardHeader, Input, Notice, Segmented, SettingRow, Switch} from '../../ui/core';
import {LinkButton} from '../../ui/link-button';
import {FindIdButton, FoundPeople, useFindTelegramId} from './telegram-id';

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
  'TELEGRAM_REACTIONS',
  'TELEGRAM_PROBLEM_NOTICES',
  'NOCHEH_DASHBOARD_URL',
  'NOCHEH_MINI_APP_URL',
  'CLOUDFLARE_TUNNEL_TOKEN',
];

const changeOwner = './bin/nocheh config set TELEGRAM_OWNER_ID <id>';

/** Marks a control whose value differs from the saved one. */
export function Unsaved({show}: {show: boolean}) {
  return show ? (
    <Badge tone="warn" className="ml-2 align-middle">
      Not saved
    </Badge>
  ) : null;
}

export function TelegramSettings() {
  const s = useSettings();
  const identities = useResource<any>('/telegram/identities');
  const owner = s.value('TELEGRAM_OWNER_ID');
  // Set here the first time; once saved it changes only from the command line (ADR-0244).
  const ownerFixed = !!s.saved('TELEGRAM_OWNER_ID');
  const known = (identities.data?.groups ?? []).flatMap((g: any) => g.users ?? []).find((u: any) => u.id === owner);
  const enabled = s.value('TELEGRAM_ENABLED') === 'true';
  const token = s.field('TELEGRAM_BOT_TOKEN');
  const finder = useFindTelegramId();
  // Finding the ID reads the bot's messages, which only the saved token and Telegram turned off allow.
  const savedOn = s.saved('TELEGRAM_ENABLED') === 'true';
  const findable = !!token?.configured && !s.changed('TELEGRAM_BOT_TOKEN');
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
                React while working
                <Unsaved show={s.changed('TELEGRAM_REACTIONS')} />
              </>
            }
            description="Puts 👀 on the message Nocheh is working on, then 👍 when it answered or 👎 when it failed."
            htmlFor="telegram-reactions"
          >
            <div className="flex sm:justify-end">
              <Switch
                id="telegram-reactions"
                label="React while working"
                checked={s.value('TELEGRAM_REACTIONS') !== 'false'}
                disabled={s.busy}
                onChange={on => s.set('TELEGRAM_REACTIONS', on ? 'true' : 'false')}
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
              ownerFixed ? (
                <>
                  {known ? `This is ${known.name}${known.username ? ' (' + known.username + ')' : ''}. ` : ''}Only you
                  can manage Nocheh. To change it, run <code className="text-xs">{changeOwner}</code> on the computer
                  that runs Nocheh.
                </>
              ) : known ? (
                `This is ${known.name}${known.username ? ' (' + known.username + ')' : ''}. Only you can manage Nocheh.`
              ) : savedOn ? (
                'The number for your own Telegram account. To look it up here, turn Telegram off and save. Only you can manage Nocheh.'
              ) : findable ? (
                'The number for your own Telegram account. Send your bot any message in Telegram, then press Find my ID. Only you can manage Nocheh.'
              ) : (
                'The number for your own Telegram account. Save the bot token first, then you can find it here. Only you can manage Nocheh.'
              )
            }
            htmlFor="telegram-owner"
          >
            <div className="flex gap-2">
              <Input
                id="telegram-owner"
                inputMode="numeric"
                value={owner}
                placeholder="123456789"
                disabled={s.busy}
                readOnly={ownerFixed}
                onChange={e => s.set('TELEGRAM_OWNER_ID', e.target.value.trim())}
              />
              {!savedOn && !ownerFixed && (
                <FindIdButton disabled={s.busy || !findable} busy={finder.busy} onClick={() => void finder.find()} />
              )}
            </div>
          </SettingRow>
          {!savedOn && !ownerFixed && (
            <FoundPeople
              found={finder.found}
              problem={finder.problem}
              current={owner}
              saved={s.saved('TELEGRAM_OWNER_ID')}
              telegramOn={enabled}
              disabled={s.busy}
              onUse={id => s.set('TELEGRAM_OWNER_ID', id)}
            />
          )}
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
          description="Home, Inbox and Tasks on your phone, from the button next to the message box in your private chat with Nocheh. Only your Telegram account can open it, with your Nocheh password; Settings and System stay here."
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
          <SettingRow
            title="Password"
            description="Each phone signs in once with your Nocheh password, the same one as this dashboard."
          >
            <div className="flex sm:justify-end">
              <LinkButton href={href('settings', {view: 'privacy'})}>Change in Privacy & data</LinkButton>
            </div>
          </SettingRow>
        </div>
      </Card>
    </>
  );
}
