/**
 * One member, in three sub-tabs: their permissions; their private chat with Nocheh (step 4) and their groups; Pause or
 * Remove. Each switch posts at once with an operation ID, so a retry is never applied twice, then shows a toast; there is
 * no Save bar, so only the open sub-tab is on the page.
 */
import {ArrowLeft, UserMinus} from 'lucide-react';
import type {MemberChanges, MemberItem, MemberPermission, MemberRemoved, MemberResult} from '../../../src/member-wire';
import {chatStateLabels, type Person} from '../../lib/chats-model';
import {useSubTab} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, CardHeader, Notice, Segmented, Select, Switch} from '../../ui/core';
import {SubPanel, SubTabs} from '../../ui/page';
import {useFeedback} from '../../ui/overlay';
import {ActionError, chatHref, useAction} from '../chats/shared';
import {byName, memberError, personMeta, personName, presenceLabel, type MemberAnswer} from './model';

/** The three things talking to Nocheh lets a member do, under it, in the owner's words. */
const permissions: {key: MemberPermission; title: string; hint: string}[] = [
  {
    key: 'jobs',
    title: 'Small jobs (no daily limit)',
    hint: 'Long work they approve themselves, within your job limits. A job over your cost limit still asks you.',
  },
  {
    key: 'post',
    title: 'Post to their other groups',
    hint: 'They confirm each post with a card. A group Telegram hasn’t shown them in goes to your card instead.',
  },
  {
    key: 'tools',
    title: 'Web pages and outside tools (no approval)',
    hint: 'Opens web pages and uses connected tools without asking you. Commands still ask you, Notion is never used in a group, and each chat’s tool switches still apply.',
  },
];

const subTabs = [
  {id: 'can', label: 'What they can do'},
  {id: 'chats', label: 'Private chat and groups'},
  {id: 'pause', label: 'Pause or remove'},
] as const;
const subTabIds = subTabs.map(item => item.id);

export function MemberDetail({
  member,
  members,
  known,
  onSaved,
}: {
  member: MemberItem;
  /** Every member, for the way straight to another one. */
  members: readonly MemberItem[];
  known: ReadonlyMap<string, Person>;
  /** Shows what a change answered at once, until the list reloads with it. */
  onSaved: (answer: MemberAnswer) => void;
}) {
  const action = useAction(memberError);
  const {confirm} = useFeedback();
  const name = personName(member, known);
  const meta = personMeta(member, known);
  const allowed = member.permissions;
  const paused = member.state === 'paused';
  const busy = !!action.busy;
  const change = async (key: string, changes: MemberChanges, success: string) => {
    const answer = await action.run<MemberResult>(key, '/members/' + member.id, {changes}, {success});
    if (answer?.member) onSaved(answer);
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: `Remove ${name} as a member?`,
        body: 'They can’t talk to Nocheh in any of your groups or in their private chat with it any more, and their switches are deleted. Their tasks and reminders stay. Their private chat stays in Messages. You can add them again later.',
        confirm: 'Remove',
        danger: true,
      }))
    )
      return;
    const removed = await action.run<MemberRemoved>(
      'remove',
      '/members/' + member.id + '/remove',
      {},
      {success: `${name} is no longer a member.`},
    );
    if (!removed) return;
    if (removed.removed) onSaved(removed);
    setParams({member: null, tab: null});
  };
  const added = new Date(member.added_at);
  const [tab, setTab] = useSubTab(subTabIds);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap-reverse items-start justify-between gap-x-4 gap-y-2">
        <header className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-semibold" dir="auto">
              {name}
            </h2>
            {paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="good">Active</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {[
              meta,
              Number.isNaN(added.getTime())
                ? null
                : 'Member since ' + added.toLocaleDateString(undefined, {dateStyle: 'medium'}),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>
        {/* Back to the table of members, and the way straight to another member. */}
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => setParams({member: null, tab: null})}>
            <ArrowLeft aria-hidden /> All members
          </Button>
          <Select
            aria-label="Open another member"
            value={member.id}
            className="h-8 w-auto max-w-56 text-[13px]"
            onChange={event => setParams({member: event.target.value})}
          >
            {[...members].sort(byName(known)).map(item => (
              <option key={item.id} value={item.id}>
                {personName(item, known)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {member.owner_linked && (
        <Notice tone="warn" title="This is your own Telegram account">
          You can always talk to Nocheh, so none of these switches apply to you. Remove this member to tidy up.
        </Notice>
      )}
      {paused && (
        <Notice tone="warn" title="Paused">
          They can’t talk to Nocheh in any group or in their private chat with it, and their jobs, posts and tool runs
          stop. Their switches are kept for when you resume them.
        </Notice>
      )}
      <SubTabs label="This member" tabs={[...subTabs]} value={tab} onChange={setTab} />
      {tab === 'can' && (
        <SubPanel id="can" current={tab}>
          <Card>
            <CardHeader title="What they can do" description="In every group that is on for them." />
            <div className="mt-3 border-t border-line">
              <Row
                id="member-talk"
                title="Talk to Nocheh in groups they joined"
                hint="Off, nothing below works either. Each switch keeps its own setting for when talk is back on."
                checked={allowed.talk}
                disabled={busy}
                onChange={on =>
                  void change(
                    'talk',
                    {talk: on},
                    on ? `${name} can talk to Nocheh again.` : `${name} can’t talk to Nocheh now.`,
                  )
                }
              />
              {permissions.map(({key, title, hint}) => (
                <Row
                  key={key}
                  id={'member-' + key}
                  title={title}
                  hint={hint}
                  nested
                  checked={allowed[key]}
                  disabled={busy || !allowed.talk}
                  onChange={on =>
                    void change(key, {[key]: on}, `${title.replace(/ \(.*\)$/, '')}: ${on ? 'on' : 'off'}.`)
                  }
                />
              ))}
              <div className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Tasks</p>
                  <p className="text-[13px] text-muted">
                    {allowed.tasks === 'read' ? 'Read only' : 'Read and write'}, in groups and the members’ app: the
                    whole task list of each project with a group they joined.
                  </p>
                </div>
                <Segmented
                  label="Tasks"
                  value={allowed.tasks}
                  disabled={busy}
                  options={[
                    {value: 'write', label: 'Read and write'},
                    {value: 'read', label: 'Read only'},
                  ]}
                  onChange={tasks =>
                    void change(
                      'tasks',
                      {tasks},
                      tasks === 'read' ? `${name} can only read tasks now.` : `${name} can read and change tasks.`,
                    )
                  }
                />
              </div>
              <Row
                id="member-reminders"
                title="Reminders to themselves"
                hint={
                  allowed.tasks === 'read'
                    ? 'Needs Tasks read and write. Their switch is kept for when you give it back.'
                    : 'They set reminders on tasks, in groups and the members’ app, and Nocheh sends each to their private chat with it. Off, they can’t set any. With their private chat off, the app can’t set one, and one they set in a group comes to you.'
                }
                nested
                checked={allowed.reminders}
                disabled={busy || allowed.tasks === 'read'}
                onChange={on =>
                  void change(
                    'reminders',
                    {reminders: on},
                    on ? `${name} can set reminders to themselves.` : `${name} can’t set reminders now.`,
                  )
                }
              />
            </div>
            <p className="border-t border-line px-5 py-3 text-[13px] text-muted">
              Members open the app from the menu button in their private chat with Nocheh.
            </p>
          </Card>
        </SubPanel>
      )}
      {tab === 'chats' && (
        <SubPanel id="chats" current={tab}>
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Private chat"
                description="Their own chat with Nocheh in Telegram. Group talk off doesn’t stop it."
              />
              <div className="mt-3 border-t border-line">
                <Row
                  id="member-private-chat"
                  title="Private chat with Nocheh"
                  hint="They can ask Nocheh about the groups they joined and see the tasks of those groups’ projects. There it only reads: no posts, jobs, web pages or task changes. You can read the chat under Messages › Members’ chats. Off, or paused, they get one short reply a day instead."
                  checked={allowed.private_chat}
                  disabled={busy}
                  onChange={on =>
                    void change(
                      'private_chat',
                      {private_chat: on},
                      on ? `${name} can talk to Nocheh privately.` : `${name} can’t talk to Nocheh privately now.`,
                    )
                  }
                />
                <Row
                  id="member-assistant"
                  title="Personal assistant"
                  hint={
                    allowed.private_chat
                      ? 'They set their own schedules by asking in their private chat, such as a morning brief, and each result comes there with no card. Runs read only what they may read. They see their schedules in the members’ app; you see all of them on the Schedules page. Off, their schedules stop running and are kept.'
                      : 'Needs Private chat with Nocheh. Their switch is kept for when you give it back.'
                  }
                  nested
                  checked={allowed.assistant}
                  disabled={busy || !allowed.private_chat}
                  onChange={on =>
                    void change(
                      'assistant',
                      {assistant: on},
                      on ? `${name} can set their own schedules.` : `${name}’s schedules stop now.`,
                    )
                  }
                />
              </div>
            </Card>
            <Card>
              <CardHeader
                title="Groups"
                description="Where they may talk to Nocheh. A group they join later is on until you switch it off. Their first message in a group is enough to talk there; posts into it from another group and their jobs there wait until Telegram has shown them in it."
              />
              {member.groups.length ? (
                <ul className="mt-3 divide-y divide-line border-t border-line">
                  {member.groups.map(group => {
                    const [presence, tone] = presenceLabel(group.telegram);
                    const title = group.title?.trim() || 'Unnamed group';
                    return (
                      <li key={group.chat_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                        <div className="min-w-0 flex-1">
                          <a
                            href={chatHref(group.chat_id)}
                            className="block truncate text-sm font-medium hover:underline"
                            dir="auto"
                          >
                            {title}
                          </a>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Badge tone={tone}>{presence}</Badge>
                            {group.new && <Badge tone="info">New here</Badge>}
                            {group.state !== 'active' && (
                              <span className="text-xs text-muted">Nocheh here: {chatStateLabels[group.state]}</span>
                            )}
                          </div>
                        </div>
                        <Switch
                          checked={group.on}
                          disabled={busy}
                          label={`${name} in ${title}`}
                          onChange={on =>
                            void change(
                              'group:' + group.chat_id,
                              {groups: {[group.chat_id]: on}},
                              on ? `${name} can talk in ${title}.` : `${name} is off in ${title}.`,
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-muted">
                  No groups yet. They show once Telegram shows them in a group.
                </p>
              )}
            </Card>
          </div>
        </SubPanel>
      )}
      {tab === 'pause' && (
        <SubPanel id="pause" current={tab}>
          <Card>
            <CardHeader title="Pause or remove" />
            <div className="mt-3 border-t border-line">
              <Row
                id="member-pause"
                title="Pause this member"
                hint="Stops everything they do, in every group and in their private chat: talk, jobs, posts and tool runs. Their switches are kept."
                checked={paused}
                disabled={busy}
                onChange={on =>
                  void change(
                    'state',
                    {state: on ? 'paused' : 'active'},
                    on ? `${name} is paused.` : `${name} is active again.`,
                  )
                }
              />
              <div className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Remove this member</p>
                  <p className="text-[13px] text-muted">
                    Deletes them and their switches, and their private chat stops. Their tasks, reminders and messages
                    stay.
                  </p>
                </div>
                <Button variant="danger" busy={action.busy === 'remove'} disabled={busy} onClick={() => void remove()}>
                  <UserMinus aria-hidden /> Remove
                </Button>
              </div>
            </div>
          </Card>
        </SubPanel>
      )}
      <ActionError text={action.error} />
    </div>
  );
}

function Row({
  id,
  title,
  hint,
  checked,
  disabled,
  nested,
  onChange,
}: {
  id: string;
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  nested?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 border-t border-line py-2.5 pr-5 first:border-t-0',
        nested ? 'pl-10' : 'pl-5',
      )}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <p className="text-[13px] text-muted">{hint}</p>
      </div>
      <Switch id={id} label={title} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}
