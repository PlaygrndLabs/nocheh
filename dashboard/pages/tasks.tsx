/**
 * Tasks: the owner's to-do lists, kept in Nocheh. Personal tasks are one list
 * and each project has its own; a domain labels a task within its list. Tasks
 * can be added here or by telling Nocheh in chat; both edit the same lists.
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
  X,
} from 'lucide-react';
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
import {useCommand, when} from './memory/shared';

type TaskState = 'open' | 'done' | 'dropped';
export type Task = {
  id: string;
  title: string;
  notes: string;
  state: TaskState;
  due_on: string | null;
  project_id: string | null;
  domain: string;
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
  domains: {name: string; open: number}[];
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

/** Small toggle buttons for choosing one list or domain. */
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
  const domain = useParam('domain');
  const path =
    `/tasks?state=${view}&scope=${encodeURIComponent(scope)}&limit=${PAGE}` +
    (domain !== null ? `&domain=${encodeURIComponent(domain)}` : '') +
    (page ? `&after=${page * PAGE}` : '');
  const list = useResource<TaskPage>(path);
  const counts = list.data?.counts;
  const scopes = list.data?.scopes ?? [];
  const domains = list.data?.domains ?? [];
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
            onChange={value => choose({list: value === 'all' ? null : value, domain: null})}
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
        {!!domains.length && (
          <Chips
            label="Domain"
            value={domain ?? '*'}
            onChange={value => choose({domain: value === '*' ? null : value})}
            options={[
              {value: '*', label: 'All'},
              ...domains.map(row => ({
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
          domains={domains.map(row => row.name)}
          domain={domain ?? ''}
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
          domains={domains.map(row => row.name)}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}

/** The list and domain fields, shared by adding and editing. */
function ListFields({
  id,
  scopes,
  scope,
  onScope,
  domains,
  domain,
  onDomain,
}: {
  id: string;
  scopes: Scope[];
  scope: string;
  onScope: (value: string) => void;
  domains: string[];
  domain: string;
  onDomain: (value: string) => void;
}) {
  return (
    <>
      {scopes.some(row => row.id !== 'personal') && (
        <Field label="List" htmlFor={id + '-list'} className="w-44">
          <Select id={id + '-list'} value={scope} onChange={event => onScope(event.target.value)}>
            {scopes.map(row => (
              <option key={row.id} value={row.id}>
                {scopeName(row)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Domain" htmlFor={id + '-domain'} className="w-40">
        <Input
          id={id + '-domain'}
          value={domain}
          maxLength={40}
          list={id + '-domains'}
          placeholder="Optional"
          onChange={event => onDomain(event.target.value)}
        />
      </Field>
      <datalist id={id + '-domains'}>
        {domains.map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}

function AddTask({
  scopes,
  scope: initialScope,
  domains,
  domain: initialDomain,
}: {
  scopes: Scope[];
  scope: string;
  domains: string[];
  domain: string;
}) {
  const command = useCommand();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [domain, setDomain] = useState(initialDomain);
  const add = async () => {
    if (!title.trim()) return;
    const created = await command.run('/tasks', {
      title,
      scope,
      ...(domain.trim() ? {domain} : {}),
      ...(due ? {due_on: due} : {}),
    });
    if (created) {
      setTitle('');
      setDue('');
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
      <ListFields
        id="task"
        scopes={scopes}
        scope={scope}
        onScope={setScope}
        domains={domains}
        domain={domain}
        onDomain={setDomain}
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

function TaskRow({task, list, card, onEdit}: {task: Task; list: string | null; card: boolean; onEdit: () => void}) {
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
          {task.domain && (
            <span className="inline-flex items-center gap-1">
              <Tag className="size-3" aria-hidden /> {task.domain}
            </span>
          )}
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
  domains,
  onClose,
}: {
  task: Task;
  scopes: Scope[];
  domains: string[];
  onClose: () => void;
}) {
  const command = useCommand();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [due, setDue] = useState(task.due_on ?? '');
  const [scope, setScope] = useState(task.project_id ?? 'personal');
  const [domain, setDomain] = useState(task.domain);
  const changed =
    title !== task.title ||
    notes !== task.notes ||
    due !== (task.due_on ?? '') ||
    scope !== (task.project_id ?? 'personal') ||
    domain.trim() !== task.domain;
  const save = async () => {
    const saved = await command.run('/tasks/' + task.id, {
      expected_revision: task.revision,
      title,
      notes,
      due_on: due || null,
      ...(scope !== (task.project_id ?? 'personal') ? {scope} : {}),
      domain,
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
        <Field label="Due" htmlFor="edit-task-due" hint="Leave empty for no due date.">
          <Input id="edit-task-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-4">
          <ListFields
            id="edit-task"
            scopes={scopes}
            scope={scope}
            onScope={setScope}
            domains={domains}
            domain={domain}
            onDomain={setDomain}
          />
        </div>
        {command.error && <Notice tone="bad">{command.error}</Notice>}
      </div>
    </Dialog>
  );
}
