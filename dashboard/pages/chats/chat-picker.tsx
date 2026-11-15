/**
 * Choose one or more chats by name or Telegram ID; optionally groups and their topics only, or whole groups only, as a
 * project takes (a topic always follows its group's project, ADR-0247). What a chat is comes from the chat directory
 * (ADR-0252): a chat is chosen from the list, never typed as an id.
 */
import {useDeferredValue, useId, useState} from 'react';
import {Check, X} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {useChatDirectory} from '../../lib/chat-directory';
import {chatName, isGroupChat, kindLabel, unknownChat, type Chat, type Directory} from '../../lib/chats-model';
import {cn} from '../../lib/utils';
import {Input} from '../../ui/core';

export function ChatPicker({
  label,
  value,
  onChange,
  multiple,
  exclude = [],
  disabled,
  hint,
  groupsOnly,
  wholeGroups,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  exclude?: string[];
  disabled?: boolean;
  hint?: string;
  groupsOnly?: boolean;
  wholeGroups?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const resource = useResource<Directory>(
    '/conversations?limit=100' + (deferred ? '&q=' + encodeURIComponent(deferred) : ''),
  );
  const all = useChatDirectory();
  const find = (space: string | null | undefined): Chat | null =>
    (space && resource.data?.items.find(row => row.space_id === space)) || all.find(space);
  const allowed = (chat: Chat) =>
    (!groupsOnly && !wholeGroups) || (isGroupChat(chat, find) && (!wholeGroups || chat.kind === 'group'));
  const rows = (resource.data?.items ?? []).filter(row => !exclude.includes(row.space_id) && allowed(row));
  const display = (chat: Chat) =>
    chat.kind === 'topic' && chat.parent_name ? `${chatName(chat)} · ${chat.parent_name}` : chatName(chat);
  // A chosen chat the directory is still looking up is shown as loading, never as unknown.
  const chip = (space: string) => {
    const chat = find(space);
    return chat ? display(chat) : all.settled(space) ? display(unknownChat(space)) : 'Loading…';
  };
  const toggle = (space: string) => {
    if (value.includes(space)) onChange(value.filter(item => item !== space));
    else onChange(multiple ? [...value, space] : [space]);
  };
  // A search that found only chats this picker can't take says why.
  const refused = (resource.data?.items ?? []).filter(row => !exclude.includes(row.space_id) && !allowed(row));

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={'Chosen: ' + label}>
          {value.map(space => (
            <li
              key={space}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-subtle py-0.5 pr-1 pl-2.5 text-xs"
            >
              <span className="truncate" dir="auto">
                {chip(space)}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={'Remove ' + chip(space)}
                className="rounded-full p-0.5 text-muted hover:bg-line hover:text-fg"
                onClick={() => toggle(space)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        type="search"
        value={query}
        disabled={disabled}
        placeholder="Search by name or Telegram ID"
        onChange={event => setQuery(event.target.value)}
      />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
        {resource.error && !resource.data ? (
          <p className="px-3 py-2 text-[13px] text-warn">Chats couldn’t be loaded. Try again shortly.</p>
        ) : !resource.data ? (
          <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>
        ) : (
          <ul role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
            {rows.map(row => {
              const chosen = value.includes(row.space_id);
              return (
                <li key={row.space_id} role="option" aria-selected={chosen}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(row.space_id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-subtle',
                      chosen && 'bg-accent-soft',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {display(row)}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{kindLabel(row)}</span>
                    <Check className={cn('size-4 shrink-0 text-accent-text', !chosen && 'invisible')} aria-hidden />
                  </button>
                </li>
              );
            })}
            {!rows.length && (
              <li className="px-3 py-2 text-[13px] text-muted">
                {deferred && refused.length && wholeGroups
                  ? 'Only whole groups can be chosen here. A topic follows its group, and a private chat never joins.'
                  : deferred && refused.length && groupsOnly
                    ? 'Only groups and topics can be chosen here, never a private chat.'
                    : 'No chats match. Search by name or Telegram ID.'}
              </li>
            )}
          </ul>
        )}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
