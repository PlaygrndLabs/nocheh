/** Messages › list: search and filter every kept message; a row opens its detail. */
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
import {Badge, Button, Card, Empty, Input, LoadError, LoadingRows, Pager, Segmented, Select} from '../../ui/core';
import {useChatNames} from './chat-names';

/** Rows seen in the list, so the detail can show a message's reply state. */
export const seenRows = new Map<string, MessageRow>();

type Direction = '' | 'incoming' | 'assistant';

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
  const scopes = useResource<{scopes?: {scope: string; events: number}[]}>('/scopes', 60000);

  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft.trim() === q) return;
    const timer = setTimeout(() => setParams({q: draft.trim()}, true), 450);
    return () => clearTimeout(timer);
  }, [draft]);

  const filterKey = [q, direction, chat, reply].join('|');
  const [cursors, setCursors] = useState<{key: string; pages: string[]}>({key: filterKey, pages: ['']});
  const pages = cursors.key === filterKey ? cursors.pages : [''];
  const after = pages.at(-1) ?? '';
  const params = new URLSearchParams({
    ...(q ? {q} : {}),
    ...(after && !q ? {after} : {}),
    ...(direction ? {kind: direction} : {}),
    ...(chat ? {scope: chat} : {}),
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
  const visible = all.filter(row => !nested.has(rowId(row)));
  const next = !Array.isArray(list.data) ? list.data?.next : null;
  const filtered = !!(direction || chat || reply);

  const page = pages.length - 1;
  const goTo = (target: number) =>
    setCursors({
      key: filterKey,
      pages: target > page && next ? [...pages, next] : pages.slice(0, target + 1),
    });

  const clearAll = () => {
    setDraft('');
    setParams({q: null, dir: null, chat: null, reply: null}, true);
  };

  return (
    <Card>
      <div className="space-y-3 border-b border-line px-4 py-4 sm:px-5">
        <form
          role="search"
          className="relative"
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
              <option value="">All chats</option>
              {chat && !scopes.data?.scopes?.some(item => item.scope === chat) && (
                <option value={chat}>{chatName(chat)}</option>
              )}
              {(scopes.data?.scopes ?? []).map(item => (
                <option key={item.scope} value={item.scope}>
                  {chatName(item.scope)} · {item.events}
                </option>
              ))}
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
            : 'Messages appear here as soon as Nocheh receives them in Telegram or the browser chat. You can also import old Telegram chats.'}
        </Empty>
      )}
      {!!visible.length && (
        <ul aria-label={q ? 'Search results' : 'Messages'}>
          {visible.map(row => (
            <MessageItem key={rowId(row)} row={row} chat={chatName(row.scope)} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {list.data && !!visible.length && (
        <div className="border-t border-line">
          <Pager
            page={q ? 0 : page}
            hasNext={!q && !!next}
            onPage={goTo}
            summary={
              q
                ? `${visible.length} best ${visible.length === 1 ? 'match' : 'matches'} for “${q}”`
                : `Newest first${page ? ` · page ${page + 1}` : ''}`
            }
          />
        </div>
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
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => onOpen(id)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors hover:bg-subtle/60 focus-visible:bg-subtle/60 focus-visible:outline-none sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5"
      >
        <span
          className={cn(
            'mt-0.5 grid size-8 place-items-center rounded-full',
            isAssistant(row.kind) ? 'bg-accent-soft text-accent-text' : 'bg-subtle text-muted',
          )}
          title={typeName(row)}
        >
          <Icon className="size-4" aria-hidden />
          <span className="sr-only">{typeName(row)}</span>
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            {sender && (
              <>
                <span className="truncate font-medium text-fg/80" dir="auto">
                  {sender}
                </span>
                <span aria-hidden>in</span>
              </>
            )}
            <span className="truncate font-medium text-fg/80">{chat}</span>
            <span aria-hidden>·</span>
            <time dateTime={row.received_at} title={fullTime(row.received_at)}>
              {when(row.received_at)}
            </time>
          </span>
          <span
            dir="auto"
            className={cn(
              'mt-0.5 line-clamp-2 block text-sm break-words',
              !words && !row.reaction_preview && 'text-muted italic',
            )}
          >
            {text}
          </span>
          {row.transcript_preview != null && (
            <span className="mt-1 line-clamp-1 block text-xs text-muted" dir="auto">
              <span className="font-medium">Transcript (generated):</span> {row.transcript_preview || 'empty'}
            </span>
          )}
          {words && !!row.content_types?.length && (
            <span className="mt-1 flex items-center gap-1 text-xs text-muted">
              <Paperclip className="size-3" aria-hidden /> {contentText(row.content_types)}
            </span>
          )}
        </span>
        <span className="col-start-2 flex flex-wrap gap-1.5 sm:col-start-3 sm:row-start-1 sm:max-w-56 sm:flex-col sm:items-end">
          {status && (
            <Badge tone={status.tone} dot title={status.note}>
              {status.label}
            </Badge>
          )}
          {row.retired && <Badge>Hidden from assistant</Badge>}
          {!row.retired && row.agent_copy?.state === 'pending' && (
            <Badge tone="warn" title="The assistant can’t use this message until its copy is ready.">
              Assistant copy not ready
            </Badge>
          )}
        </span>
      </button>
      {action && row.action_review && (
        <a
          href={href('inbox', {action: row.action_review.id})}
          className="-mt-1 flex w-fit flex-wrap items-center gap-1.5 pr-4 pb-3 pl-[60px] text-xs font-medium text-accent-text hover:underline sm:pr-5 sm:pl-[64px]"
        >
          <Badge tone={action.tone}>
            {action.label}
            {row.action_review.count > 1 ? ` (${row.action_review.count})` : ''}
          </Badge>
          Open the review ›
        </a>
      )}
      {(row.reply_messages ?? []).map(message => (
        <ReplyItem key={message.id} message={message} onOpen={onOpen} />
      ))}
    </li>
  );
}

function ReplyItem({message, onOpen}: {message: ReplyPreview; onOpen: (id: string) => void}) {
  const text = message.text?.trim() || contentText(message.content_types) || 'Assistant message';
  return (
    <button
      type="button"
      onClick={() => onOpen(message.id)}
      aria-label={'Open the assistant’s reply: ' + text}
      className="-mt-1 flex w-full items-start gap-2 py-2 pr-4 pl-[60px] text-left transition-colors hover:bg-subtle/60 sm:pr-5 sm:pl-[68px]"
    >
      <CornerDownRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 rounded-lg border border-line bg-accent-soft/40 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Bot className="size-3.5" aria-hidden /> <span className="font-medium text-fg/80">Assistant replied</span>
          <span aria-hidden>·</span>
          <time dateTime={message.received_at} title={fullTime(message.received_at)}>
            {when(message.received_at)}
          </time>
        </span>
        <span dir="auto" className="mt-0.5 line-clamp-2 block text-sm break-words">
          {text}
        </span>
      </span>
    </button>
  );
}
