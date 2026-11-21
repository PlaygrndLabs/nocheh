/** The table of members, and the daily message cap every member shares. */
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
import {Button, Card, Dot, Empty, Field, Input, LoadingRows, Pager, Table, Td, Th} from '../../ui/core';
import {ActionError, useAction} from '../chats/shared';
import {memberHref} from './hooks';
import {byName, groupSummary, memberError, personMeta, personName, type MemberAnswer} from './model';

/** Members on one page of the table. */
const PAGE = 10;

export function MemberList({
  list,
  loading,
  known,
}: {
  list: Members | null;
  loading: boolean;
  known: ReadonlyMap<string, Person>;
}) {
  const [page, setPage] = useState(0);
  const members = [...(list?.members ?? [])].sort(byName(known));
  const paused = members.filter(member => member.state === 'paused').length;
  const last = Math.max(0, Math.ceil(members.length / PAGE) - 1);
  const current = Math.min(page, last);
  const none = <span className="text-muted max-sm:hidden">—</span>;
  return (
    <Card>
      {loading && <LoadingRows rows={3} />}
      {list && !members.length && (
        <Empty icon={Contact} title="No members yet">
          Add someone Nocheh has seen in your groups, or add them by their Telegram user ID.
        </Empty>
      )}
      {members.length > 0 && (
        <Table aria-label="Members" className="max-sm:block [&>tbody]:max-sm:block">
          <thead className="max-sm:sr-only">
            <tr>
              <Th scope="col">Member</Th>
              <Th scope="col">Telegram</Th>
              <Th scope="col">State</Th>
              <Th scope="col">Groups</Th>
              <Th scope="col">Private chat</Th>
            </tr>
          </thead>
          <tbody>
            {members.slice(current * PAGE, (current + 1) * PAGE).map(member => {
              const meta = personMeta(member, known);
              return (
                <tr
                  key={member.id}
                  className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-0.5 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2.5 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0"
                >
                  <Td className="max-w-0 sm:w-[30%] max-sm:w-full max-sm:max-w-none">
                    <a
                      href={memberHref(member.id)}
                      onClick={event => {
                        event.preventDefault();
                        setParams({member: member.id});
                      }}
                      className="block truncate font-medium hover:underline"
                      dir="auto"
                    >
                      {personName(member, known)}
                    </a>
                  </Td>
                  <Td className="text-[13px] whitespace-nowrap text-muted">{meta || none}</Td>
                  <Td className="text-[13px] whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Dot tone={member.state === 'paused' ? 'warn' : 'good'} />
                      {member.state === 'paused' ? 'Paused' : 'Active'}
                    </span>
                  </Td>
                  <Td className="text-[13px] whitespace-nowrap text-muted">{groupSummary(member)}</Td>
                  <Td className="text-[13px] whitespace-nowrap text-muted">
                    <span className="sm:hidden">Private chat </span>
                    <span>{member.permissions.private_chat ? 'On' : 'Off'}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Pager
        page={current}
        hasNext={current < last}
        onPage={setPage}
        summary={
          members.length
            ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` + (paused ? `, ${paused} paused` : '')
            : undefined
        }
      />
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
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <h2 className="text-[15px] font-semibold">Daily messages</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {`Each member can talk to Nocheh ${value.toLocaleString()} ${value === 1 ? 'time' : 'times'} a day.`}
          </p>
          <p className={cn('mt-1 text-xs', draft !== null && !valid ? 'text-bad' : 'text-muted')}>
            {draft !== null && !valid
              ? 'Choose a whole number from 1 to 10,000.'
              : 'Across all their groups, per UTC day. Past it they get one short reply in that group. You have no limit.'}
          </p>
        </div>
        <form
          className="flex max-w-full items-end gap-2"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label="Times each member may ask Nocheh a day"
            htmlFor="daily-messages"
            className="w-80 min-w-0 shrink"
          >
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
      </div>
      <ActionError text={action.error} />
    </Card>
  );
}
