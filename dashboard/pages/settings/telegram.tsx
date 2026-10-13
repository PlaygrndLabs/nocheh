import {useResource} from '../../lib/resource';
import {useSettings} from '../../lib/settings';
import {href} from '../../lib/routes';
import {Badge, Card, CardHeader, Input, Notice, Segmented, SettingRow, Switch} from '../../ui/core';
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
];

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
  const known = (identities.data?.groups ?? []).flatMap((g: any) => g.users ?? []).find((u: any) => u.id === owner);
  const enabled = s.value('TELEGRAM_ENABLED') === 'true';
  const token = s.field('TELEGRAM_BOT_TOKEN');
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
    </>
  );
}
