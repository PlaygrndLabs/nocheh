/** The list of every chat: search, private chats, then groups with their topics. */
import {useDeferredValue, useState} from 'react';
import {Hash, MessageCircle, RefreshCw, Search, Users} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {refreshResources} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {chatError, chatName, chatTree, type Chat} from '../../lib/chats-model';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, Empty, Input, LoadError, LoadingRows} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useChats, type Telegram} from './shared';

export function ChatList({selected, telegram}: {selected: string | null; telegram: Telegram}) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const {directory, identities, items, more} = useChats(deferred);
  const [refreshing, setRefreshing] = useState(false);
  const {toast} = useFeedback();

  const extra = [...(identities.data?.groups ?? []), ...telegram.groupIds.map(id => ({id, name: null}))];
  const tree = chatTree(items, extra, telegram.groupIds, deferred, telegram.owner);
  const nothing = !tree.privates.length && !tree.groups.length;

  const refreshNames = async () => {
    setRefreshing(true);
    try {
      const result = await apiPost<{chats: unknown[]}>('/telegram/chats/refresh', {});
      await refreshResources();
      const count = result?.chats?.length ?? 0;
      toast(`Checked ${count} ${count === 1 ? 'group' : 'groups'} with Telegram.`);
    } catch (error) {
      toast(chatError(error), 'bad');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card className="flex min-h-0 flex-col lg:max-h-[calc(100dvh-3rem)]">
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
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
            placeholder="Find a chat by name or ID"
            className="pl-9"
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted"
          busy={refreshing}
          disabled={!telegram.savedGroupIds.length}
          title="Asks Telegram for the current group names. Nothing is sent to anyone."
          onClick={() => void refreshNames()}
        >
          {!refreshing && <RefreshCw aria-hidden />}
          {refreshing ? 'Checking with Telegram…' : 'Refresh group names'}
          <span className="sr-only"> (asks Telegram for names; nothing is sent to anyone)</span>
        </Button>
      </div>
      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {directory.error && !directory.data && (
          <LoadError className="m-3" what="chats" onRetry={() => void refreshResources()} />
        )}
        {!directory.data && !directory.error && <LoadingRows rows={5} />}
        {directory.data && (
          <>
            {directory.error && <p className="px-4 pt-3 text-xs text-warn">The list may be out of date.</p>}
            {nothing ? (
              <Empty icon={Search} title={deferred ? 'No chats match' : 'No chats yet'}>
                {deferred
                  ? 'Try another name or ID.'
                  : 'Message the bot in Telegram, or add it to a group, and the chat shows up here.'}
              </Empty>
            ) : (
              <>
                <Section icon={MessageCircle} title="Private chats">
                  {tree.privates.length ? (
                    tree.privates.map(chat => (
                      <Row
                        key={chat.space_id}
                        chat={chat}
                        label={chatName(chat, telegram.owner)}
                        selected={selected === chat.space_id}
                        state={chat.space_id === telegram.owner ? 'on' : 'off'}
                      />
                    ))
                  ) : (
                    <p className="px-4 py-1.5 text-[13px] text-muted">{deferred ? 'None match.' : 'None yet.'}</p>
                  )}
                </Section>
                <Section icon={Users} title="Groups">
                  {tree.groups.length ? (
                    tree.groups.map(({group, topics}) => (
                      <li key={group.space_id}>
                        <ul>
                          <Row
                            chat={group}
                            label={chatName(group)}
                            selected={selected === group.space_id}
                            state={telegram.isOn(group.space_id) ? 'on' : 'off'}
                            unsaved={telegram.onChanged(group.space_id)}
                          />
                          {topics.map(topic => (
                            <Row
                              key={topic.space_id}
                              chat={topic}
                              label={chatName(topic)}
                              selected={selected === topic.space_id}
                              nested
                            />
                          ))}
                        </ul>
                      </li>
                    ))
                  ) : (
                    <p className="px-4 py-1.5 text-[13px] text-muted">
                      {deferred ? 'None match.' : 'None yet. Add Nocheh’s bot to a Telegram group.'}
                    </p>
                  )}
                </Section>
                {more && !deferred && (
                  <p className="px-4 pt-2 text-xs text-muted">Showing the first 100 chats. Search to find others.</p>
                )}
              </>
            )}
          </>
        )}
      </nav>
    </Card>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{className?: string}>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-3">
      <h2 className="flex items-center gap-1.5 px-4 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
        <Icon className="size-3.5" /> {title}
      </h2>
      <ul className="px-2">{children}</ul>
    </div>
  );
}

function Row({
  chat,
  label,
  selected,
  state,
  nested,
  unsaved,
}: {
  chat: Chat;
  label: string;
  selected: boolean;
  state?: 'on' | 'off';
  nested?: boolean;
  unsaved?: boolean;
}) {
  return (
    <li>
      <a
        href={'#chats?chat=' + encodeURIComponent(chat.space_id)}
        onClick={event => {
          event.preventDefault();
          setParams({chat: chat.space_id});
        }}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
          nested && 'pl-7',
          selected ? 'bg-accent-soft text-accent-text' : 'hover:bg-subtle',
        )}
      >
        {nested && <Hash className="size-3.5 shrink-0 text-muted" aria-hidden />}
        <span dir="auto" className={cn('min-w-0 flex-1 truncate', nested ? 'text-[13px]' : 'font-medium')}>
          {label}
        </span>
        {unsaved && (
          <span className="size-1.5 shrink-0 rounded-full bg-warn" title="Not saved yet">
            <span className="sr-only">Not saved yet</span>
          </span>
        )}
        {chat.closed && <span className="shrink-0 text-xs text-muted">Closed</span>}
        {state === 'on' && (
          <Badge tone="good" className="shrink-0">
            On
          </Badge>
        )}
        {state === 'off' && <span className="shrink-0 text-xs text-muted">Off</span>}
      </a>
    </li>
  );
}
