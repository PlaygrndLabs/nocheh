/** The list of members, and the daily message cap every member shares. */
import {useState} from 'react';
import {Contact} from 'lucide-react';
import {
  DAILY_MESSAGES_MAX,
  DAILY_MESSAGES_MIN,
  type MemberList as Members,
  type MemberSettingsResult,
} from '../../../src/member-wire';
import type {Person} from '../../lib/chats-model';
import {setParams} from '../../lib/routes';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, LoadingRows} from '../../ui/core';
import {ActionError, useAction} from '../chats/shared';
import {memberHref} from './hooks';
import {byName, groupSummary, memberError, personMeta, personName, type MemberAnswer} from './model';

export function MemberList({
  list,
  loading,
  selected,
  known,
}: {
  list: Members | null;
  loading: boolean;
  selected: string | null;
  known: ReadonlyMap<string, Person>;
}) {
  const members = [...(list?.members ?? [])].sort(byName(known));
  const paused = members.filter(member => member.state === 'paused').length;
  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader
        title="Members"
        description={
          list
            ? members.length
              ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` +
                (paused ? `, ${paused} paused` : '')
              : undefined
            : undefined
        }
      />
      <nav aria-label="Members" className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-line pb-2">
        {loading && <LoadingRows rows={3} />}
        {list && !members.length && (
          <Empty icon={Contact} title="No members yet">
            Add someone Nocheh has seen in your groups, or add them by their Telegram user ID.
          </Empty>
        )}
        {members.length > 0 && (
          <ul className="px-2 pt-2">
            {members.map(member => {
              const meta = personMeta(member, known);
              return (
                <li key={member.id}>
                  <a
                    href={memberHref(member.id)}
                    onClick={event => {
                      event.preventDefault();
                      setParams({member: member.id});
                    }}
                    aria-current={selected === member.id ? 'true' : undefined}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-lg px-2 py-2 transition-colors',
                      selected === member.id ? 'bg-accent-soft' : 'hover:bg-subtle',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        dir="auto"
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm font-medium',
                          selected === member.id && 'text-accent-text',
                        )}
                      >
                        {personName(member, known)}
                      </span>
                      {member.state === 'paused' ? (
                        <Badge tone="warn" className="shrink-0">
                          Paused
                        </Badge>
                      ) : (
                        <Badge tone="good" className="shrink-0">
                          Active
                        </Badge>
                      )}
                    </span>
                    {meta && <span className="truncate text-xs text-muted">{meta}</span>}
                    <span className="text-xs text-muted">{groupSummary(member)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </Card>
  );
}

/**
 * The daily message cap: how many times each member may talk to Nocheh in a UTC day, across all their groups. Unlike the
 * switches it is typed, so it has its own Save; the answer shows at once.
 */
export function DailyMessages({value, onSaved}: {value: number; onSaved: (answer: MemberAnswer) => void}) {
  const [draft, setDraft] = useState<string | null>(null);
  const action = useAction(memberError);
  const text = draft ?? String(value);
  const number = Number(text);
  const valid = Number.isSafeInteger(number) && number >= DAILY_MESSAGES_MIN && number <= DAILY_MESSAGES_MAX;
  const save = async () => {
    if (!valid || number === value) return;
    const saved = await action.run<MemberSettingsResult>(
      'daily',
      '/members/settings',
      {daily_messages: number},
      {success: `Each member can talk to Nocheh ${number.toLocaleString()} times a day.`},
    );
    if (saved) {
      onSaved(saved);
      setDraft(null);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Daily messages"
        description={`Each member can talk to Nocheh ${value.toLocaleString()} ${value === 1 ? 'time' : 'times'} a day.`}
      />
      <CardBody>
        <form
          className="flex items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Times each member may ask Nocheh a day" htmlFor="daily-messages" className="min-w-0 flex-1">
            <Input
              id="daily-messages"
              type="number"
              inputMode="numeric"
              min={DAILY_MESSAGES_MIN}
              max={DAILY_MESSAGES_MAX}
              step={1}
              value={text}
              disabled={action.busy === 'daily'}
              onChange={event => {
                setDraft(event.target.value);
                action.clear();
              }}
            />
          </Field>
          <Button type="submit" busy={action.busy === 'daily'} disabled={!valid || number === value}>
            Save
          </Button>
        </form>
        <p className={cn('mt-2 text-xs', draft !== null && !valid ? 'text-bad' : 'text-muted')}>
          {draft !== null && !valid
            ? 'Choose a whole number from 1 to 10,000.'
            : 'Across all their groups, per UTC day. Past it they get one short reply in that group. You have no limit.'}
        </p>
        <ActionError text={action.error} />
      </CardBody>
    </Card>
  );
}
