/** One task in a list, a card or a board column: its checkbox, title and what is set on it. */
import * as React from 'react';
import {
  AlertCircle,
  ArchiveRestore,
  Bell,
  CalendarClock,
  Check,
  Folder,
  ListTree,
  MessageCircle,
  MessageSquare,
  Paperclip,
  Pencil,
  Repeat as RepeatIcon,
  RotateCcw,
  Tag,
  Trash2,
  User,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {cn} from '../../lib/utils';
import {Badge, Button} from '../../ui/core';
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
  const command = useCommand();
  const feedback = useFeedback();
  const open = task.state === 'open';
  const status = statusOf(settings, task.status);
  const priority = priorityOf(settings, task.priority);
  const firstStatus = settings?.statuses.find(item => item.category === 'not_started')?.id;
  const pending = task.reminders.filter(item => item.state === 'pending');
  const blocked = task.blocked_by.filter(item => item.state === 'open');
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
  const {className: itemClass, ...item} = itemProps ?? {};
  return (
    <li
      {...item}
      className={cn(
        'flex items-start gap-3',
        card ? 'rounded-xl border border-line bg-surface px-4 py-3 shadow-sm' : 'px-5 py-3',
        compact && 'px-3 py-2.5',
        itemClass,
      )}
    >
      {!task.deleted_at && (
        <button
          type="button"
          role="checkbox"
          aria-checked={task.state === 'done'}
          aria-label={open ? `Mark “${task.title}” done` : `Reopen “${task.title}”`}
          disabled={command.busy}
          onClick={() =>
            void change(
              {state: open ? 'done' : 'open'},
              open ? (task.repeat ? 'Task done. The next one is on your list.' : 'Task done.') : 'Task reopened.',
            )
          }
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-line-strong transition-colors hover:border-accent disabled:opacity-50',
            task.state === 'done' && 'border-accent bg-accent text-on-accent',
          )}
        >
          {task.state === 'done' && <Check className="size-3.5" aria-hidden />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className={cn('text-left text-sm break-words hover:underline', !open && 'text-muted line-through')}
          dir="auto"
        >
          {task.title}
        </button>
        {task.notes && !compact && (
          <p className="mt-0.5 line-clamp-2 text-[13px] break-words whitespace-pre-line text-muted" dir="auto">
            {task.notes.replace(/[*_`#>]+/g, '')}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
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
        </div>
        {footer}
        {command.error && <p className="mt-1 text-xs text-bad">{command.error}</p>}
      </div>
      {!compact && (
        <div className="flex shrink-0 gap-1">
          {task.deleted_at ? (
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
            <Button
              size="sm"
              disabled={command.busy}
              onClick={() => void change({archived: false}, 'Task back in its list.')}
            >
              <ArchiveRestore aria-hidden /> Unarchive
            </Button>
          ) : open ? (
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
          ) : (
            task.state === 'dropped' && (
              <Button size="sm" disabled={command.busy} onClick={() => void change({state: 'open'}, 'Task reopened.')}>
                <RotateCcw aria-hidden /> Restore
              </Button>
            )
          )}
        </div>
      )}
    </li>
  );
}
