/**
 * The Tasks tab: one project's board at a time (chips when the member has more than one, the last one remembered on
 * this phone), filters, the rows, and New task with write access. Statuses and shared columns go by the names the page
 * gives them; assignees show by their Telegram name, or counted (ADR-0265 Q4).
 */
import * as React from 'react';
import {Bell, CalendarClock, ListTree, MessageSquare, Plus, Tag, UserRound, UsersRound} from 'lucide-react';
import type {MemberMe, MemberTask, MemberTaskPage, MemberTaskQuery} from '../../src/member-app-wire';
import {cn} from '../lib/utils';
import {Badge, Button, Field, Input, Select, Skeleton, Textarea} from '../ui/core';
import {memberApi, operationId} from './api';
import {readUi, writeUi} from './launch';
import {MemberTaskDrawer} from './drawer';
import {ColumnFields, columnPatch, draftsOf, StatusField} from './columns';
import {
  assigneeText,
  AudienceLine,
  boardGroups,
  dueText,
  emptyBoard,
  groupTitle,
  problem,
  Sheet,
  statusName,
  tagList,
  useToast,
  useWords,
  type Board,
} from './shared';

/** Where the Groups tab sends the member: a project, filtered to one group. `at` makes each tap count. */
export type TasksFocus = {project?: string; group?: string; at?: number};
type View = 'open' | 'done' | 'trash';

const pickProject = (me: MemberMe, wanted: string | undefined) =>
  me.projects.some(project => project.id === wanted) ? wanted! : (me.projects[0]?.id ?? null);

export function MemberTasks({me, focus, onMe}: {me: MemberMe; focus: TasksFocus; onMe: () => void}) {
  const words = useWords();
  const {t} = words;
  const [project, setProject] = React.useState<string | null>(() => pickProject(me, focus.project ?? readUi().project));
  const [view, setView] = React.useState<View>('open');
  const [mine, setMine] = React.useState(false);
  const [group, setGroup] = React.useState(focus.group ?? '');
  const [tag, setTag] = React.useState('');
  const [page, setPage] = React.useState<MemberTaskPage | null>(null);
  // The names of statuses and shared columns, from the last page read; the drawer and the forms use them too.
  const [board, setBoard] = React.useState<Board>(emptyBoard);
  const [failed, setFailed] = React.useState(false);
  const [more, setMore] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [version, setVersion] = React.useState(0);
  const write = me.mode === 'write';

  React.useEffect(() => {
    if (!focus.at) return;
    setProject(pickProject(me, focus.project));
    setGroup(focus.group ?? '');
    setView('open');
    setTag('');
    setMine(false);
  }, [focus.at]);
  // A project that is no longer one of the member's boards falls back to the first.
  React.useEffect(() => {
    if (project !== pickProject(me, project ?? undefined)) setProject(pickProject(me, project ?? undefined));
  }, [me, project]);

  // A board holds the project's whole list, so any of its groups can filter it (ADR-0276).
  const groups = boardGroups(me, project);
  const groupIds = groups.map(item => item.id).join();
  const query = React.useMemo<MemberTaskQuery | null>(() => {
    if (!project) return null;
    const value: MemberTaskQuery = {project};
    if (group && groupIds.split(',').includes(group)) value.group = group;
    if (mine) value.mine = true;
    if (view === 'trash') value.trash = true;
    else if (view === 'done') value.state = 'done';
    if (tag) value.tag = tag;
    return value;
  }, [project, group, mine, view, tag, groupIds]);

  React.useEffect(() => {
    if (!query) return;
    let live = true;
    setFailed(false);
    memberApi.tasks(query).then(
      value => {
        if (!live) return;
        setPage(value);
        setBoard({statuses: value.statuses ?? [], columns: value.columns ?? []});
      },
      error => {
        if (!live) return;
        setPage(null);
        if (problem(error)) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [query, version]);

  const showMore = async () => {
    if (!query || !page?.next) return;
    setMore(true);
    try {
      const next = await memberApi.tasks({...query, cursor: page.next});
      setPage({...page, tasks: [...page.tasks, ...next.tasks], next: next.next});
    } catch {
      setFailed(true);
    } finally {
      setMore(false);
    }
  };
  const choose = (id: string) => {
    setProject(id);
    setGroup('');
    setTag('');
    setPage(null);
    writeUi({project: id});
  };
  const refresh = () => setVersion(value => value + 1);

  if (!project)
    return (
      <section className="mx-auto max-w-2xl space-y-3 p-4">
        <h1 className="text-xl font-semibold">{t('tab_tasks')}</h1>
        <p className="text-sm text-muted">{t('no_boards')}</p>
      </section>
    );
  const projectName = me.projects.find(item => item.id === project)?.name ?? '';
  return (
    <section className="mx-auto max-w-2xl space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('tab_tasks')}</h1>
        {write && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> {t('new_task')}
          </Button>
        )}
      </div>
      {me.projects.length > 1 && (
        <div role="radiogroup" aria-label={t('projects')} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {me.projects.map(item => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === project}
              onClick={() => item.id !== project && choose(item.id)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-[13px] font-medium',
                item.id === project ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted',
              )}
              dir="auto"
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      {!write && <p className="rounded-lg bg-subtle px-3 py-2 text-[13px] text-muted">{t('read_only_line')}</p>}
      <div className="flex flex-wrap items-center gap-2" aria-label={t('filters')} role="group">
        <div
          role="radiogroup"
          aria-label={t('filters')}
          className="inline-flex rounded-lg border border-line bg-subtle p-0.5"
        >
          {(['open', 'done', 'trash'] as const).map(item => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={view === item}
              onClick={() => setView(item)}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium',
                view === item ? 'bg-surface text-fg shadow-card' : 'text-muted',
              )}
            >
              {t(item === 'open' ? 'filter_open' : item === 'done' ? 'filter_done' : 'filter_trash')}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={mine}
          onClick={() => setMine(value => !value)}
          className={cn(
            'h-8 rounded-lg border px-2.5 text-xs font-medium',
            mine ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted',
          )}
        >
          {t('filter_mine')}
        </button>
        {/* Shown whenever a group filter is on, a single group's too (one tapped on the Groups tab), so it can be cleared. */}
        {(groups.length > 1 || groups.some(item => item.id === group)) && (
          <Select
            aria-label={t('filter_group')}
            className="h-8 w-auto text-xs"
            value={group}
            onChange={event => setGroup(event.target.value)}
          >
            <option value="">{t('all_groups')}</option>
            {groups.map(item => (
              <option key={item.id} value={item.id}>
                {item.title?.trim() || t('unnamed_group')}
              </option>
            ))}
          </Select>
        )}
        {!!(page?.tags.length || tag) && (
          <Select
            aria-label={t('filter_tag')}
            className="h-8 w-auto text-xs"
            value={tag}
            onChange={event => setTag(event.target.value)}
          >
            <option value="">{t('all_tags')}</option>
            {[...new Set([...(page?.tags ?? []), ...(tag ? [tag] : [])])].map(item => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        )}
      </div>
      {failed && <p className="text-sm text-bad">{t('failed')}</p>}
      {!page && !failed && <Skeleton className="h-24 w-full rounded-xl" />}
      {page && !page.tasks.length && <p className="py-6 text-center text-sm text-muted">{t('no_tasks')}</p>}
      {!!page?.tasks.length && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label={projectName}>
          {page.tasks.map(task => (
            <TaskRow key={task.id} task={task} me={me} board={board} onOpen={() => setOpen(task.id)} />
          ))}
        </ul>
      )}
      {page?.next && (
        <Button className="w-full" busy={more} onClick={() => void showMore()}>
          {t('show_more')}
        </Button>
      )}
      {open && (
        <MemberTaskDrawer
          key={open}
          id={open}
          me={me}
          board={board}
          onClose={() => setOpen(null)}
          onOpen={setOpen}
          onChanged={refresh}
          onMe={onMe}
        />
      )}
      {creating && (
        <NewTask
          me={me}
          board={board}
          project={project}
          projectName={projectName}
          group={group}
          tasks={page?.tasks ?? []}
          onClose={() => setCreating(false)}
          onCreated={task => {
            setCreating(false);
            refresh();
            setOpen(task);
          }}
          onMe={onMe}
        />
      )}
    </section>
  );
}

function TaskRow({task, me, board, onOpen}: {task: MemberTask; me: MemberMe; board: Board; onOpen: () => void}) {
  const words = useWords();
  const {t} = words;
  const due = dueText(task, words);
  const assignees = assigneeText(task, t);
  return (
    <li>
      <button type="button" onClick={onOpen} className="block w-full px-4 py-3 text-start hover:bg-subtle">
        <span
          className={cn('block text-sm font-medium', task.state !== 'open' && 'text-muted line-through')}
          dir="auto"
        >
          {task.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>{statusName(task, board, t)}</span>
          {due && (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="size-3" aria-hidden /> {t('due_on', {date: due})}
            </span>
          )}
          <span className="inline-flex items-center gap-1" dir="auto">
            <UsersRound className="size-3" aria-hidden /> {groupTitle(me, task.group, t)}
          </span>
          {assignees && (
            <span className="inline-flex items-center gap-1" dir="auto" title={t('assignees')}>
              <UserRound className="size-3" aria-label={t('assignees')} /> {assignees}
            </span>
          )}
          {task.subtasks.total > 0 && (
            <span className="inline-flex items-center gap-1">
              <ListTree className="size-3" aria-hidden />
              {t('subtasks_count', {open: task.subtasks.open, total: task.subtasks.total})}
            </span>
          )}
          {task.comments > 0 && (
            <span className="inline-flex items-center gap-1" aria-label={t('comments_count', {count: task.comments})}>
              <MessageSquare className="size-3" aria-hidden /> {task.comments}
            </span>
          )}
          {task.reminders.mine.length > 0 && <Bell className="size-3" aria-label={t('reminders')} />}
          {task.tags.map(item => (
            <span key={item} className="inline-flex items-center gap-1" dir="auto">
              <Tag className="size-3" aria-hidden /> {item}
            </span>
          ))}
          {task.trashed && <Badge tone="bad">{t('in_trash')}</Badge>}
          {task.state === 'done' && <Badge tone="good">{t('state_done')}</Badge>}
          {task.state === 'dropped' && <Badge>{t('state_dropped')}</Badge>}
        </span>
      </button>
    </li>
  );
}

function NewTask({
  me,
  board,
  project,
  projectName,
  group: filtered,
  tasks,
  onClose,
  onCreated,
  onMe,
}: {
  me: MemberMe;
  board: Board;
  project: string;
  projectName: string;
  group: string;
  tasks: MemberTask[];
  onClose: () => void;
  onCreated: (id: string) => void;
  onMe: () => void;
}) {
  const {t} = useWords();
  const toast = useToast();
  // The member's own groups on this board; any group of the project can label the task.
  const own = me.groups.filter(item => item.board === 'open' && item.project === project);
  const groups = boardGroups(me, project);
  const [title, setTitle] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [due, setDue] = React.useState('');
  const [tags, setTags] = React.useState('');
  // The member's own group by default: the filtered one, or their first in the project; Whole project is a choice.
  const [group, setGroup] = React.useState(own.some(item => item.id === filtered) ? filtered : (own[0]?.id ?? ''));
  const [parent, setParent] = React.useState('');
  // A new task starts in the board's first open status, as the server would put it.
  const firstStatus = board.statuses.find(item => item.state === 'open')?.id ?? '';
  const [status, setStatus] = React.useState(firstStatus);
  const [columns, setColumns] = React.useState(() => draftsOf(board));
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // One id per task being added, so a retry after a lost answer adds it once.
  const operation = React.useRef(operationId());
  const parents = tasks.filter(task => task.state === 'open' && !task.trashed);
  // A subtask takes its parent's group, so with a parent there is no group to choose.
  const under = parents.find(task => task.id === parent) ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return setError(t('title_required'));
    const values = columnPatch(board, columns);
    if ('invalid' in values) return setError(t('number_invalid', {column: values.invalid}));
    setBusy(true);
    setError(null);
    try {
      const created = await memberApi.create({
        operation_id: operation.current,
        project,
        title: title.trim(),
        ...(under ? {parent: under.id} : {group: group || null}),
        ...(notes.trim() ? {notes: notes.trim()} : {}),
        ...(due ? {due_on: due} : {}),
        ...(tagList(tags).length ? {tags: tagList(tags)} : {}),
        ...(status && status !== firstStatus ? {status} : {}),
        ...(Object.keys(values.properties).length ? {properties: values.properties} : {}),
      });
      toast(t('task_added'));
      onCreated(created.id);
    } catch (failure) {
      const found = problem(failure);
      if (found) {
        setError(t(found.word));
        if (found.reload) onMe();
      }
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={t('new_task')}
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" form="member-new-task" busy={busy}>
            {t('add_task')}
          </Button>
        </>
      }
    >
      <form id="member-new-task" onSubmit={submit} className="space-y-3">
        <Field label={t('field_title')} htmlFor="member-task-title" error={error}>
          <Input
            id="member-task-title"
            dir="auto"
            value={title}
            maxLength={500}
            onChange={event => setTitle(event.target.value)}
          />
        </Field>
        <Field label={t('field_notes')} htmlFor="member-task-notes">
          <Textarea id="member-task-notes" dir="auto" value={notes} onChange={event => setNotes(event.target.value)} />
        </Field>
        <StatusField board={board} id="member-task-status" value={status} onChange={setStatus} />
        <Field label={t('field_due')} htmlFor="member-task-due">
          <Input id="member-task-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
        </Field>
        <Field label={t('field_tags')} htmlFor="member-task-tags" hint={t('tags_hint')}>
          <Input id="member-task-tags" dir="auto" value={tags} onChange={event => setTags(event.target.value)} />
        </Field>
        {!under && (
          <Field label={t('field_group')} htmlFor="member-task-group">
            <Select id="member-task-group" value={group} onChange={event => setGroup(event.target.value)}>
              {groups.map(item => (
                <option key={item.id} value={item.id}>
                  {item.title?.trim() || t('unnamed_group')}
                </option>
              ))}
              <option value="">{t('whole_project')}</option>
            </Select>
          </Field>
        )}
        <AudienceLine projectName={projectName} />
        <ColumnFields board={board} prefix="member-task" drafts={columns} onChange={setColumns} />
        {!!parents.length && (
          <Field label={t('field_parent')} htmlFor="member-task-parent">
            <Select id="member-task-parent" value={parent} onChange={event => setParent(event.target.value)}>
              <option value="">{t('no_parent')}</option>
              {parents.map(task => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Sheet>
  );
}
