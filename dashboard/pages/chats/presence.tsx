/** "Nocheh here": whether Nocheh answers in this chat, and how. */
import {useFeedback} from '../../ui/overlay';
import {Card, CardBody, CardHeader, Notice, Switch} from '../../ui/core';
import {chatName, type Chat} from '../../lib/chats-model';
import {chatHref, telegramSettingsHref, Unsaved, type Telegram} from './shared';

function telegramProblem(chat: Chat): string | null {
  const state = chat.telegram?.state;
  if (state === 'migrated')
    return `Telegram moved this group to a new ID${
      chat.telegram?.migrate_to_chat_id ? ` (${chat.telegram.migrate_to_chat_id})` : ''
    }. Turn Nocheh on in the new group instead.`;
  if (state === 'not_member') return 'Nocheh’s bot isn’t in this group. Add the bot in Telegram first.';
  if (state === 'not_found') return 'Telegram doesn’t know this group any more.';
  return null;
}

function ReplyMode({telegram}: {telegram: Telegram}) {
  const names = telegram.names.length ? telegram.names.map(name => `“${name}”`).join(' or ') : 'its name';
  return (
    <p className="text-[13px] text-muted">
      {telegram.replies === 'all'
        ? 'Answers every message from people allowed here.'
        : `Answers only when called: a reply to it, its @username, or a message starting with ${names}.`}{' '}
      <a href={telegramSettingsHref} className="font-medium text-accent-text hover:underline">
        Change in Settings › Telegram
      </a>
    </p>
  );
}

export function NochehHere({chat, parent, telegram}: {chat: Chat; parent: Chat | null; telegram: Telegram}) {
  const {confirm} = useFeedback();
  const problem = telegramProblem(chat.kind === 'topic' && parent ? parent : chat);

  if (chat.kind === 'private') {
    const owner = chat.space_id === telegram.owner;
    return (
      <Card>
        <CardHeader title="Nocheh here" />
        <CardBody className="pt-2 text-sm">
          {owner
            ? 'Always on. Only you talk to Nocheh here.'
            : 'Off. Nocheh only answers you in private chats, so it doesn’t reply to this person.'}
        </CardBody>
      </Card>
    );
  }

  if (chat.kind === 'topic') {
    const group = chat.parent_space ?? '';
    const on = telegram.isOn(group);
    return (
      <Card>
        <CardHeader title="Nocheh here" />
        <CardBody className="space-y-2 pt-2">
          {problem && <Notice tone="warn">{problem}</Notice>}
          <p className="text-sm">
            Follows its group,{' '}
            <a href={chatHref(group)} className="font-medium text-accent-text hover:underline" dir="auto">
              {parent ? chatName(parent) : 'the group'}
            </a>
            , where Nocheh is <strong>{on ? 'on' : 'off'}</strong>.
          </p>
          {on && <ReplyMode telegram={telegram} />}
        </CardBody>
      </Card>
    );
  }

  const group = chat.space_id;
  const on = telegram.isOn(group);
  const change = async (next: boolean) => {
    const rule = telegram.rule(group);
    if (!next && (rule.granted.length || rule.denied.length)) {
      const ok = await confirm({
        title: 'Turn Nocheh off in this group?',
        body: 'This also forgets who you allowed to talk to it here.',
        confirm: 'Turn off',
        danger: true,
      });
      if (!ok) return;
    }
    telegram.setGroup(group, next);
  };
  return (
    <Card>
      <CardHeader title="Nocheh here" />
      <CardBody className="space-y-3 pt-2">
        {problem && <Notice tone="warn">{problem}</Notice>}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="group-on" className="text-sm font-medium">
                {on ? 'On in this group' : 'Off in this group'}
              </label>
              <Unsaved show={telegram.onChanged(group)} />
            </div>
            <p className="mt-0.5 text-[13px] text-muted">
              {on ? 'You can always talk to it here.' : 'Turn on to let Nocheh answer here.'}
            </p>
          </div>
          <Switch
            id="group-on"
            checked={on}
            disabled={!telegram.loaded || telegram.busy}
            onChange={value => void change(value)}
            label="Nocheh in this group"
          />
        </div>
        {on && <ReplyMode telegram={telegram} />}
      </CardBody>
    </Card>
  );
}
