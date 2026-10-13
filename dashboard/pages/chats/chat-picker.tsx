/** Choose one or more chats by name, or type an exact chat or topic ID. */
import {useDeferredValue, useId, useState} from 'react';
import {Check, X} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {chatFromId, chatName, isSpaceId, kindLabel, type Chat, type Directory} from '../../lib/chats-model';
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
  owner,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  exclude?: string[];
  disabled?: boolean;
  hint?: string;
  owner?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const resource = useResource<Directory>(
    '/conversations?limit=100' + (deferred ? '&q=' + encodeURIComponent(deferred) : ''),
  );
  const all = useResource<Directory>('/conversations?limit=100');
  const rows = (resource.data?.items ?? []).filter(row => !exclude.includes(row.space_id));
  const find = (space: string): Chat =>
    rows.find(row => row.space_id === space) ??
    all.data?.items.find(row => row.space_id === space) ??
    chatFromId(space);
  const display = (chat: Chat) =>
    chat.kind === 'topic' && chat.parent_name ? `${chatName(chat)} · ${chat.parent_name}` : chatName(chat, owner);
  const toggle = (space: string) => {
    if (value.includes(space)) onChange(value.filter(item => item !== space));
    else onChange(multiple ? [...value, space] : [space]);
  };
  const exact = isSpaceId(deferred) && !rows.some(row => row.space_id === deferred) && !value.includes(deferred);

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
                {display(find(space))}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={'Remove ' + display(find(space))}
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
        placeholder="Search chats by name or ID"
        onChange={event => setQuery(event.target.value)}
      />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
        {resource.error && !resource.data ? (
          <p className="px-3 py-2 text-[13px] text-warn">Chats couldn’t be loaded. You can still type an exact ID.</p>
        ) : !resource.data ? (
          <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>
        ) : (
          <ul role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
            {exact && (
              <li>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-subtle"
                  onClick={() => {
                    toggle(deferred);
                    setQuery('');
                  }}
                >
                  Use the ID <span className="font-mono">{deferred}</span>
                </button>
              </li>
            )}
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
            {!rows.length && !exact && (
              <li className="px-3 py-2 text-[13px] text-muted">No chats match. Type an exact ID to use it.</li>
            )}
          </ul>
        )}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
