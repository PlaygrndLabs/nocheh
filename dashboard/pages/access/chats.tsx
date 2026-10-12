import {useEffect, useRef, useState} from 'react';
import {MessageCircle, RefreshCw, Users} from 'lucide-react';
import {call} from '../../lib/api';
import {errorText} from '../../lib/page-helpers';
import {refreshResources, useResource} from '../../lib/resource';
import {Alert, Button} from '../../components/ui/primitives';
import {conversationName, type Conversation} from '../../components/conversations';
import {ChatDetail} from './chat-detail';
import type {TelegramSettings} from './telegram-settings';

export type Chat = Conversation & {
  parent_space?: string | null;
  configured?: boolean;
  observed_at?: string | null;
  closed?: boolean;
  registered?: boolean;
  telegram?: {state: string; migrate_to_chat_id: string | null};
};
type Directory = {items: Chat[]; next_cursor: string | null};
type IdentityGroup = {id: string; name?: string};

const selectedChat = () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('chat') ?? '';
export const chatHref = (space: string) => '#access?view=chats&chat=' + encodeURIComponent(space);

/** Every chat Nocheh knows, with topics under their group, beside the chosen chat's access. */
export function ChatsView({
  telegram,
  notify,
}: {
  telegram: TelegramSettings;
  notify: (text: string, error?: boolean) => void;
}) {
  const [query, setQuery] = useState(''),
    [chosen, setChosen] = useState(selectedChat),
    [refreshing, setRefreshing] = useState(false);
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On a phone the chosen chat opens below the list; bring it into view.
    if (chosen && matchMedia('(max-width: 860px)').matches) detail.current?.scrollIntoView({block: 'start'});
  }, [chosen]);
  useEffect(() => {
    const changed = () => setChosen(selectedChat());
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  const directory = useResource<Directory>('/conversations?limit=100'),
    identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities');
  const items = directory.data?.items ?? [];
  // Groups Nocheh has seen people in but that are not in the directory yet.
  const seen: Chat[] = (identities.data?.groups ?? [])
    .filter(group => !items.some(item => item.space_id === group.id))
    .map(group => ({space_id: group.id, name: group.name ?? null, kind: 'group'}));
  const all = [...items, ...seen];
  const matches = (chat: Chat) =>
    !query.trim() ||
    [chat.space_id, chat.name, chat.parent_name].some(value =>
      value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
  const topicsOf = (group: string) => all.filter(item => item.kind === 'topic' && item.parent_space === group);
  const privates = all.filter(item => item.kind === 'private' && matches(item));
  const groups = all
    .filter(item => item.kind === 'group')
    .filter(group => matches(group) || topicsOf(group.space_id).some(matches))
    .sort((a, b) => Number(telegram.groupIds.includes(b.space_id)) - Number(telegram.groupIds.includes(a.space_id)));
  // A chat beyond the loaded list still opens from a link.
  const current: Chat | null =
    all.find(item => item.space_id === chosen) ??
    (chosen
      ? {
          space_id: chosen,
          name: null,
          kind: chosen.includes('/topic/') ? 'topic' : chosen.startsWith('-') ? 'group' : 'private',
          parent_space: chosen.includes('/topic/') ? chosen.split('/topic/')[0] : null,
        }
      : null);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await call('/telegram/chats/refresh', {});
      await refreshResources();
      notify(`Checked ${result.chats.length} ${result.chats.length === 1 ? 'group' : 'groups'} with Telegram.`);
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setRefreshing(false);
    }
  };

  const link = (chat: Chat, label: string, note: string, nested = false) => (
    <li key={chat.space_id} className={nested ? 'access-chat-topic' : undefined}>
      <a
        href={chatHref(chat.space_id)}
        aria-current={chat.space_id === chosen ? 'true' : undefined}
        className="access-chat-link"
      >
        <span dir="auto">{label}</span>
        <small>{note}</small>
      </a>
    </li>
  );

  return (
    <div className="access-chats">
      <section className="n-panel access-chat-list" aria-label="Chats">
        <div className="access-chat-search">
          <label htmlFor="access-chat-search">Find a chat</label>
          <input
            id="access-chat-search"
            type="search"
            value={query}
            placeholder="Name or ID"
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        {directory.error && !directory.data && <Alert>The chat list is unavailable. Try again shortly.</Alert>}
        {!directory.data && !directory.error && <p role="status">Loading chats…</p>}
        {directory.data && (
          <>
            <h2>
              <MessageCircle size={16} aria-hidden="true" /> Private chats
            </h2>
            <ul className="access-chat-items">
              {privates.length ? (
                privates.map(chat =>
                  link(
                    chat,
                    chat.space_id === telegram.owner ? 'You' : conversationName(chat),
                    chat.space_id === telegram.owner ? 'Your private chat with Nocheh' : 'Private chat',
                  ),
                )
              ) : (
                <li className="n-muted">No private chats match.</li>
              )}
            </ul>
            <h2>
              <Users size={16} aria-hidden="true" /> Groups
            </h2>
            <ul className="access-chat-items">
              {groups.length ? (
                groups.flatMap(group => [
                  link(
                    group,
                    conversationName(group),
                    telegram.groupIds.includes(group.space_id) ? 'Nocheh is on' : 'Nocheh is off',
                  ),
                  ...topicsOf(group.space_id)
                    .filter(topic => matches(topic) || matches(group))
                    .map(topic => link(topic, conversationName(topic), 'Topic', true)),
                ])
              ) : (
                <li className="n-muted">
                  {query ? 'No groups match.' : 'No groups yet. Add Nocheh’s bot to a group.'}
                </li>
              )}
            </ul>
            {directory.data.next_cursor && (
              <p className="n-muted">Showing the first 100 chats. Search to find others.</p>
            )}
          </>
        )}
        <Button onClick={() => void refresh()} disabled={refreshing || !telegram.groupIds.length}>
          <RefreshCw size={15} aria-hidden="true" />
          {refreshing ? 'Checking with Telegram…' : 'Refresh group names'}
        </Button>
        <small className="n-muted">Asks Telegram for current group names. It sends nothing.</small>
      </section>
      <div className="access-chat-detail" ref={detail}>
        {current ? (
          <ChatDetail
            chat={current}
            topics={current.kind === 'group' ? topicsOf(current.space_id) : []}
            parent={current.parent_space ? (all.find(item => item.space_id === current.parent_space) ?? null) : null}
            telegram={telegram}
            notify={notify}
          />
        ) : (
          <section className="n-panel access-chat-empty">
            <h2>Choose a chat</h2>
            <p className="n-muted">
              Pick a chat or topic to see who can talk to Nocheh there, what it remembers there, and what it may do
              there.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
