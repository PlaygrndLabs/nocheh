/**
 * Messages › list: search and filter every kept message in a table that fits one screen; a row opens its detail. Other people's private chats with Nocheh
 * (members', and those of people who wrote privately without being one) are left out of the default list and kept under
 * their own "Members' chats" filter, so they never show when the owner shares their screen (step 4).
 */
import {useEffect, useState, type ComponentType} from 'react';
import {
  Bot,
  CornerDownRight,
  FileText,
  Globe,
  Image,
  MessageSquare,
  Mic,
  Paperclip,
  Search,
  Smile,
  X,
} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {useResource, refreshResources} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import {cn} from '../../lib/utils';
import {
  actionStatus,
  contentText,
  fullTime,
  isAssistant,
  messageText,
  reactionText,
  replyFilters,
  replyStatus,
  rowId,
  rows,
  when,
  type MessageList,
  rowSender,
  type MessageRow,
  type ReplyPreview,
} from '../../lib/messages-format';
import {
  Badge,
  Button,
  Card,
  Dot,
  Empty,
  Input,
  LoadError,
  LoadingRows,
  Pager,
  Segmented,
  Select,
  Table,
  Td,
  Th,
} from '../../ui/core';
import {chatFilter, membersChats, useChatNames, useOtherPrivate} from './chat-names';

/** Rows seen in the list, so the detail can show a message's reply state. */
export const seenRows = new Map<string, MessageRow>();

type Direction = '' | 'incoming' | 'assistant';
/** Messages on a page. A reply sits under its message, so more are asked for than are shown. */
const SHOWN = 10,
  ASKED = '30';

function typeIcon(row: MessageRow): ComponentType<{className?: string}> {
  const types = row.content_types ?? [];
  if (row.reaction_preview) return Smile;
  if (isAssistant(row.kind)) return Bot;
  if (row.kind === 'browser_input') return Globe;
  if (types.some(type => ['voice', 'audio', 'video_note'].includes(type))) return Mic;
  if (types.some(type => ['photo', 'image', 'video', 'animation', 'sticker'].includes(type))) return Image;
  if (types.includes('document')) return FileText;
  if (types.length) return Paperclip;
  return MessageSquare;
}

function typeName(row: MessageRow): string {
  if (row.reaction_preview) return 'Reaction';
  if (isAssistant(row.kind)) return 'Assistant';
  if (row.kind === 'browser_input') return 'Browser chat';
  return 'Incoming';
}

export function MessageListView({onOpen}: {onOpen: (id: string) => void}) {
  const q = useParam('q') ?? '';
  const direction = (useParam('dir') ?? '') as Direction;
  const chat = useParam('chat') ?? '';
  const reply = useParam('reply') ?? '';
  const chatName = useChatNames();
  const otherPrivate = useOtherPrivate();
  const scopes = useResource<{scopes?: {scope: string; events: number}[]}>('/scopes', 60000);

  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft.trim() === q) return;
    const timer = setTimeout(() => setParams({q: draft.trim()}, true), 450);
    return () => clearTimeout(timer);
  }, [draft]);

  // A chat the directory hasn't named yet counts as a member's, so it never shows in the main list by mistake.
  const allScopes = scopes.data?.scopes ?? [];
  const ownScopes = allScopes.filter(item => otherPrivate(item.scope) === false);
  const memberScopes = allScopes.filter(item => otherPrivate(item.scope) !== false);

  const filterKey = [q, direction, chat, reply].join('|');
  const [cursors, setCursors] = useState<{key: string; pages: string[]}>({key: filterKey, pages: ['']});
  const pages = cursors.key === filterKey ? cursors.pages : [''];
  const after = pages.at(-1) ?? '';
  const params = new URLSearchParams({
    ...(q ? {q} : {limit: ASKED}),
    ...(after && !q ? {after} : {}),
    ...(direction ? {kind: direction} : {}),
    ...chatFilter(chat),
    ...(reply ? {reply} : {}),
  });
  const path = (q ? '/search' : '/data') + (params.size ? '?' + params : '');
  const list = useResource<MessageList | MessageRow[]>(path, 10000);
  const all = rows(list.data);
  for (const row of all) {
    seenRows.set(rowId(row), row);
    for (const message of row.reply_messages ?? [])
      if (!seenRows.has(message.id))
        seenRows.set(message.id, {
          id: message.id,
          scope: row.scope,
          kind: 'telegram_delivered_message',
          text: message.text,
          received_at: message.received_at,
          content_types: message.content_types,
        });
  }
  // A reply shown under its message is not listed a second time.
  const nested = new Set(
    direction === 'assistant' ? [] : all.flatMap(row => (row.reply_messages ?? []).map(m => m.id)),
  );
  const listed = all.filter(row => !nested.has(rowId(row)));
  const more = !Array.isArray(list.data) ? list.data?.next : null;
  const filtered = !!(direction || chat || reply);

  // A search's matches are paged here; the kept messages are paged by the message the page ends on.
  const [searchPage, setSearchPage] = useState({q, page: 0});
  const found = searchPage.q === q ? searchPage.page : 0;
  const visible = q ? listed.slice(found * SHOWN, (found + 1) * SHOWN) : listed.slice(0, SHOWN);
  const next = listed.length > SHOWN ? rowId(listed[SHOWN - 1]!) : more;

  const page = pages.length - 1;
  const goTo = (target: number) =>
    q
      ? setSearchPage({q, page: target})
      : setCursors({
          key: filterKey,
          pages: target > page && next ? [...pages, next] : pages.slice(0, target + 1),
        });

  const clearAll = () => {
    setDraft('');
    setParams({q: null, dir: null, chat: null, reply: null}, true);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <form
          role="search"
          className="relative min-w-56 flex-1"
          onSubmit={event => {
            event.preventDefault();
            setParams({q: draft.trim()}, true);
          }}
        >
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <label htmlFor="message-search" className="sr-only">
            Search messages
          </label>
          <Input
            id="message-search"
            type="search"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Search the words in a message…"
            className="pr-9 pl-9"
          />
          {draft && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setDraft('');
                setParams({q: null}, true);
              }}
              className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted hover:bg-subtle hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Direction>
            label="Direction"
            size="sm"
            value={direction}
            onChange={value => setParams({dir: value || null}, true)}
            options={[
              {value: '', label: 'All'},
              {value: 'incoming', label: 'Incoming'},
              {value: 'assistant', label: 'Assistant'},
            ]}
          />
          <div className="flex w-full min-w-0 gap-2 sm:w-auto">
            <label htmlFor="message-chat" className="sr-only">
              Chat
            </label>
            <Select
              id="message-chat"
              value={chat}
              onChange={event => setParams({chat: event.target.value || null}, true)}
              className="h-8 min-w-0 flex-1 text-[13px] sm:w-52 sm:flex-none"
            >
              <option value="">Your chats and groups</option>
              <option value={membersChats}>Members’ chats</option>
              {chat && chat !== membersChats && !scopes.data?.scopes?.some(item => item.scope === chat) && (
                <option value={chat}>{chatName(chat)}</option>
              )}
              {ownScopes.map(item => (
                <option key={item.scope} value={item.scope}>
                  {chatName(item.scope)} · {item.events}
                </option>
              ))}
              {memberScopes.length > 0 && (
                <optgroup label="Members’ chats">
                  {memberScopes.map(item => (
                    <option key={item.scope} value={item.scope}>
                      {chatName(item.scope)} · {item.events}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            <label htmlFor="message-reply" className="sr-only">
              Reply state
            </label>
            <Select
              id="message-reply"
              value={reply}
              onChange={event => setParams({reply: event.target.value || null}, true)}
              className="h-8 min-w-0 flex-1 text-[13px] sm:w-52 sm:flex-none"
            >
              {replyFilters.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          {(filtered || q) && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              <X aria-hidden /> Clear
            </Button>
          )}
        </div>
      </div>

      {list.error && <LoadError what="messages" onRetry={() => void refreshResources()} className="m-4 sm:m-5" />}
      {!list.data && !list.error && <LoadingRows rows={6} />}
      {list.data && !visible.length && (
        <Empty
          icon={q ? Search : MessageSquare}
          title={filtered || q ? 'No messages match' : 'No messages yet'}
          action={
            filtered || q ? (
              <Button size="sm" onClick={clearAll}>
                Clear search and filters
              </Button>
            ) : undefined
          }
        >
          {filtered || q
            ? q
              ? `Nothing kept contains “${q}”. Try fewer or different words.`
              : 'Change or clear a filter to see more.'
            : 'Messages appear here as soon as Nocheh receives them in Telegram. You can also import old Telegram chats.'}
        </Empty>
      )}
      {!!visible.length && (
        <Table aria-label={q ? 'Search results' : 'Messages'} className="max-sm:block [&>tbody]:max-sm:block">
          <thead className="max-sm:sr-only">
            <tr>
              <Th scope="col">Message</Th>
              <Th scope="col">Nocheh’s reply</Th>
              <Th scope="col">Chat</Th>
              <Th scope="col">When</Th>
              <Th scope="col">State</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map(row => (
              <MessageItem key={rowId(row)} row={row} chat={chatName(row.scope)} onOpen={onOpen} />
            ))}
          </tbody>
        </Table>
      )}
      {list.data && !!visible.length && (
        <Pager
          page={q ? found : page}
          hasNext={q ? (found + 1) * SHOWN < listed.length : !!next}
          onPage={goTo}
          labels={q ? ['Previous', 'Next'] : ['Newer', 'Older']}
          summary={
            q
              ? `${listed.length} best ${listed.length === 1 ? 'match' : 'matches'} for “${q}”`
              : `Newest first${page ? ` · page ${page + 1}` : ''}`
          }
        />
      )}
    </Card>
  );
}

function MessageItem({row, chat, onOpen}: {row: MessageRow; chat: string; onOpen: (id: string) => void}) {
  const id = rowId(row);
  const Icon = typeIcon(row);
  const text = row.reaction_preview ? reactionText(row)! : messageText(row);
  const words = !!row.text?.trim();
  const status = replyStatus(row);
  const action = row.action_review ? actionStatus(row.action_review) : null;
  const sender = rowSender(row);
  return (
    // On a phone the message takes the first line and its chat, time and state share the next.
    <tr className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0">
      <Td className="max-w-0 sm:w-[32%] max-sm:w-full max-sm:max-w-none">
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="flex w-full min-w-0 items-center gap-2 text-left focus-visible:underline focus-visible:outline-none"
        >
          <span
            className={cn('shrink-0', isAssistant(row.kind) ? 'text-accent-text' : 'text-muted')}
            title={typeName(row)}
          >
            <Icon className="size-4" aria-hidden />
            <span className="sr-only">{typeName(row)}</span>
          </span>
          <span dir="auto" className={cn('truncate text-sm', !words && !row.reaction_preview && 'text-muted italic')}>
            {text}
          </span>
        </button>
        {row.transcript_preview != null && (
          <p className="mt-0.5 truncate pl-6 text-xs text-muted" dir="auto">
            <span className="font-medium">Transcript (generated):</span> {row.transcript_preview || 'empty'}
          </p>
        )}
        {words && !!row.content_types?.length && (
          <p className="mt-0.5 flex items-center gap-1 pl-6 text-xs text-muted">
            <Paperclip className="size-3" aria-hidden /> {contentText(row.content_types)}
          </p>
        )}
        {action && row.action_review && (
          <a
            href={href('inbox', {action: row.action_review.id})}
            className="mt-1 ml-6 flex w-fit flex-wrap items-center gap-1.5 text-xs font-medium text-accent-text hover:underline"
          >
            <Badge tone={action.tone}>
              {action.label}
              {row.action_review.count > 1 ? ` (${row.action_review.count})` : ''}
            </Badge>
            Open the review ›
          </a>
        )}
      </Td>
      <Td className="max-w-0 sm:w-[24%] max-sm:w-full max-sm:max-w-none max-sm:pl-6">
        {(row.reply_messages ?? []).map(message => (
          <ReplyItem key={message.id} message={message} onOpen={onOpen} />
        ))}
      </Td>
      <Td className="max-w-48 truncate text-[13px] whitespace-nowrap text-muted max-sm:max-w-none">
        {sender && (
          <span className="text-fg/80" dir="auto">
            {sender} <span aria-hidden>in</span>{' '}
          </span>
        )}
        <span className="text-fg/80">{chat}</span>
      </Td>
      <Td className="text-[13px] whitespace-nowrap text-muted">
        <time dateTime={row.received_at} title={fullTime(row.received_at)}>
          {when(row.received_at)}
        </time>
      </Td>
      <Td className="text-[13px] whitespace-nowrap">
        {status && (
          <span className="flex items-center gap-2" title={status.note}>
            <Dot tone={status.tone} />
            {status.label}
          </span>
        )}
        {row.retired && <span className="block text-xs text-muted">Hidden from assistant</span>}
        {row.live_copy && (
          <span
            className="block text-xs text-muted"
            title="This imported message was also saved from the live chat, so the assistant uses that copy."
          >
            Also saved live
          </span>
        )}
        {!row.retired && row.agent_copy?.state === 'pending' && (
          <span
            className="block text-xs text-warn"
            title="The assistant can’t use this message until its copy is ready."
          >
            Assistant copy not ready
          </span>
        )}
      </Td>
    </tr>
  );
}

function ReplyItem({message, onOpen}: {message: ReplyPreview; onOpen: (id: string) => void}) {
  const text = message.text?.trim() || contentText(message.content_types) || 'Assistant message';
  return (
    <button
      type="button"
      onClick={() => onOpen(message.id)}
      aria-label={'Open the assistant’s reply: ' + text}
      title={fullTime(message.received_at)}
      className="flex w-full min-w-0 items-center gap-1.5 text-left text-[13px] text-muted hover:text-fg"
    >
      <CornerDownRight className="size-3.5 shrink-0 sm:hidden" aria-hidden />
      <span dir="auto" className="truncate">
        {text}
      </span>
    </button>
  );
}
