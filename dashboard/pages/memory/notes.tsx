/**
 * Memory › Notes: the assistant's own working notes and its past
 * conversations for one chat profile. Read only.
 */
import {useEffect, useState} from 'react';
import {MessageSquareText, NotebookPen} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dot,
  Empty,
  Field,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Select,
  Table,
  Td,
  Th,
  type Tone,
} from '../../ui/core';
import {Drawer} from '../../ui/overlay';
import {ago, dateTime} from '../../lib/system-format';
import {noteDayText, type NoteEntry} from '../../lib/memory-sources';
import {OriginalList} from '../../lib/originals';
import {useChats} from './shared';
import {earlierSuffix, notesProfiles, type Profile} from './notes-profiles';

/** One note, with where it came from in your words (ADR-0257); `from` is the fixed kind its colour is keyed on, and
 * `day` and `originals` the day it names and the messages its writer read (ADR-0261 step 4). */
type Entry = NoteEntry;
type Note = {name: string; exists: boolean; text: string; truncated?: boolean; citations: unknown[]; entries?: Entry[]};
/** One past conversation: its title, its first message, where it ran, and when it started and last went on. */
type Session = {
  id: string;
  title: string;
  preview?: string;
  source: string;
  started_at?: string | null;
  last_active?: string | null;
  messages?: number;
};
type MemoryView = {memories: Note[]; sessions: Session[]; next_offset?: number | null};
/** Past conversations listed on one page of the table. */
const PAGE = 10;
type Message = {id: string; role: string; content: unknown; truncated?: boolean};

const noteTitle: Record<string, string> = {'MEMORY.md': 'General notes', 'USER.md': 'About you'};
// Your own messages only; Nocheh's own work; other people's words or what a turn read; nobody known.
const fromTone: Record<string, Tone> = {
  owner: 'good',
  nocheh: 'info',
  turn: 'info',
  person: 'warn',
  forward: 'warn',
  file: 'warn',
  mixed: 'warn',
  turn_read: 'warn',
};
const roleLabel: Record<string, string> = {
  user: 'Person',
  assistant: 'Assistant',
  tool: 'Tool result',
  system: 'Instructions',
};
const sourceLabel: Record<string, string> = {
  telegram: 'Telegram',
  browser: 'Browser chat',
  cli: 'Terminal',
  cron: 'Scheduled',
  scheduler: 'Scheduled',
  background: 'Background job',
};

/** A conversation's name: its title, else its first message, else what it is. */
export function sessionName(s: Session): string {
  return s.title.trim() || s.preview?.trim() || 'Conversation without text';
}

/** When a conversation last went on: how long ago within a week, its day after that. */
export function sessionDay(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  return now - time < 7 * 86400000
    ? ago(value, now)
    : new Date(time).toLocaleDateString(undefined, {dateStyle: 'medium'});
}

/** Where a conversation ran, in words; nothing for a kind Nocheh doesn't name. */
export function sessionWhere(source: string): string {
  return sourceLabel[source] ?? '—';
}

/**
 * A member's private chat by the member's name, and your question about a member by when it ran; each is marked as
 * what it is, never shown as your own chat or a group.
 */
export function memberProfileLabel(p: Profile, chatName: (scope: string) => string): string | null {
  if (p.member_read) {
    const day = p.answer_at ? new Date(p.answer_at) : null;
    const date = day && !Number.isNaN(day.getTime()) ? day.toLocaleDateString() : p.profile.slice(-6);
    return 'Your question about a member · ' + date;
  }
  if (!p.member) return null;
  const name = chatName(p.scope);
  return name && name !== 'Unknown chat' ? 'Member · ' + name : 'Member · a private chat';
}

function answerLabel(p: Profile) {
  const day = p.answer_at ? new Date(p.answer_at) : null;
  const date = day && !Number.isNaN(day.getTime()) ? ' · ' + day.toLocaleDateString() : '';
  return 'Private answer · ' + (p.answer_group ? p.answer_group + date : p.profile.slice(-6));
}

export function Notes() {
  const chosen = useParam('profile');
  const session = useParam('session');
  const chats = useChats();
  const profiles = useResource<{profiles: Profile[]; history_profiles?: Profile[]}>('/memory/profiles', 60000);
  const listed = profiles.data?.history_profiles ?? profiles.data?.profiles ?? [];
  const {list, first} = notesProfiles(listed);
  const profile = list.find(p => p.profile === chosen) ?? first;
  // Each private answer has its own profile in your private chat, named by where it was asked, as its first line names
  // it, and the day it ran; one without that receipt by a short tail of its name.
  // A member's private chat and your questions about a member are named as what they are (step 4), and listed after
  // your own chat and the groups, so a member's chat is never the one a page opens on; it opens on your private chat's
  // current notes, never an earlier setup's (notesProfiles).
  const label = (p: Profile) =>
    (memberProfileLabel(p, chats.name) ??
      (p.private_answer ? answerLabel(p) : p.owner ? 'Your private chat' : chats.name(p.scope))) +
    earlierSuffix(p, list);
  const memoryQuery = profile
    ? new URLSearchParams({scope: profile.scope, profile: profile.profile, limit: String(PAGE)})
    : null;
  const memory = useResource<MemoryView>(memoryQuery ? '/memory?' + memoryQuery : null, 30000);
  // The first page comes with the notes; a later one on its own, so the notes stay in place while paging.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [profile?.profile]);
  const later = useResource<MemoryView>(
    memoryQuery && page > 0 ? '/memory?' + memoryQuery + '&offset=' + page * PAGE : null,
    30000,
  );
  const conversations = page > 0 ? later : memory;
  // Messages from people not allowed where they wrote stay out of your notes; the reviews list counts them.
  const reviews = useResource<{kept_out?: number}>('/memory/reviews', 60000);
  const keptOut = reviews.data?.kept_out ?? 0;
  // A group's USER.md is what Nocheh noted about the people there, not about you.
  const title = (name: string) =>
    name === 'USER.md' && profile?.member
      ? 'About this member'
      : name === 'USER.md' && profile && !profile.owner && !profile.private_answer
        ? 'About people here'
        : (noteTitle[name] ?? name);
  const sessions = conversations.data?.sessions ?? [];

  if (profiles.error && !profiles.data)
    return <LoadError what="chat profiles" error={profiles.error} onRetry={() => void refreshResources()} />;
  if (!profiles.data) return <LoadingRows rows={4} />;
  if (!list.length)
    return (
      <Card>
        <Empty icon={NotebookPen} title="No chats set up yet">
          Notes appear once your Telegram chat or a group is set up in Settings and the assistant has talked there.
        </Empty>
      </Card>
    );

  return (
    <>
      <Field label="Chat" htmlFor="notes-profile" className="max-w-sm">
        <Select
          id="notes-profile"
          value={profile?.profile ?? ''}
          onChange={event => setParams({profile: event.target.value, session: null}, true)}
        >
          {list.map(p => (
            <option key={p.profile} value={p.profile}>
              {label(p)}
            </option>
          ))}
        </Select>
      </Field>
      {memory.error && (
        <LoadError what="notes for this chat" error={memory.error} onRetry={() => void refreshResources()} />
      )}
      {keptOut > 0 && (
        <p className="text-[13px] text-muted">
          {keptOut === 1
            ? '1 message from a person not allowed there was kept out of your notes (it’s still in group memory).'
            : `${keptOut} messages from people not allowed there were kept out of your notes (they’re still in group memory).`}
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader
            title="Working notes"
            description="What the assistant wrote down for itself. Check important points against the original messages."
          />
          <CardBody className="space-y-5">
            {!memory.data && !memory.error ? (
              <LoadingRows rows={3} />
            ) : (
              memory.data?.memories.map(note => (
                <section key={note.name}>
                  <h3 className="mb-1.5 text-sm font-semibold">{title(note.name)}</h3>
                  {note.entries?.length ? (
                    <NotesTable label={title(note.name)} entries={note.entries} />
                  ) : note.exists && note.text ? (
                    <pre
                      className="max-h-[28rem] overflow-auto rounded-lg bg-subtle p-3 font-sans text-[13px] leading-relaxed break-words whitespace-pre-wrap"
                      dir="auto"
                    >
                      {note.text}
                    </pre>
                  ) : (
                    <p className="text-[13px] text-muted">Nothing written yet.</p>
                  )}
                  {note.truncated && <p className="mt-1 text-xs text-muted">Showing the first part only.</p>}
                </section>
              ))
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Past conversations"
            description="What the assistant said in this chat, latest first. Open one to read it."
          />
          {conversations.error && (
            <div className="px-5 pb-3">
              <LoadError
                what="past conversations"
                error={conversations.error}
                onRetry={() => void refreshResources()}
              />
            </div>
          )}
          {!conversations.data && !conversations.error ? (
            <LoadingRows rows={3} />
          ) : conversations.data && sessions.length === 0 ? (
            <Empty icon={MessageSquareText} title={page ? 'Nothing older' : 'No conversations yet'} className="py-6">
              {page ? 'Go back to the latest conversations.' : 'They appear after the assistant answers in this chat.'}
            </Empty>
          ) : (
            sessions.length > 0 && (
              <Table aria-label="Past conversations" className="table-fixed">
                <thead>
                  <tr>
                    <Th scope="col">Conversation</Th>
                    <Th scope="col" className="hidden w-32 sm:table-cell lg:hidden 2xl:table-cell">
                      Where
                    </Th>
                    <Th scope="col" className="w-32">
                      Last active
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(item => (
                    <tr key={item.id} className="hover:bg-subtle/60">
                      <Td className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setParams({session: item.id})}
                          className="block w-full min-w-0 text-left"
                        >
                          <span className="block truncate font-medium hover:underline" dir="auto">
                            {sessionName(item)}
                          </span>
                          {item.title.trim() && item.preview?.trim() && (
                            <span className="block truncate text-xs text-muted" dir="auto">
                              {item.preview}
                            </span>
                          )}
                        </button>
                      </Td>
                      <Td className="hidden text-muted sm:table-cell lg:hidden 2xl:table-cell">
                        {sessionWhere(item.source)}
                      </Td>
                      <Td
                        className="whitespace-nowrap text-muted"
                        title={
                          dateTime(item.last_active) +
                          (item.messages ? ` · ${item.messages} message${item.messages === 1 ? '' : 's'}` : '')
                        }
                      >
                        {sessionDay(item.last_active)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          )}
          <Pager
            page={page}
            hasNext={conversations.data?.next_offset != null}
            labels={['Newer', 'Older']}
            onPage={setPage}
          />
        </Card>
      </div>

      <Conversation
        profile={profile}
        session={session}
        title={(() => {
          const open = sessions.find(s => s.id === session);
          return open && sessionName(open);
        })()}
      />
    </>
  );
}

/** Notes listed on one page of a working-notes table. */
const NOTES_PAGE = 8;

/** One notes file as a table: each note with where it came from, a page at a time. */
function NotesTable({label, entries}: {label: string; entries: Entry[]}) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(entries.length / NOTES_PAGE);
  useEffect(() => setPage(current => Math.min(current, Math.max(0, pages - 1))), [pages]);
  const rows = entries.slice(page * NOTES_PAGE, (page + 1) * NOTES_PAGE);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <Table aria-label={label} className="table-fixed">
        <thead>
          <tr>
            <Th scope="col">Note</Th>
            <Th scope="col" className="hidden w-2/5 sm:table-cell">
              Where it came from
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry, index) => (
            // On a phone each note's source sits under it, not beside it.
            <tr key={page * NOTES_PAGE + index} className="block border-b border-line last:border-b-0 sm:table-row">
              <Td
                className="block border-b-0 pb-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap sm:table-cell sm:pb-2.5"
                dir="auto"
              >
                {entry.text}
              </Td>
              <Td className="block space-y-1 border-b-0 pt-0 sm:table-cell sm:pt-2.5">
                <p className="flex items-baseline gap-1.5 text-xs text-muted" title={entry.label}>
                  <Dot tone={fromTone[entry.from] ?? 'neutral'} className="size-1.5 translate-y-[-1px]" />
                  <span className="min-w-0 break-words">{entry.label}</span>
                </p>
                <NoteSources entry={entry} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {pages > 1 && (
        <div className="border-t border-line">
          <Pager
            page={page}
            hasNext={page + 1 < pages}
            onPage={setPage}
            summary={`${entries.length} notes · page ${page + 1} of ${pages}`}
          />
        </div>
      )}
    </div>
  );
}

/** The day a note names and the messages its writer read: a review's batch, or the message a turn answered. */
function NoteSources({entry}: {entry: Entry}) {
  const day = noteDayText(entry.day);
  if (!day && !entry.originals?.length) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted">
      {day && <span>{day}</span>}
      {!!entry.originals?.length && (
        <OriginalList originals={entry.originals} short className="text-xs" label="Original messages" />
      )}
    </div>
  );
}

function Conversation({profile, session, title}: {profile: Profile | null; session: string | null; title?: string}) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [session]);
  const messages = useResource<{messages: Message[]; next_offset: number | null}>(
    profile && session
      ? '/memory?' +
          new URLSearchParams({scope: profile.scope, profile: profile.profile, session, offset: String(offset)})
      : null,
  );
  const rows = messages.data?.messages ?? [];
  return (
    <Drawer
      open={!!session}
      onOpenChange={open => !open && setParams({session: null})}
      title={title || 'Conversation'}
      wide
      footer={
        (offset > 0 || messages.data?.next_offset != null) && (
          <>
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Earlier
            </Button>
            <Button
              size="sm"
              disabled={messages.data?.next_offset == null}
              onClick={() => setOffset(messages.data!.next_offset!)}
            >
              Later
            </Button>
          </>
        )
      }
    >
      {messages.error && <LoadError what="this conversation" onRetry={() => void refreshResources()} />}
      {!messages.data && !messages.error && <LoadingRows rows={4} />}
      {messages.data && rows.length === 0 && <Notice>This conversation has no messages to show.</Notice>}
      <ol className="space-y-3">
        {rows.map((message, index) => (
          <li
            key={message.id || index}
            className={
              'rounded-xl px-4 py-3 ' +
              (message.role === 'assistant'
                ? 'bg-accent-soft/60'
                : message.role === 'user'
                  ? 'bg-subtle'
                  : 'border border-line')
            }
          >
            <p className="mb-1 text-xs font-medium text-muted">{roleLabel[message.role] ?? message.role}</p>
            <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap" dir="auto">
              {typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}
            </pre>
            {message.truncated && <p className="mt-1 text-xs text-muted">Shortened.</p>}
          </li>
        ))}
      </ol>
    </Drawer>
  );
}
