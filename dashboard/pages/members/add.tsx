/**
 * Adds a member: someone Nocheh has seen in its groups, with their groups all ticked, or anyone by their Telegram user ID,
 * with every group Nocheh is in to tick and none ticked. Every group shown is sent, unticked ones as off, because a
 * member's group with no switch counts as on. The new member starts with every permission on.
 */
import {useState} from 'react';
import {UserPlus} from 'lucide-react';
import type {MemberGroupRef, MemberList, MemberResult} from '../../../src/member-wire';
import {chatStateLabels, validUserId, type Person} from '../../lib/chats-model';
import {setParams} from '../../lib/routes';
import {Button, Field, Input, Notice, Segmented, Select} from '../../ui/core';
import {Dialog} from '../../ui/overlay';
import {ActionError, useAction, useTelegram} from '../chats/shared';
import {memberHref} from './hooks';
import {addGroups, byName, memberError, personMeta, personName} from './model';

type Mode = 'seen' | 'id';

export function AddMember({
  list,
  known,
  person,
  onClose,
}: {
  list: MemberList;
  known: ReadonlyMap<string, Person>;
  /** The person "Make member" chose, by account; null to choose here. */
  person: string | null;
  onClose: () => void;
}) {
  const telegram = useTelegram();
  const action = useAction(memberError);
  const people = [...list.people].sort(byName(known));
  const already = person ? list.members.find(member => member.account_id === person) : undefined;
  const [mode, setMode] = useState<Mode>(people.length || person ? 'seen' : 'id');
  const [chosen, setChosen] = useState(person && people.some(item => item.account_id === person) ? person : '');
  // Seen: their groups start ticked and the owner unticks; by ID: none start ticked and the owner ticks.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [telegramId, setTelegramId] = useState('');
  const [idError, setIdError] = useState('');
  const target = people.find(item => item.account_id === chosen) ?? null;
  const shown: MemberGroupRef[] = mode === 'seen' ? (target?.groups ?? []) : list.groups;
  const on = (chat: string) => (mode === 'seen' ? !unticked.has(chat) : ticked.has(chat));
  const toggle = (chat: string, value: boolean) => {
    const update = (set: Set<string>, add: boolean) => {
      const next = new Set(set);
      if (add) next.add(chat);
      else next.delete(chat);
      return next;
    };
    if (mode === 'seen') setUnticked(current => update(current, !value));
    else setTicked(current => update(current, value));
  };
  const anyOn = shown.some(group => on(group.chat_id));
  const ready = anyOn && (mode === 'seen' ? !!target : !!telegramId.trim());

  const submit = async () => {
    action.clear();
    let body: Record<string, unknown>;
    let label: string;
    const groups = addGroups(
      shown.map(group => group.chat_id),
      new Set(shown.filter(group => on(group.chat_id)).map(group => group.chat_id)),
    );
    if (mode === 'seen') {
      if (!target) return;
      body = {account_id: target.account_id, groups};
      label = personName(target, known);
    } else {
      const id = telegramId.trim();
      if (!validUserId(id)) return setIdError('A Telegram user ID is a number, like 123456789.');
      if (id === telegram.ownerAccount) return setIdError('That’s you. You can always talk to Nocheh.');
      if (list.members.some(member => member.telegram_id === id)) return setIdError('This person is already a member.');
      body = {telegram_id: id, groups};
      label = personName({name: null, username: null, telegram_id: id}, known);
    }
    const result = await action.run<MemberResult>('add', '/members', body, {success: `${label} is a member now.`});
    if (result?.member) setParams({add: null, member: result.member.id});
  };

  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title="Add a member"
      description="They may talk to Nocheh in the groups you tick, with every permission on. You can change any of it after."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={action.busy === 'add'} disabled={!ready} onClick={() => void submit()}>
            <UserPlus aria-hidden /> Add member
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          if (ready) void submit();
        }}
      >
        <Segmented
          label="Who to add"
          value={mode}
          options={[
            {value: 'seen', label: 'Seen in your groups'},
            {value: 'id', label: 'By Telegram user ID'},
          ]}
          onChange={next => {
            setMode(next);
            action.clear();
          }}
        />
        {already && (
          <Notice tone="info">
            {personName(already, known)} is already a member.{' '}
            <a href={memberHref(already.id)} className="font-medium text-accent-text hover:underline">
              Open their page
            </a>
          </Notice>
        )}
        {mode === 'seen' ? (
          people.length ? (
            <Field label="Person" htmlFor="add-person" hint="People Telegram shows in your groups who aren’t members.">
              <Select
                id="add-person"
                value={chosen}
                onChange={event => {
                  setChosen(event.target.value);
                  setUnticked(new Set());
                }}
              >
                <option value="">Choose someone</option>
                {people.map(item => {
                  const meta = personMeta(item, known);
                  return (
                    <option key={item.account_id} value={item.account_id}>
                      {personName(item, known) + (meta ? ' · ' + meta : '')}
                    </option>
                  );
                })}
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-muted">
              Nobody new is seen in your groups yet. People show here once they write in a group Nocheh is in. You can
              still add someone by their Telegram user ID.
            </p>
          )
        ) : (
          <Field
            label="Telegram user ID"
            htmlFor="add-telegram-id"
            error={idError}
            hint="They can talk in the groups you tick from their first message there. Posts into a group from another and their jobs there wait until Telegram has shown them in it."
          >
            <Input
              id="add-telegram-id"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 123456789"
              value={telegramId}
              onChange={event => {
                setTelegramId(event.target.value);
                setIdError('');
              }}
            />
          </Field>
        )}
        {(mode === 'id' || target) && (
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">Groups</legend>
            <p className="text-xs text-muted">
              {mode === 'seen'
                ? 'Every group Telegram shows them in is ticked. A group you untick stays off until you switch it on.'
                : 'Every group Nocheh is in. Tick where they may talk; the others stay off until you switch them on.'}{' '}
              A group they join later starts on.
            </p>
            {shown.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {shown.map(group => (
                  <li key={group.chat_id}>
                    <label className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={on(group.chat_id)}
                        onChange={event => toggle(group.chat_id, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {group.title?.trim() || 'Unnamed group'}
                      </span>
                      {group.state !== 'active' && (
                        <span className="shrink-0 text-xs text-muted">Nocheh: {chatStateLabels[group.state]}</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nocheh isn’t in any group yet.</p>
            )}
            {!anyOn && shown.length > 0 && <p className="text-xs text-muted">Tick at least one group.</p>}
          </fieldset>
        )}
        <ActionError text={action.error} />
      </form>
    </Dialog>
  );
}
