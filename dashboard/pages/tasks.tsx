/**
 * Tasks: the owner's own to-do list, kept in Nocheh. Tasks can be added here
 * or by telling Nocheh in the private chat; both edit the same list.
 */
import {useState} from 'react';
import {Check, ListChecks, MessageCircle, Pencil, Plus, RotateCcw, X} from 'lucide-react';
import {useView} from '../lib/navigation';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {refreshResources, useResource} from '../lib/resource';
import {cn} from '../lib/utils';
import {Badge, Button, Card, Empty, Field, Input, LoadError, LoadingRows, Notice, Pager, Textarea} from '../ui/core';
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
  origin: 'dashboard' | 'chat';
  revision: number;
  created_at: string;
  done_at: string | null;
};
type TaskPage = {tasks: Task[]; next: string | null; counts: Record<TaskState, number>};

const views = tabIds('tasks');
const PAGE = 100;

/** Today as the owner's own calendar day, YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** A calendar day such as "Fri 4 Jan", with the year only when it isn't this year. */
function day(value: string): string {
  const date = new Date(value + 'T12:00:00');
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : {year: 'numeric'}),
  });
}

export default function Tasks() {
  const [view, setView] = useView(views);
  const [page, setPage] = useState(0);
  const path = `/tasks?state=${view}&limit=${PAGE}` + (page ? `&after=${page * PAGE}` : '');
  const list = useResource<TaskPage>(path);
  const counts = list.data?.counts;
  const [editing, setEditing] = useState<Task | null>(null);
  const changeView = (next: TaskState) => {
    setPage(0);
    setView(next);
  };
  return (
    <Page
      title="Tasks"
      description="Your to-do list. Add tasks here, or just tell Nocheh in your private chat."
      tabs={
        <Tabs
          label="Tasks"
          value={view}
          onChange={changeView}
          tabs={views.map(id => ({id, label: pageTabs.tasks[id], count: counts?.[id] ?? null}))}
        />
      }
    >
      {view === 'open' && <AddTask />}
      {list.error && <LoadError what="tasks" onRetry={() => void refreshResources()} />}
      <Card>
        {!list.data && !list.error ? (
          <div className="p-5">
            <LoadingRows rows={4} />
          </div>
        ) : list.data?.tasks.length ? (
          <ul className="divide-y divide-line">
            {list.data.tasks.map(task => (
              <TaskRow key={task.id} task={task} onEdit={() => setEditing(task)} />
            ))}
          </ul>
        ) : (
          list.data && (
            <Empty
              icon={ListChecks}
              title={view === 'open' ? 'Nothing to do' : `No ${pageTabs.tasks[view].toLowerCase()} tasks`}
            >
              {view === 'open' && 'Add a task above, or ask Nocheh in your private chat to remember something for you.'}
            </Empty>
          )
        )}
        <Pager page={page} hasNext={!!list.data?.next} onPage={setPage} />
      </Card>
      {editing && <EditTask key={editing.id} task={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function AddTask() {
  const command = useCommand();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const add = async () => {
    if (!title.trim()) return;
    const created = await command.run('/tasks', {title, ...(due ? {due_on: due} : {})});
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

function TaskRow({task, onEdit}: {task: Task; onEdit: () => void}) {
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
    <li className="flex items-start gap-3 px-5 py-3">
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

function EditTask({task, onClose}: {task: Task; onClose: () => void}) {
  const command = useCommand();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [due, setDue] = useState(task.due_on ?? '');
  const changed = title !== task.title || notes !== task.notes || due !== (task.due_on ?? '');
  const save = async () => {
    const saved = await command.run('/tasks/' + task.id, {
      expected_revision: task.revision,
      title,
      notes,
      due_on: due || null,
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
        {command.error && <Notice tone="bad">{command.error}</Notice>}
      </div>
    </Dialog>
  );
}
