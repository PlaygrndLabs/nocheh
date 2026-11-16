/** "Nocheh here": whether Nocheh answers in this chat, and how. */
import {useState} from 'react';
import {useFeedback} from '../../ui/overlay';
import {Card, CardBody, CardHeader, Notice, Switch} from '../../ui/core';
import {
  chatName,
  chatStateLabels,
  chatStateText,
  currentAppId,
  isOn,
  switchable,
  type Chat,
} from '../../lib/chats-model';
import {JoinNotes, JoinProjectDialog, useJoinQuestion} from './project';
import {ActionError, chatHref, telegramSettingsHref, useAction, useChatNames, type Telegram} from './shared';

function telegramProblem(chat: Chat): string | null {
  const state = chat.telegram?.state;
  // A group Telegram upgraded once Nocheh had its own chat ids goes on as the same chat under its new Telegram id.
  const followed = !!chat.telegram?.migrate_to_chat_id && chat.telegram.migrate_to_chat_id === currentAppId(chat);
  if (state === 'migrated' && !followed)
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
  const problem = telegramProblem(chat.kind === 'topic' && parent ? parent : chat);

  if (chat.kind === 'private') {
    const owner = chat.owner === true;
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
    // A topic follows its group. Only the group's own item says who added Nocheh or that it was removed; until it
    // loads, the topic's copy of the group's state still says where Nocheh stands.
    const base = parent?.kind === 'group' ? parent : chat;
    const on = isOn(base);
    const state = base.state && base.state !== 'active' && base.state !== 'off' ? base.state : null;
    const link = (
      <a href={chatHref(group)} className="font-medium text-accent-text hover:underline" dir="auto">
        {parent ? chatName(parent) : 'the group'}
      </a>
    );
    return (
      <Card>
        <CardHeader title="Nocheh here" />
        <CardBody className="space-y-2 pt-2">
          {problem && switchable(base) && <Notice tone="warn">{problem}</Notice>}
          {state ? (
            <>
              <p className="text-sm">
                Follows its group, {link}: <strong>{chatStateLabels[state]}</strong>.
              </p>
              <p className="text-[13px] text-muted">{chatStateText(base)}</p>
            </>
          ) : (
            <p className="text-sm">
              Follows its group, {link}, where Nocheh is <strong>{on ? 'on' : 'off'}</strong>.
            </p>
          )}
          {on && <ReplyMode telegram={telegram} />}
        </CardBody>
      </Card>
    );
  }

  return <GroupPresence chat={chat} problem={problem} telegram={telegram} />;
}

/**
 * A group's switch, which turns Nocheh on or off there at once (ADR-0253). Turning it on in a group with no project
 * answer first asks which project it joins: one of yours, a new one named after the group, or none; in a group already
 * in a project, it first names that project's other groups and its task list. Turning it off asks first: Nocheh stays
 * in the group, silent, and the people you allowed are kept. Only a group Nocheh is in has a switch; any other says
 * where Nocheh stands.
 */
function GroupPresence({chat, problem, telegram}: {chat: Chat; problem: string | null; telegram: Telegram}) {
  const {confirm} = useFeedback();
  const names = useChatNames();
  const action = useAction();
  const group = chat.space_id;
  const name = chatName(chat);
  const on = isOn(chat);
  const join = useJoinQuestion(group);
  const [asking, setAsking] = useState(false);
  const change = async (next: boolean) => {
    if (next && join.ask) {
      setAsking(true);
      return;
    }
    if (
      next &&
      join.project &&
      !(await confirm({
        title: `Turn Nocheh on in ${name}?`,
        body: <JoinNotes space={group} name={name} project={join.project} names={names} />,
        confirm: 'Turn on',
      }))
    )
      return;
    if (
      !next &&
      !(await confirm({
        title: `Turn Nocheh off in “${name}”?`,
        body: 'It stays in the group, silent. People you allowed are kept.',
        confirm: 'Turn off',
        danger: true,
      }))
    )
      return;
    await action.run(
      'state',
      '/chats/state',
      {chat_id: group, state: next ? 'active' : 'off'},
      {success: next ? `Nocheh is on in ${name}.` : `Nocheh is off in ${name}.`},
    );
  };
  const title = on
    ? 'On in this group'
    : chat.state && chat.state !== 'off'
      ? chatStateLabels[chat.state]
      : 'Off in this group';
  const canSwitch = switchable(chat);
  return (
    <Card>
      <CardHeader title="Nocheh here" />
      <CardBody className="space-y-3 pt-2">
        {problem && canSwitch && <Notice tone="warn">{problem}</Notice>}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            {canSwitch ? (
              <label htmlFor="group-on" className="text-sm font-medium">
                {title}
              </label>
            ) : (
              <p className="text-sm font-medium">{title}</p>
            )}
            <p className="mt-0.5 text-[13px] text-muted">{chatStateText(chat)}</p>
          </div>
          {canSwitch && (
            <Switch
              id="group-on"
              checked={on}
              disabled={!!action.busy || (!on && (!join.settled || !currentAppId(chat)))}
              onChange={value => void change(value)}
              label="Nocheh in this group"
            />
          )}
        </div>
        {on && <ReplyMode telegram={telegram} />}
        <ActionError text={action.error} />
      </CardBody>
      {asking && <JoinProjectDialog chat={chat} open onDone={() => setAsking(false)} />}
    </Card>
  );
}
