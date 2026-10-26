/** Form fields the Tasks page, its add form and the task panel share. */
import * as React from 'react';
import {X} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {cn} from '../../lib/utils';
import {Field, Select} from '../../ui/core';
import {scopeName, type Person, type Scope} from './model';

/** Small toggle buttons for choosing one list or tag. */
export function Chips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: {value: string; label: React.ReactNode}[];
  onChange: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
            value === option.value
              ? 'border-accent bg-accent-soft font-medium text-accent-text'
              : 'border-line text-muted hover:border-line-strong hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The list a task belongs to: personal, or one project's own list. */
export function ListField({
  id,
  scopes,
  scope,
  onScope,
  disabled,
  hint,
}: {
  id: string;
  scopes: Scope[];
  scope: string;
  onScope: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  if (!scopes.some(row => row.id !== 'personal')) return null;
  return (
    <Field label="List" htmlFor={id + '-list'} className="w-44" {...(hint ? {hint} : {})}>
      <Select id={id + '-list'} value={scope} disabled={disabled} onChange={event => onScope(event.target.value)}>
        {scopes.map(row => (
          <option key={row.id} value={row.id}>
            {scopeName(row)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export const sameTag = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
/** Text typed into the tag box that isn't added yet still counts. */
export const withPending = (tags: string[], pending: string) => {
  const text = pending.trim().replace(/\s+/g, ' ').slice(0, 40);
  return text && !tags.some(tag => sameTag(tag, text)) ? [...tags, text] : tags;
};

/** Tags like a multi-select column: type one and press Enter, or pick one already in use. */
export function TagsField({
  id,
  tags,
  onTags,
  pending,
  onPending,
  known,
  className,
}: {
  id: string;
  tags: string[];
  onTags: (tags: string[]) => void;
  pending: string;
  onPending: (text: string) => void;
  known: string[];
  className?: string;
}) {
  const add = () => {
    onTags(withPending(tags, pending).slice(0, 20));
    onPending('');
  };
  return (
    <>
      <Field label="Tags" htmlFor={id + '-tags'} {...(className ? {className} : {})}>
        <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-0.5 focus-within:border-accent">
          {tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 rounded-md bg-subtle py-0.5 pr-0.5 pl-2 text-xs"
              dir="auto"
            >
              {tag}
              <button
                type="button"
                aria-label={'Remove tag ' + tag}
                className="rounded p-0.5 text-muted hover:bg-line hover:text-fg"
                onClick={() => onTags(tags.filter(item => item !== tag))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <input
            id={id + '-tags'}
            value={pending}
            maxLength={40}
            list={id + '-known-tags'}
            placeholder={tags.length ? '' : 'Optional'}
            className="h-7 min-w-20 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted"
            onChange={event => onPending(event.target.value.replace(',', ''))}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ',') {
                if (!pending.trim()) return;
                event.preventDefault();
                add();
              } else if (event.key === 'Backspace' && !pending && tags.length) onTags(tags.slice(0, -1));
            }}
          />
        </div>
      </Field>
      <datalist id={id + '-known-tags'}>
        {known
          .filter(name => !tags.some(tag => sameTag(tag, name)))
          .map(name => (
            <option key={name} value={name} />
          ))}
      </datalist>
    </>
  );
}

/** People Nocheh knows, from Memory › People. */
export function PeopleField({
  id,
  label,
  hint,
  people,
  onPeople,
}: {
  id: string;
  label: string;
  hint: string;
  people: Person[];
  onPeople: (people: Person[]) => void;
}) {
  const known = useResource<{entities: Person[]}>('/entities?kind=person&q=&after=&state=active', 60000);
  const others = (known.data?.entities ?? []).filter(person => !people.some(chosen => chosen.id === person.id));
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="space-y-2">
        {!!people.length && (
          <ul className="flex flex-wrap gap-1.5" aria-label={'Chosen ' + label.toLowerCase()}>
            {people.map(person => (
              <li
                key={person.id}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-subtle py-0.5 pr-1 pl-2.5 text-xs"
              >
                <span dir="auto">{person.name}</span>
                <button
                  type="button"
                  aria-label={'Remove ' + person.name}
                  className="rounded-full p-0.5 text-muted hover:bg-line hover:text-fg"
                  onClick={() => onPeople(people.filter(item => item.id !== person.id))}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Select
          id={id}
          value=""
          disabled={!others.length}
          onChange={event => {
            const person = others.find(row => row.id === event.target.value);
            if (person) onPeople([...people, {id: person.id, name: person.name}]);
          }}
        >
          <option value="">{known.data && !others.length ? 'No more people to add' : 'Add a person…'}</option>
          {others.map(person => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}
