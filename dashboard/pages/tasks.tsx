/**
 * Tasks: the owner's to-do lists, kept in Nocheh. Personal tasks are one list
 * and each project has its own; within a list a task can carry tags and point
 * to a group and to people. Tasks can be added here or by telling Nocheh in
 * chat; both edit the same lists.
 */
import * as React from 'react';
import {useState} from 'react';
import {
  Check,
  Folder,
  LayoutGrid,
  List,
  ListChecks,
  MessageCircle,
  Pencil,
  Plus,
  RotateCcw,
  Tag,
  User,
  Users,
  X,
} from 'lucide-react';
import {chatName, type Directory} from '../lib/chats-model';
import {useParam, useView} from '../lib/navigation';
import {setParams} from '../lib/routes';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {refreshResources, useResource} from '../lib/resource';
import {cn} from '../lib/utils';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Segmented,
  Select,
  Textarea,
} from '../ui/core';
import {Dialog, useFeedback} from '../ui/overlay';
import {Page, Tabs} from '../ui/page';
import {ChatPicker} from './chats/chat-picker';
import {useCommand, when} from './memory/shared';

type TaskState = 'open' | 'done' | 'dropped';
export type Task = {
  id: string;
  title: string;
  notes: string;
  state: TaskState;
  due_on: string | null;
  project_id: string | null;
  group_id: string | null;
  tags: string[];
  people: {id: string; name: string}[];
  origin: 'dashboard' | 'chat';
  revision: number;
  created_at: string;
  done_at: string | null;
};
/** A list: 'personal', or a project's own list. */
type Scope = {id: string; name: string | null; open: number};
type TaskPage = {
  tasks: Task[];
  next: string | null;
  counts: Record<TaskState, number>;
  scopes: Scope[];
  tags: {name: string; open: number}[];
};
const scopeName = (scope: Scope | undefined) =>
  !scope ? 'Personal' : scope.id === 'personal' ? 'Personal' : scope.name || 'Project';

const views = tabIds('tasks');
const PAGE = 100;

/** Today as the owner's own calendar day, YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** A calendar day such as "Fri 4 Jan", with the year only when it isn't this year. */
export function day(value: string): string {
  const date = new Date(value + 'T12:00:00');
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : {year: 'numeric'}),
  });
}

/** Small toggle buttons for choosing one list or tag. */
function Chips({
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

type Layout = 'list' | 'cards';
const LAYOUT_KEY = 'nocheh.tasks-layout';
/** List or cards, remembered on this device. */
function useLayout(): [Layout, (layout: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'cards' ? 'cards' : 'list';
    } catch {
      return 'list';
    }
  });
  return [
    layout,
    next => {
      setLayout(next);
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {}
    },
  ];
}

export default function Tasks() {
  const [view, setView] = useView(views);
  const [page, setPage] = useState(0);
  const scope = useParam('list') || 'all';
  const tag = useParam('tag');
  const path =
    `/tasks?state=${view}&scope=${encodeURIComponent(scope)}&limit=${PAGE}` +
    (tag ? `&tag=${encodeURIComponent(tag)}` : '') +
    (page ? `&after=${page * PAGE}` : '');
  const list = useResource<TaskPage>(path);
  const chats = useResource<Directory>('/conversations?limit=100', 60000);
  const counts = list.data?.counts;
  const scopes = list.data?.scopes ?? [];
  const tags = list.data?.tags ?? [];
  const groupName = (space: string) => {
    const chat = chats.data?.items.find(row => row.space_id === space);
    if (!chat) return space.includes('/topic/') ? 'A topic' : 'A group';
    return chat.kind === 'topic' && chat.parent_name ? `${chatName(chat)} · ${chat.parent_name}` : chatName(chat);
  };
  const [editing, setEditing] = useState<Task | null>(null);
  const [layout, setLayout] = useLayout();
  const changeView = (next: TaskState) => {
    setPage(0);
    setView(next);
  };
  const choose = (patch: Record<string, string | null>) => {
    setPage(0);
    setParams(patch, true);
  };
  const projects = scopes.filter(row => row.id !== 'personal');
  return (
    <Page
      title="Tasks"
      description="Your personal tasks and each project's own list. Add tasks here, or just tell Nocheh in chat."
      tabs={
        <Tabs
          label="Tasks"
          value={view}
          onChange={changeView}
          tabs={views.map(id => ({id, label: pageTabs.tasks[id], count: counts?.[id] ?? null}))}
        />
      }
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <Chips
            label="List"
            value={scope}
            onChange={value => choose({list: value === 'all' ? null : value, tag: null})}
            options={[
              {value: 'all', label: 'All'},
              ...scopes.map(row => ({
                value: row.id,
                label: (
                  <>
                    {row.id === 'personal' ? null : <Folder className="size-3.5" aria-hidden />}
                    {scopeName(row)}
                    {!!row.open && <span className="text-xs text-muted">{row.open}</span>}
                  </>
                ),
              })),
            ]}
          />
          <Segmented
            label="Show tasks as"
            size="sm"
            value={layout}
            onChange={setLayout}
            options={[
              {
                value: 'list',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <List className="size-3.5" aria-hidden /> List
                  </span>
                ),
              },
              {
                value: 'cards',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <LayoutGrid className="size-3.5" aria-hidden /> Cards
                  </span>
                ),
              },
            ]}
          />
        </div>
        {!!tags.length && (
          <Chips
            label="Tag"
            value={tag ?? '*'}
            onChange={value => choose({tag: value === '*' ? null : value})}
            options={[
              {value: '*', label: 'All'},
              ...tags.map(row => ({
                value: row.name,
                label: (
                  <>
                    <Tag className="size-3.5" aria-hidden />
                    {row.name}
                  </>
                ),
              })),
            ]}
          />
        )}
      </div>
      {view === 'open' && (
        <AddTask
          key={scope}
          scopes={scopes}
          scope={scope === 'all' ? 'personal' : scope}
          tags={tags.map(row => row.name)}
          tag={tag}
        />
      )}
      {list.error && <LoadError what="tasks" onRetry={() => void refreshResources()} />}
      {!list.data && !list.error ? (
        <Card>
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        </Card>
      ) : list.data?.tasks.length ? (
        (() => {
          const rows = list.data.tasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              card={layout === 'cards'}
              list={scope === 'all' ? scopeName(scopes.find(row => row.id === (task.project_id ?? 'personal'))) : null}
              group={task.group_id ? groupName(task.group_id) : null}
              onEdit={() => setEditing(task)}
            />
          ));
          const pager = <Pager page={page} hasNext={!!list.data.next} onPage={setPage} />;
          return layout === 'cards' ? (
            <div>
              <ul aria-label="Tasks" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rows}
              </ul>
              {pager}
            </div>
          ) : (
            <Card>
              <ul aria-label="Tasks" className="divide-y divide-line">
                {rows}
              </ul>
              {pager}
            </Card>
          );
        })()
      ) : (
        list.data && (
          <Card>
            <Empty
              icon={ListChecks}
              title={view === 'open' ? 'Nothing to do' : `No ${pageTabs.tasks[view].toLowerCase()} tasks`}
            >
              {view === 'open' && 'Add a task above, or ask Nocheh in your private chat to remember something for you.'}
            </Empty>
          </Card>
        )
      )}
      {editing && (
        <EditTask
          key={editing.id}
          task={editing}
          scopes={projects.length ? scopes : []}
          tags={tags.map(row => row.name)}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}

/** The list a task belongs to: personal, or one project's own list. */
function ListField({
  id,
  scopes,
  scope,
  onScope,
}: {
  id: string;
  scopes: Scope[];
  scope: string;
  onScope: (value: string) => void;
}) {
  if (!scopes.some(row => row.id !== 'personal')) return null;
  return (
    <Field label="List" htmlFor={id + '-list'} className="w-44">
      <Select id={id + '-list'} value={scope} onChange={event => onScope(event.target.value)}>
        {scopes.map(row => (
          <option key={row.id} value={row.id}>
            {scopeName(row)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const sameTag = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
/** Text typed into the tag box that isn't added yet still counts. */
const withPending = (tags: string[], pending: string) => {
  const text = pending.trim().replace(/\s+/g, ' ').slice(0, 40);
  return text && !tags.some(tag => sameTag(tag, text)) ? [...tags, text] : tags;
};

/** Tags like a multi-select column: type one and press Enter, or pick one already in use. */
function TagsField({
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
    <Field label="Tags" htmlFor={id + '-tags'} className={className}>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-1 focus-within:border-accent">
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
      <datalist id={id + '-known-tags'}>
        {known
          .filter(name => !tags.some(tag => sameTag(tag, name)))
          .map(name => (
            <option key={name} value={name} />
          ))}
      </datalist>
    </Field>
  );
}

type Person = {id: string; name: string};
/** People Nocheh knows, from Memory › People. */
function PeopleField({people, onPeople}: {people: Person[]; onPeople: (people: Person[]) => void}) {
  const known = useResource<{entities: Person[]}>('/entities?kind=person&q=&after=&state=active', 60000);
  const others = (known.data?.entities ?? []).filter(person => !people.some(chosen => chosen.id === person.id));
  return (
    <Field label="People" htmlFor="edit-task-people" hint="People from Memory › People.">
      <div className="space-y-2">
        {!!people.length && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Chosen people">
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
          id="edit-task-people"
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

function AddTask({
  scopes,
  scope: initialScope,
  tags: known,
  tag,
}: {
  scopes: Scope[];
  scope: string;
  tags: string[];
  tag: string | null;
}) {
  const command = useCommand();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [tags, setTags] = useState<string[]>(tag ? [tag] : []);
  const [pending, setPending] = useState('');
  const add = async () => {
    if (!title.trim()) return;
    const chosen = withPending(tags, pending);
    const created = await command.run('/tasks', {
      title,
      scope,
      ...(chosen.length ? {tags: chosen} : {}),
      ...(due ? {due_on: due} : {}),
    });
    if (created) {
      setTitle('');
      setDue('');
      setPending('');
      setTags(tag ? [tag] : []);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        void add();
      }}
    >
      <Field label="New task" htmlFor="task-title" className="min-w-0 flex-1 basis-64">
        <Input
          id="task-title"
          value={title}
          maxLength={300}
          placeholder="What needs doing?"
          onChange={event => setTitle(event.target.value)}
        />
      </Field>
      <ListField id="task" scopes={scopes} scope={scope} onScope={setScope} />
      <TagsField
        id="task"
        tags={tags}
        onTags={setTags}
        pending={pending}
        onPending={setPending}
        known={known}
        className="w-64"
      />
      <Field label="Due" htmlFor="task-due" className="w-40">
        <Input id="task-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={command.busy} disabled={!title.trim()}>
        <Plus aria-hidden /> Add
      </Button>
      {command.error && (
        <Notice tone="bad" className="w-full">
          {command.error}
        </Notice>
      )}
    </form>
  );
}

function TaskRow({
  task,
  list,
  group,
  card,
  onEdit,
}: {
  task: Task;
  list: string | null;
  group: string | null;
  card: boolean;
  onEdit: () => void;
}) {
  const command = useCommand();
  const feedback = useFeedback();
  const open = task.state === 'open';
  const overdue = open && !!task.due_on && task.due_on < today();
  const setState = async (state: TaskState) => {
    const changed = await command.run('/tasks/' + task.id, {expected_revision: task.revision, state});
    if (changed)
      feedback.toast(state === 'done' ? 'Task done.' : state === 'dropped' ? 'Task dropped.' : 'Task reopened.');
  };
  return (
    <li
      className={cn(
        'flex items-start gap-3',
        card ? 'rounded-xl border border-line bg-surface px-4 py-3 shadow-sm' : 'px-5 py-3',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.state === 'done'}
        aria-label={open ? `Mark “${task.title}” done` : `Reopen “${task.title}”`}
        disabled={command.busy}
        onClick={() => void setState(open ? 'done' : 'open')}
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-line-strong transition-colors hover:border-accent disabled:opacity-50',
          task.state === 'done' && 'border-accent bg-accent text-on-accent',
        )}
      >
        {task.state === 'done' && <Check className="size-3.5" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm break-words', !open && 'text-muted line-through')}>{task.title}</p>
        {task.notes && <p className="mt-0.5 text-[13px] break-words whitespace-pre-line text-muted">{task.notes}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {task.due_on && open && (
            <Badge tone={overdue ? 'bad' : task.due_on === today() ? 'warn' : 'neutral'}>
              {overdue ? 'Overdue · ' : task.due_on === today() ? 'Today · ' : 'Due '}
              {day(task.due_on)}
            </Badge>
          )}
          {list && (
            <span className="inline-flex items-center gap-1">
              <Folder className="size-3" aria-hidden /> {list}
            </span>
          )}
          {group && (
            <span className="inline-flex items-center gap-1" dir="auto">
              <Users className="size-3" aria-hidden /> {group}
            </span>
          )}
          {!!task.people.length && (
            <span className="inline-flex items-center gap-1" dir="auto">
              <User className="size-3" aria-hidden /> {task.people.map(person => person.name).join(', ')}
            </span>
          )}
          {task.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5 text-fg"
              dir="auto"
            >
              <Tag className="size-3 text-muted" aria-hidden /> {tag}
            </span>
          ))}
          {task.done_at && (
            <span>
              {task.state === 'done' ? 'Done' : 'Dropped'} {when(task.done_at)}
            </span>
          )}
          {task.origin === 'chat' && (
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" aria-hidden /> Added in chat
            </span>
          )}
        </div>
        {command.error && <p className="mt-1 text-xs text-bad">{command.error}</p>}
      </div>
      <div className="flex shrink-0 gap-1">
        {open && (
          <Button variant="ghost" size="icon-sm" aria-label={`Edit “${task.title}”`} onClick={onEdit}>
            <Pencil aria-hidden />
          </Button>
        )}
        {open ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Drop “${task.title}”`}
            disabled={command.busy}
            onClick={() => void setState('dropped')}
          >
            <X aria-hidden />
          </Button>
        ) : (
          task.state === 'dropped' && (
            <Button size="sm" disabled={command.busy} onClick={() => void setState('open')}>
              <RotateCcw aria-hidden /> Restore
            </Button>
          )
        )}
      </div>
    </li>
  );
}

function EditTask({
  task,
  scopes,
  tags: known,
  onClose,
}: {
  task: Task;
  scopes: Scope[];
  tags: string[];
  onClose: () => void;
}) {
  const command = useCommand();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [due, setDue] = useState(task.due_on ?? '');
  const [scope, setScope] = useState(task.project_id ?? 'personal');
  const [tags, setTags] = useState(task.tags);
  const [pending, setPending] = useState('');
  const [group, setGroup] = useState(task.group_id);
  const [people, setPeople] = useState(task.people);
  const chosenTags = withPending(tags, pending);
  const samePeople =
    people
      .map(person => person.id)
      .sort()
      .join() ===
    task.people
      .map(person => person.id)
      .sort()
      .join();
  const changed =
    title !== task.title ||
    notes !== task.notes ||
    due !== (task.due_on ?? '') ||
    scope !== (task.project_id ?? 'personal') ||
    chosenTags.join('\n') !== task.tags.join('\n') ||
    group !== task.group_id ||
    !samePeople;
  const save = async () => {
    const saved = await command.run('/tasks/' + task.id, {
      expected_revision: task.revision,
      title,
      notes,
      due_on: due || null,
      ...(scope !== (task.project_id ?? 'personal') ? {scope} : {}),
      tags: chosenTags,
      ...(group !== task.group_id ? {group} : {}),
      ...(samePeople ? {} : {people: people.map(person => person.id)}),
    });
    if (saved) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title="Edit task"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={command.busy}
            disabled={!changed || !title.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Task" htmlFor="edit-task-title">
          <Input id="edit-task-title" value={title} maxLength={300} onChange={event => setTitle(event.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="edit-task-notes">
          <Textarea
            id="edit-task-notes"
            value={notes}
            maxLength={4000}
            onChange={event => setNotes(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Due" htmlFor="edit-task-due" hint="Leave empty for no due date." className="w-44">
            <Input id="edit-task-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
          </Field>
          <ListField id="edit-task" scopes={scopes} scope={scope} onScope={setScope} />
        </div>
        <TagsField id="edit-task" tags={tags} onTags={setTags} pending={pending} onPending={setPending} known={known} />
        <ChatPicker
          label="Group"
          value={group ? [group] : []}
          onChange={ids => setGroup(ids.at(-1) ?? null)}
          groupsOnly
          hint="The group, or a topic in it, this task belongs to."
        />
        <PeopleField people={people} onPeople={setPeople} />
        {command.error && <Notice tone="bad">{command.error}</Notice>}
      </div>
    </Dialog>
  );
}
