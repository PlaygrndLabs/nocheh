/** The table of every chat: search, private chats, then groups with their topics, ten a page. */
import {useDeferredValue, useState} from 'react';
import {Hash, RefreshCw, Search} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {useServedGroups} from '../../lib/chat-directory';
import {refreshResources} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {
  chatError,
  chatName,
  chatStateLabels,
  chatTree,
  kindLabel,
  shortIdLabel,
  type Chat,
} from '../../lib/chats-model';
import {cn} from '../../lib/utils';
import {Button, Card, Dot, Empty, Input, LoadError, LoadingRows, Pager, Select, Table, Td, Th} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useChats} from './shared';

/** Chats on one page of the table. */
const PAGE = 10;

type Listed = {chat: Chat; nested?: boolean; state?: Chat['state']};

/** Every chat in the order the table and the switcher list it: private chats, then each group with its topics. */
function listed(tree: ReturnType<typeof chatTree>): Listed[] {
  return [
    // Where Nocheh stands: your own private chat is on, another person's is off.
    ...tree.privates.map(chat => ({chat, state: chat.owner ? ('active' as const) : ('off' as const)})),
    ...tree.groups.flatMap(({group, topics}) => [
      {chat: group, state: group.state},
      ...topics.map(chat => ({chat, nested: true})),
    ]),
  ];
}

export function ChatList() {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const {directory, identities, items, more} = useChats(deferred);
  const served = useServedGroups(30000);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const {toast} = useFeedback();

  const rows = listed(chatTree(items, identities.data?.groups ?? [], deferred));
  const last = Math.max(0, Math.ceil(rows.length / PAGE) - 1);
  const current = Math.min(page, last);
  const shown = rows.slice(current * PAGE, (current + 1) * PAGE);
  // Telegram is asked about the groups Nocheh is on in, not the chats this list loaded or found: up to 50 a press, those
  // checked longest ago first, and the answer counts the others not checked in the last hour. When they can't be read,
  // the server decides.
  const canRefresh = served.items.length > 0 || !!served.error;

  const refreshNames = async () => {
    setRefreshing(true);
    try {
      const result = await apiPost<{chats: {chat_id: string}[]; remaining?: number}>('/telegram/chats/refresh', {});
      await refreshResources();
      // An upgraded group answers twice; it is one group.
      const count = new Set(result?.chats?.map(chat => chat.chat_id)).size;
      const remaining = result?.remaining ?? 0;
      // A press checks at most 50, so the toast never says the next one checks them all.
      toast(
        `Checked ${count} ${count === 1 ? 'group' : 'groups'} with Telegram.` +
          (remaining > 0
            ? ` ${remaining} more ${remaining === 1 ? 'hasn’t' : 'haven’t'} been checked in the last hour. Press again to check more.`
            : ''),
      );
    } catch (error) {
      toast(chatError(error), 'bad');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="relative min-w-0 flex-1 basis-64 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <label htmlFor="chat-search" className="sr-only">
            Find a chat
          </label>
          <Input
            id="chat-search"
            type="search"
            value={query}
            placeholder="Find a chat by name or Telegram ID"
            className="pl-9"
            onChange={event => {
              setPage(0);
              setQuery(event.target.value);
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted sm:ml-auto"
          busy={refreshing}
          disabled={!canRefresh}
          title="Asks Telegram for the current group names. Nothing is sent to anyone."
          onClick={() => void refreshNames()}
        >
          {!refreshing && <RefreshCw aria-hidden />}
          {refreshing ? 'Checking with Telegram…' : 'Refresh group names'}
          <span className="sr-only"> (asks Telegram for names; nothing is sent to anyone)</span>
        </Button>
      </div>
      {directory.error && !directory.data && (
        <LoadError className="m-3" what="chats" onRetry={() => void refreshResources()} />
      )}
      {!directory.data && !directory.error && <LoadingRows rows={5} />}
      {directory.data && (
        <>
          {directory.error && <p className="px-4 pt-3 text-xs text-warn">The list may be out of date.</p>}
          {!rows.length ? (
            <Empty icon={Search} title={deferred ? 'No chats match' : 'No chats yet'}>
              {deferred
                ? 'Try another name or ID.'
                : 'Message the bot in Telegram, or add it to a group, and the chat shows up here.'}
            </Empty>
          ) : (
            <Table aria-label="Chats" className="max-sm:block [&>tbody]:max-sm:block">
              <thead className="max-sm:sr-only">
                <tr>
                  <Th scope="col">Chat</Th>
                  <Th scope="col">Kind</Th>
                  <Th scope="col">Nocheh here</Th>
                  <Th scope="col">Short ID</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map(row => (
                  <Row key={row.chat.space_id} {...row} />
                ))}
              </tbody>
            </Table>
          )}
          <Pager
            page={current}
            hasNext={current < last}
            onPage={setPage}
            summary={
              more && !deferred
                ? 'Showing the first 100 chats. Search to find others.'
                : rows.length > PAGE
                  ? `${rows.length} chats · page ${current + 1} of ${last + 1}`
                  : undefined
            }
          />
        </>
      )}
    </Card>
  );
}

function Row({chat, nested, state}: Listed) {
  const short = shortIdLabel(chat);
  const none = <span className="text-muted max-sm:hidden">—</span>;
  return (
    <tr className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0">
      <Td className="max-w-0 py-2 sm:w-[46%] max-sm:w-full max-sm:max-w-none">
        <a
          href={'#chats?chat=' + encodeURIComponent(chat.space_id)}
          onClick={event => {
            event.preventDefault();
            setParams({chat: chat.space_id});
          }}
          className={cn('flex min-w-0 items-center gap-2 hover:underline', nested && 'sm:pl-6')}
        >
          {nested && <Hash className="size-3.5 shrink-0 text-muted" aria-hidden />}
          <span dir="auto" className={cn('min-w-0 truncate', nested ? 'text-[13px]' : 'font-medium')}>
            {chatName(chat)}
          </span>
          {chat.closed && <span className="shrink-0 text-xs text-muted">Closed</span>}
        </a>
      </Td>
      <Td className="py-2 text-[13px] whitespace-nowrap text-muted">
        {nested && chat.parent_name ? (
          <>
            Topic in <span dir="auto">{chat.parent_name}</span>
          </>
        ) : (
          kindLabel(chat)
        )}
      </Td>
      <Td className="py-2 text-[13px] whitespace-nowrap">
        {state ? (
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={state === 'active' ? 'good' : 'neutral'} />
            <span className={state === 'active' ? undefined : 'text-muted'}>{chatStateLabels[state]}</span>
          </span>
        ) : (
          none
        )}
      </Td>
      <Td className="py-2 whitespace-nowrap">{short ? <ShortId value={short} /> : none}</Td>
    </tr>
  );
}

/**
 * Another chat, chosen from the open chat's page: the same chats in the same order as the table, so going from one
 * chat to the next does not need the table in between.
 */
export function ChatSwitch({selected}: {selected: string}) {
  const {identities, items} = useChats();
  const rows = listed(chatTree(items, identities.data?.groups ?? [], ''));
  return (
    <Select
      aria-label="Open another chat"
      value={rows.some(row => row.chat.space_id === selected) ? selected : ''}
      className="h-8 w-auto max-w-64 text-[13px]"
      onChange={event => event.target.value && setParams({chat: event.target.value})}
    >
      <option value="" disabled>
        Open another chat
      </option>
      {rows.map(({chat, nested}) => {
        const short = shortIdLabel(chat);
        return (
          <option key={chat.space_id} value={chat.space_id}>
            {(nested ? '\u00a0\u00a0# ' : '') + chatName(chat) + (short ? ' ' + short : '')}
          </option>
        );
      })}
    </Select>
  );
}

/** A chat's short ID after its name, as a send card or a notice adds it to a name that reads like another's. */
export function ShortId({value}: {value: string}) {
  return (
    <span
      className="shrink-0 font-mono text-xs text-muted"
      title="Short ID: a card or notice adds it after a name that reads like another chat’s"
    >
      {value}
    </span>
  );
}
