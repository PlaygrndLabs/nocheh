/**
 * Memory › Notes: the assistant's own working notes and its past
 * conversations for one chat profile. Read only.
 */
import {useEffect, useState} from 'react';
import {MessageSquareText, NotebookPen, Search} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  type Tone,
} from '../../ui/core';
import {Drawer} from '../../ui/overlay';
import {useChats} from './shared';

type Profile = {
  scope: string;
  profile: string;
  owner?: boolean;
  revision?: number;
  private_answer?: boolean;
  /** Where a private answer was asked, as its first line names it, and when it ran (ADR-0249). */
  answer_group?: string;
  answer_at?: string;
};
/** One note, with where it came from in your words (ADR-0257); `from` is the fixed kind its colour is keyed on. */
type Entry = {target: string; text: string; from: string; label: string};
type Note = {name: string; exists: boolean; text: string; truncated?: boolean; citations: unknown[]; entries?: Entry[]};
type Session = {id: string; title: string; source: string};
type MemoryView = {memories: Note[]; sessions: Session[]};
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
};

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
  const list = profiles.data?.history_profiles ?? profiles.data?.profiles ?? [];
  const profile = list.find(p => p.profile === chosen) ?? list[0] ?? null;
  // Each private answer has its own profile in your private chat, named by where it was asked, as its first line names
  // it, and the day it ran; one without that receipt by a short tail of its name.
  const label = (p: Profile) =>
    p.private_answer ? answerLabel(p) : p.owner ? 'Your private chat' : chats.name(p.scope);
  const memory = useResource<MemoryView>(
    profile ? '/memory?' + new URLSearchParams({scope: profile.scope, profile: profile.profile}) : null,
    30000,
  );
  // Messages from people not allowed where they wrote stay out of your notes; the reviews list counts them.
  const reviews = useResource<{kept_out?: number}>('/memory/reviews', 60000);
  const keptOut = reviews.data?.kept_out ?? 0;
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [profile?.profile]);
  // A group's USER.md is what Nocheh noted about the people there, not about you.
  const title = (name: string) =>
    name === 'USER.md' && profile && !profile.owner && !profile.private_answer
      ? 'About people here'
      : (noteTitle[name] ?? name);
  const sessions = (memory.data?.sessions ?? []).filter(s =>
    (s.title || s.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

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

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
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
                    <ul className="max-h-[28rem] space-y-2 overflow-auto rounded-lg bg-subtle p-3">
                      {note.entries.map((entry, index) => (
                        <li key={index} className="space-y-1">
                          <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap" dir="auto">
                            {entry.text}
                          </p>
                          <Badge
                            tone={fromTone[entry.from] ?? 'neutral'}
                            dot
                            title={entry.label}
                            className="whitespace-normal"
                          >
                            {entry.label}
                          </Badge>
                        </li>
                      ))}
                    </ul>
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
          <CardHeader title="Past conversations" description="What the assistant said in this chat." />
          <CardBody className="space-y-3">
            {(memory.data?.sessions.length ?? 0) > 6 && (
              <div className="relative">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
                <Input
                  type="search"
                  aria-label="Search conversations"
                  className="pl-9"
                  placeholder="Search titles"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </div>
            )}
            {!memory.data && !memory.error ? (
              <LoadingRows rows={3} />
            ) : memory.data && sessions.length === 0 ? (
              <Empty
                icon={MessageSquareText}
                title={query ? 'No matching conversations' : 'No conversations yet'}
                className="py-6"
              >
                {query ? 'Try other words.' : 'They appear after the assistant answers in this chat.'}
              </Empty>
            ) : (
              <ul className="-mx-2 space-y-0.5">
                {sessions.map(item => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setParams({session: item.id})}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-subtle"
                    >
                      <span className="min-w-0 flex-1 truncate">{item.title || 'Untitled conversation'}</span>
                      <Badge>{sourceLabel[item.source] ?? item.source}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Conversation
        profile={profile}
        session={session}
        title={memory.data?.sessions.find(s => s.id === session)?.title}
      />
    </>
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
