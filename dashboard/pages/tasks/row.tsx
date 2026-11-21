/** One task in a table, a card or a board column: its checkbox, title and what is set on it. */
import * as React from 'react';
import {
  AlertCircle,
  ArchiveRestore,
  Bell,
  CalendarClock,
  Check as CheckIcon,
  Folder,
  ListTree,
  MessageCircle,
  MessageSquare,
  Paperclip,
  Pencil,
  Repeat as RepeatIcon,
  RotateCcw,
  Smartphone,
  Tag,
  Trash2,
  User,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {cn} from '../../lib/utils';
import {Badge, Button, Dot, Td} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useCommand, when} from '../memory/shared';
import {day, localToday, priorityOf, repeatText, statusOf, type Task, type TaskSettings} from './model';

/** Start and due, with times: "Starts Mon 3 · Due Fri 7, 09:30". */
function dates(task: Task, today: string) {
  const open = task.state === 'open';
  const overdue = open && !!task.due_on && task.due_on < today;
  const due = task.due_on && (
    <Badge tone={overdue ? 'bad' : task.due_on === today ? 'warn' : 'neutral'}>
      <CalendarClock className="size-3" aria-hidden />
      {overdue ? 'Overdue · ' : task.due_on === today ? 'Today · ' : 'Due '}
      {day(task.due_on)}
      {task.due_time ? ', ' + task.due_time : ''}
    </Badge>
  );
  const start = task.start_on && task.start_on > today && (
    <span>
      Starts {day(task.start_on)}
      {task.start_time ? ', ' + task.start_time : ''}
    </span>
  );
  return open ? (
    <>
      {start}
      {due}
    </>
  ) : null;
}

/** What a row does to its task: change it, or delete it for good after a confirmation. */
function useTaskActions(task: Task) {
  const command = useCommand();
  const feedback = useFeedback();
  const change = async (body: Record<string, unknown>, done: string) => {
    if (await command.run('/tasks/' + task.id, {expected_revision: task.revision, ...body})) feedback.toast(done);
  };
  const remove = async () => {
    const ok = await feedback.confirm({
      title: 'Delete this task for good?',
      body: 'It and everything under it are deleted and can’t be brought back.',
      confirm: 'Delete for good',
      danger: true,
    });
    if (ok && (await command.run('/tasks/' + task.id + '/delete', {}))) feedback.toast('Task deleted.');
  };
  return {command, change, remove};
}
type Actions = ReturnType<typeof useTaskActions>;

/** The checkbox that finishes or reopens a task; a task in the trash has none. */
function TaskCheck({task, actions, className}: {task: Task; actions: Actions; className?: string}) {
  const open = task.state === 'open';
  if (task.deleted_at) return null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.state === 'done'}
      aria-label={open ? `Mark “${task.title}” done` : `Reopen “${task.title}”`}
      disabled={actions.command.busy}
      onClick={() =>
        void actions.change(
          {state: open ? 'done' : 'open'},
          open ? (task.repeat ? 'Task done. The next one is on your list.' : 'Task done.') : 'Task reopened.',
        )
      }
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md border border-line-strong transition-colors hover:border-accent disabled:opacity-50',
        task.state === 'done' && 'border-accent bg-accent text-on-accent',
        className,
      )}
    >
      {task.state === 'done' && <CheckIcon className="size-3.5" aria-hidden />}
    </button>
  );
}

/** What can be done with a task from its row: edit or drop it, or bring it back from where it is. */
function RowActions({task, actions, onOpen}: {task: Task; actions: Actions; onOpen: () => void}) {
  const {command, change, remove} = actions;
  return task.deleted_at ? (
    <>
      <Button size="sm" disabled={command.busy} onClick={() => void change({trashed: false}, 'Task restored.')}>
        <RotateCcw aria-hidden /> Restore
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete “${task.title}” for good`}
        disabled={command.busy}
        onClick={() => void remove()}
      >
        <Trash2 aria-hidden />
      </Button>
    </>
  ) : task.archived_at ? (
    <Button size="sm" disabled={command.busy} onClick={() => void change({archived: false}, 'Task back in its list.')}>
      <ArchiveRestore aria-hidden /> Unarchive
    </Button>
  ) : task.state === 'open' ? (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={`Edit “${task.title}”`} onClick={onOpen}>
        <Pencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Drop “${task.title}”`}
        disabled={command.busy}
        onClick={() => void change({state: 'dropped'}, 'Task dropped.')}
      >
        <X aria-hidden />
      </Button>
    </>
  ) : task.state === 'dropped' ? (
    <Button size="sm" disabled={command.busy} onClick={() => void change({state: 'open'}, 'Task reopened.')}>
      <RotateCcw aria-hidden /> Restore
    </Button>
  ) : null;
}

export function TaskRow({
  task,
  settings,
  list,
  group,
  card,
  compact,
  onOpen,
  footer,
  itemProps,
}: {
  task: Task;
  settings: TaskSettings | undefined;
  list: string | null;
  group: string | null;
  card?: boolean;
  /** A board card: fewer details. */
  compact?: boolean;
  onOpen: () => void;
  footer?: React.ReactNode;
  itemProps?: React.HTMLAttributes<HTMLLIElement> & {draggable?: boolean};
}) {
  const actions = useTaskActions(task);
  const {command} = actions;
  const open = task.state === 'open';
  const status = statusOf(settings, task.status);
  const priority = priorityOf(settings, task.priority);
  const firstStatus = settings?.statuses.find(item => item.category === 'not_started')?.id;
  const pending = task.reminders.filter(item => item.state === 'pending');
  const blocked = task.blocked_by.filter(item => item.state === 'open');
  const {className: itemClass, ...item} = itemProps ?? {};
  return (
    <li
      {...item}
      className={cn(
        'flex items-start gap-3',
        card ? 'rounded-xl border border-line bg-surface px-4 py-3 shadow-sm' : 'px-5 py-3',
        compact && 'px-3 py-2',
        itemClass,
      )}
    >
      <TaskCheck task={task} actions={actions} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'text-left text-sm break-words hover:underline',
            !open && 'text-muted line-through',
            compact && 'block max-w-full truncate',
          )}
          title={compact ? task.title : undefined}
          dir="auto"
        >
          {task.title}
        </button>
        {task.notes && !compact && (
          <p className="mt-0.5 line-clamp-2 text-[13px] break-words whitespace-pre-line text-muted" dir="auto">
            {task.notes.replace(/[*_`#>]+/g, '')}
          </p>
        )}
        {/* A board card keeps what is set on it to one line, so a column's cards stay the same height. */}
        <div
          className={cn(
            'mt-1 flex items-center gap-x-3 gap-y-1 text-xs text-muted',
            compact
              ? 'overflow-hidden [mask-image:linear-gradient(to_right,black_85%,transparent)] whitespace-nowrap [&>*]:shrink-0'
              : 'flex-wrap',
          )}
        >
          {open && status && status.id !== firstStatus && !compact && (
            <Badge tone={status.color} dot>
              {status.name}
            </Badge>
          )}
          {!!task.priority && priority && (
            <Badge tone={priority.color}>
              <AlertCircle className="size-3" aria-hidden /> {priority.name}
            </Badge>
          )}
          {dates(task, localToday())}
          {!!blocked.length && open && (
            <Badge tone="warn" title={'Waiting on ' + blocked.map(item => item.title).join(', ')}>
              Waiting on {blocked.length === 1 ? '1 task' : blocked.length + ' tasks'}
            </Badge>
          )}
          {task.repeat && (
            <span className="inline-flex items-center gap-1" title={repeatText(task.repeat)}>
              <RepeatIcon className="size-3" aria-hidden /> {repeatText(task.repeat)}
            </span>
          )}
          {!!pending.length && open && (
            <span
              className="inline-flex items-center gap-1"
              title={'Reminder ' + pending.map(item => when(item.at)).join(', ')}
            >
              <Bell className="size-3" aria-hidden /> {when(pending[0]!.at)}
            </span>
          )}
          {!!task.subtasks.total && (
            <span className="inline-flex items-center gap-1">
              <ListTree className="size-3" aria-hidden /> {task.subtasks.total - task.subtasks.open}/
              {task.subtasks.total}
            </span>
          )}
          {list && (
            <span className="inline-flex items-center gap-1">
              <Folder className="size-3" aria-hidden /> {list}
            </span>
          )}
          {group && !compact && (
            <span className="inline-flex items-center gap-1" dir="auto">
              <Users className="size-3" aria-hidden /> {group}
            </span>
          )}
          {!!task.assignees.length && (
            <span className="inline-flex items-center gap-1" dir="auto">
              <UserCheck className="size-3" aria-hidden /> {task.assignees.map(person => person.name).join(', ')}
            </span>
          )}
          {!!task.people.length && !compact && (
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
          {!!task.comments && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3" aria-hidden /> {task.comments}
            </span>
          )}
          {!!task.attachments.length && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="size-3" aria-hidden /> {task.attachments.length}
            </span>
          )}
          {task.done_at && !open && (
            <span>
              {task.state === 'done' ? 'Done' : 'Dropped'} {when(task.done_at)}
            </span>
          )}
          {task.origin === 'chat' && !compact && (
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="size-3" aria-hidden /> Added in chat
            </span>
          )}
          {task.origin === 'app' && !compact && (
            <span className="inline-flex items-center gap-1">
              <Smartphone className="size-3" aria-hidden /> Members’ app
            </span>
          )}
        </div>
        {footer}
        {command.error && <p className="mt-1 text-xs text-bad">{command.error}</p>}
      </div>
      {!compact && (
        <div className="flex shrink-0 gap-1">
          <RowActions task={task} actions={actions} onOpen={onOpen} />
        </div>
      )}
    </li>
  );
}

/** The table's columns and their widths; the task's own column takes the rest. */
export const taskColumns = [
  {name: 'Task', width: ''},
  {name: 'Status', width: 'w-[7.5rem]'},
  {name: 'Priority', width: 'w-24'},
  {name: 'Due', width: 'w-48'},
  {name: 'List', width: 'w-40'},
] as const;

/**
 * One task as a table row: the same columns on every row, one line each. Notes follow the title on its line; what else
 * is set on the task (people, tags, repeat, reminder, subtasks, comments, files) sits after them as small marks.
 */
export function TaskTableRow({
  task,
  settings,
  list,
  group,
  onOpen,
}: {
  task: Task;
  settings: TaskSettings | undefined;
  list: string | null;
  group: string | null;
  onOpen: () => void;
}) {
  const actions = useTaskActions(task);
  const open = task.state === 'open';
  const status = statusOf(settings, task.status);
  const priority = priorityOf(settings, task.priority);
  const pending = task.reminders.filter(item => item.state === 'pending');
  const blocked = task.blocked_by.filter(item => item.state === 'open');
  const today = localToday();
  const overdue = open && !!task.due_on && task.due_on < today;
  const start = open && task.start_on && task.start_on > today ? task.start_on : null;
  const people = [...task.assignees, ...task.people.filter(p => !task.assignees.some(a => a.name === p.name))];
  const none = <span className="text-muted">—</span>;
  // On a phone the row stacks, and a column with nothing in it is left out.
  const cell = (filled: boolean, className: string) =>
    cn('py-2 align-middle text-[13px]', className, !filled && 'max-sm:hidden');
  const mark = 'inline-flex shrink-0 items-center gap-1';
  return (
    <tr className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2.5 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0">
      <Td className="py-2 pr-0 align-middle">
        <TaskCheck task={task} actions={actions} />
      </Td>
      <Td className="py-2 align-middle max-sm:min-w-0 max-sm:flex-1 max-sm:basis-3/4">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden max-sm:flex-wrap">
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              'min-w-0 truncate text-left text-sm hover:underline max-sm:whitespace-normal',
              !open && 'text-muted line-through',
            )}
            dir="auto"
          >
            {task.title}
          </button>
          {task.notes && (
            <span className="min-w-0 flex-[1_1000_0%] truncate text-[13px] text-muted max-sm:basis-full" dir="auto">
              {task.notes.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ')}
            </span>
          )}
          <span className="ml-auto flex max-w-[55%] shrink-0 items-center gap-2.5 overflow-hidden text-xs whitespace-nowrap text-muted max-sm:ml-0 max-sm:max-w-full max-sm:flex-wrap">
            {!!blocked.length && open && (
              <Badge
                tone="warn"
                className="shrink-0"
                title={'Waiting on ' + blocked.map(item => item.title).join(', ')}
              >
                Waiting on {blocked.length === 1 ? '1 task' : blocked.length + ' tasks'}
              </Badge>
            )}
            {task.repeat && (
              <span className={mark} title={repeatText(task.repeat)}>
                <RepeatIcon className="size-3" aria-hidden />
                <span className="sr-only">{repeatText(task.repeat)}</span>
              </span>
            )}
            {!!pending.length && open && (
              <span className={mark} title={'Reminder ' + pending.map(item => when(item.at)).join(', ')}>
                <Bell className="size-3" aria-hidden />
                <span className="sr-only">Reminder {when(pending[0]!.at)}</span>
              </span>
            )}
            {!!task.subtasks.total && (
              <span className={mark} title="Subtasks done">
                <ListTree className="size-3" aria-hidden /> {task.subtasks.total - task.subtasks.open}/
                {task.subtasks.total}
              </span>
            )}
            {!!task.comments && (
              <span className={mark} title="Comments">
                <MessageSquare className="size-3" aria-hidden /> {task.comments}
              </span>
            )}
            {!!task.attachments.length && (
              <span className={mark} title="Files">
                <Paperclip className="size-3" aria-hidden /> {task.attachments.length}
              </span>
            )}
            {task.origin === 'chat' && (
              <span className={mark} title="Added in chat">
                <MessageCircle className="size-3" aria-hidden />
                <span className="sr-only">Added in chat</span>
              </span>
            )}
            {task.origin === 'app' && (
              <span className={mark}>
                <Smartphone className="size-3" aria-hidden /> Members’ app
              </span>
            )}
            {!!people.length && (
              <span className={mark} dir="auto" title={people.map(person => person.name).join(', ')}>
                {task.assignees.length ? (
                  <UserCheck className="size-3" aria-hidden />
                ) : (
                  <User className="size-3" aria-hidden />
                )}
                {people[0]!.name}
                {people.length > 1 ? ` +${people.length - 1}` : ''}
              </span>
            )}
            {task.tags.map(tag => (
              <span
                key={tag}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5 text-fg"
                dir="auto"
              >
                <Tag className="size-3 text-muted" aria-hidden /> {tag}
              </span>
            ))}
          </span>
        </div>
        {actions.command.error && <p className="mt-1 text-xs text-bad">{actions.command.error}</p>}
      </Td>
      <Td className={cell(true, 'whitespace-nowrap')}>
        {open ? (
          status ? (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <Dot tone={status.color} /> <span className="truncate">{status.name}</span>
            </span>
          ) : (
            none
          )
        ) : (
          <span className="text-muted">
            {task.state === 'done' ? 'Done' : 'Dropped'}
            {task.done_at ? ' ' + when(task.done_at) : ''}
          </span>
        )}
      </Td>
      <Td className={cell(!!task.priority && !!priority, 'whitespace-nowrap')}>
        {!!task.priority && priority ? (
          <span className="inline-flex max-w-full items-center gap-1.5">
            <Dot tone={priority.color} /> <span className="truncate">{priority.name}</span>
          </span>
        ) : (
          none
        )}
      </Td>
      <Td className={cell(open && !!(task.due_on || start), 'whitespace-nowrap')}>
        {open && (task.due_on || start) ? (
          <span className="block truncate" title={start ? 'Starts ' + day(start) : undefined}>
            {task.due_on ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1',
                  overdue ? 'font-medium text-bad' : task.due_on === today ? 'font-medium text-warn' : undefined,
                )}
              >
                <CalendarClock className="size-3" aria-hidden />
                {overdue ? 'Overdue · ' : task.due_on === today ? 'Today · ' : 'Due '}
                {day(task.due_on)}
                {task.due_time ? ', ' + task.due_time : ''}
              </span>
            ) : (
              <span className="text-muted">
                Starts {day(start!)}
                {task.start_time ? ', ' + task.start_time : ''}
              </span>
            )}
          </span>
        ) : (
          none
        )}
      </Td>
      <Td className={cell(!!(list || group), 'text-muted')} dir="auto">
        {list || group ? (
          <span className="flex min-w-0 items-center gap-1" title={[list, group].filter(Boolean).join(' · ')}>
            {list ? (
              <Folder className="size-3 shrink-0" aria-hidden />
            ) : (
              <Users className="size-3 shrink-0" aria-hidden />
            )}
            <span className="truncate">{[list, group].filter(Boolean).join(' · ')}</span>
          </span>
        ) : (
          none
        )}
      </Td>
      <Td className="py-1.5 pl-0 align-middle whitespace-nowrap max-sm:ml-auto">
        <div className="flex justify-end gap-1">
          <RowActions task={task} actions={actions} onOpen={onOpen} />
        </div>
      </Td>
    </tr>
  );
}
