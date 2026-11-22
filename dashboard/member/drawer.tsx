/**
 * One task in the members' app: what the board shows of it from when it joined, its status and shared columns by the
 * board's names, who does it (Telegram names, the rest counted), the member's own reminders and how many others there
 * are (no names), and with write access Edit, Finish or Reopen, Comment, Remind me, and Move to trash
 * or Restore. A version conflict says so and shows the new version.
 */
import * as React from 'react';
import {Bell, Check, ExternalLink, Pencil, RotateCcw, Trash2, Undo2} from 'lucide-react';
import type {MemberDetail, MemberMe, MemberTaskLink, MemberTaskPatch} from '../../src/member-app-wire';
import {Badge, Button, Field, Input, Notice, Select, Skeleton, Textarea} from '../ui/core';
import {memberApi, operationId} from './api';
import type {Translate, WordKey} from './i18n';
import {boardColumns, ColumnFields, columnPatch, ColumnValue, draftsOf, StatusField} from './columns';
import {
  actorName,
  assigneeText,
  AudienceLine,
  boardGroups,
  dueText,
  groupTitle,
  localInput,
  localMoment,
  Plain,
  problem,
  safeHref,
  Sheet,
  statusName,
  tagList,
  useToast,
  useWords,
  whyKey,
  type Board,
} from './shared';

const fieldWords: Record<string, WordKey> = {
  notes: 'f_notes',
  due_on: 'f_due',
  due_time: 'f_due',
  start_on: 'f_start',
  start_time: 'f_start',
  priority: 'f_priority',
  assignees: 'f_assignees',
  properties: 'f_columns',
  tags: 'f_tags',
  group_id: 'f_group',
  parent_id: 'f_parent',
  blocked_by: 'f_links',
  related: 'f_links',
  duplicate_of: 'f_links',
  attachments: 'f_links',
  reminders: 'f_reminders',
};
/** One history entry in the page's words; never a value the owner keeps private (the server already left those out). */
export function historyLines(changes: Record<string, unknown>, t: Translate): string[] {
  const lines: string[] = [],
    fields: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const to = (value as {to?: unknown} | null)?.to;
    if (key === 'created') lines.push(t('h_added'));
    else if (key === 'title') lines.push(t('h_renamed'));
    else if (key === 'status_id' || key === 'status') lines.push(t('h_status'));
    else if (key === 'state') continue;
    else if (key === 'trashed') lines.push(t(to ? 'h_trashed' : 'h_restored'));
    else if (key === 'archived') lines.push(t(to ? 'h_archived' : 'h_unarchived'));
    else if (key === 'reminded') lines.push(t('h_reminded'));
    else fields.push(t(fieldWords[key] ?? 'f_details'));
  }
  if (fields.length) lines.push(t('h_changed', {fields: [...new Set(fields)].join(', ')}));
  return lines;
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="space-y-2 border-t border-line pt-3">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Linked({items, onOpen}: {items: MemberTaskLink[]; onOpen: (id: string) => void}) {
  const {t} = useWords();
  return (
    <ul className="space-y-1">
      {items.map(item => (
        <li key={item.id}>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-start text-sm text-accent-text hover:underline"
            onClick={() => onOpen(item.id)}
          >
            {item.state !== 'open' && <Check className="size-3.5" aria-label={t('state_done')} />}
            <span dir="auto" className={item.state !== 'open' ? 'line-through' : undefined}>
              {item.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MemberTaskDrawer({
  id,
  me,
  board,
  onClose,
  onOpen,
  onChanged,
  onMe,
}: {
  id: string;
  me: MemberMe;
  board: Board;
  onClose: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onMe: () => void;
}) {
  const words = useWords();
  const {t, moment} = words;
  const toast = useToast();
  const [task, setTask] = React.useState<MemberDetail | null>(null);
  const [missing, setMissing] = React.useState<WordKey | null>(null);
  const [notice, setNotice] = React.useState<WordKey | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const write = me.mode === 'write';
  const remind = write && me.reminders.available;

  const load = React.useCallback(async () => {
    try {
      setTask(await memberApi.task(id));
      setMissing(null);
    } catch (error) {
      const found = problem(error);
      if (found) setMissing(found.word);
    }
  }, [id]);
  React.useEffect(() => void load(), [load]);

  /** Shows what a failed write says; a conflict reloads the task and says so. */
  const failed = async (error: unknown) => {
    const found = problem(error);
    if (!found) return;
    if (found.word === 'conflict') {
      setEditing(false);
      setNotice('conflict');
      await load();
      return;
    }
    toast(t(found.word), true);
    if (found.reload) onMe();
    if (found.word === 'not_found') setMissing('not_found');
  };
  const change = async (key: string, patch: MemberTaskPatch, success: WordKey): Promise<boolean> => {
    if (!task) return false;
    setBusy(key);
    setNotice(null);
    try {
      setTask(await memberApi.update(task.id, {operation_id: operationId(), expected_version: task.version, patch}));
      toast(t(success));
      onChanged();
      return true;
    } catch (error) {
      await failed(error);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const title = task?.title ?? (missing ? t(missing) : t('loading'));
  const footer =
    task && write && !editing ? (
      <>
        {task.trashed ? (
          <Button
            busy={busy === 'trash'}
            disabled={!!busy}
            onClick={() => void change('trash', {trashed: false}, 'restored')}
          >
            <Undo2 aria-hidden /> {t('restore')}
          </Button>
        ) : (
          <>
            <Button
              variant="danger"
              busy={busy === 'trash'}
              disabled={!!busy}
              onClick={() => void change('trash', {trashed: true}, 'moved_to_trash')}
            >
              <Trash2 aria-hidden /> {t('trash')}
            </Button>
            <Button disabled={!!busy} onClick={() => setEditing(true)}>
              <Pencil aria-hidden /> {t('edit')}
            </Button>
            {task.state === 'open' ? (
              <Button
                variant="primary"
                busy={busy === 'state'}
                disabled={!!busy}
                onClick={() => void change('state', {state: 'done'}, 'finished')}
              >
                <Check aria-hidden /> {t('finish')}
              </Button>
            ) : (
              <Button
                busy={busy === 'state'}
                disabled={!!busy}
                onClick={() => void change('state', {state: 'open'}, 'reopened')}
              >
                <RotateCcw aria-hidden /> {t('reopen')}
              </Button>
            )}
          </>
        )}
      </>
    ) : undefined;

  return (
    <Sheet open onClose={onClose} title={title} footer={footer}>
      {!task && !missing && <Skeleton className="h-40 w-full" />}
      {!task && missing && <p className="text-sm text-muted">{t(missing)}</p>}
      {task && (
        <div className="space-y-4" data-task={task.id}>
          {notice && <Notice tone="warn">{t(notice)}</Notice>}
          {!write && <p className="rounded-lg bg-subtle px-3 py-2 text-[13px] text-muted">{t('read_only_line')}</p>}
          {editing ? (
            <EditTask
              task={task}
              me={me}
              board={board}
              busy={busy === 'edit'}
              onCancel={() => setEditing(false)}
              onSave={async patch => {
                if (!Object.keys(patch).length) return setEditing(false);
                if (await change('edit', patch, 'saved')) setEditing(false);
              }}
            />
          ) : (
            <Overview task={task} me={me} board={board} />
          )}
          {(task.children.length > 0 || task.subtasks.total > 0) && (
            <Section title={t('subtasks')}>
              <Linked items={task.children} onOpen={onOpen} />
            </Section>
          )}
          {(['blocked_by', 'related', 'duplicate_of'] as const).map(key =>
            task[key].length ? (
              <Section key={key} title={t(key)}>
                <Linked items={task[key]} onOpen={onOpen} />
              </Section>
            ) : null,
          )}
          {task.attachments.length > 0 && (
            <Section title={t('links')}>
              <ul className="space-y-1">
                {task.attachments.map((item, index) => {
                  const href = safeHref(item.url);
                  return (
                    <li key={index} className="text-sm" dir="auto">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-accent-text underline"
                        >
                          <ExternalLink className="size-3.5" aria-hidden /> {item.title || item.url}
                        </a>
                      ) : (
                        <span>{item.title || item.url}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
          <Reminders task={task} me={me} enabled={remind} busy={busy} onChange={change} />
          <Comments task={task} write={write} onSaved={setTask} onFailed={failed} onChanged={onChanged} />
          {task.activity.length > 0 && (
            <Section title={t('history')}>
              <ul className="space-y-2" aria-label={t('history')}>
                {task.activity.map((entry, index) => (
                  <li key={index} className="text-xs">
                    <span className="text-muted" dir="auto">
                      {moment(entry.at)} · {actorName(entry.actor, t)}
                    </span>
                    <span className="block">{historyLines(entry.changes, t).join('; ')}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Overview({task, me, board}: {task: MemberDetail; me: MemberMe; board: Board}) {
  const words = useWords();
  const {t, moment} = words;
  const due = dueText(task, words);
  const assignees = assigneeText(task, t);
  // Only the columns the board names, in its order; a value it holds nothing of is left out.
  const columns = boardColumns(board).filter(column => {
    const value = task.properties[column.id];
    return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length);
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={task.state === 'done' ? 'good' : task.state === 'dropped' ? 'neutral' : 'info'}>
          {statusName(task, board, t)}
        </Badge>
        {task.trashed && <Badge tone="bad">{t('in_trash')}</Badge>}
        {task.archived && <Badge>{t('archived')}</Badge>}
        {task.priority > 0 && task.priority <= 4 && (
          <Badge tone="warn">{t(('priority_' + task.priority) as WordKey)}</Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
        {due && (
          <>
            <dt className="text-muted">{t('field_due')}</dt>
            <dd>{due}</dd>
          </>
        )}
        <dt className="text-muted">{t('field_group')}</dt>
        <dd dir="auto">{groupTitle(me, task.group, t)}</dd>
        {assignees && (
          <>
            <dt className="text-muted">{t('assignees')}</dt>
            <dd dir="auto">{assignees}</dd>
          </>
        )}
        {task.tags.length > 0 && (
          <>
            <dt className="text-muted">{t('field_tags')}</dt>
            <dd dir="auto">{task.tags.join(', ')}</dd>
          </>
        )}
        {columns.map(column => (
          <React.Fragment key={column.id}>
            <dt className="text-muted" dir="auto">
              {column.name}
            </dt>
            <dd>
              <ColumnValue column={column} value={task.properties[column.id]} />
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {task.notes && <Plain text={task.notes} className="text-sm" />}
      <p className="space-x-2 text-xs text-muted">
        {task.created_by && task.created_at ? (
          <span dir="auto">
            {t('made_by', {who: actorName(task.created_by, t)})} · {moment(task.created_at)}
          </span>
        ) : (
          task.on_board_since && <span>{t('on_board_since', {date: moment(task.on_board_since)})}</span>
        )}
        {task.finished_by && <span dir="auto">{t('finished_by', {who: actorName(task.finished_by, t)})}</span>}
      </p>
    </div>
  );
}

function EditTask({
  task,
  me,
  board,
  busy,
  onCancel,
  onSave,
}: {
  task: MemberDetail;
  me: MemberMe;
  board: Board;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: MemberTaskPatch) => void;
}) {
  const {t} = useWords();
  // Any group of the project can label the task, as everyone in its groups sees it either way (ADR-0276).
  const groups = boardGroups(me, task.project);
  const projectName = me.projects.find(item => item.id === task.project)?.name ?? '';
  const [title, setTitle] = React.useState(task.title);
  const [notes, setNotes] = React.useState(task.notes);
  const [due, setDue] = React.useState(task.due_on ?? '');
  const [tags, setTags] = React.useState(task.tags.join(', '));
  const [group, setGroup] = React.useState(task.group ?? '');
  const [status, setStatus] = React.useState(task.status);
  const [columns, setColumns] = React.useState(() => draftsOf(board, task.properties));
  const [error, setError] = React.useState<string | null>(null);
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return setError(t('title_required'));
    const values = columnPatch(board, columns, task.properties);
    if ('invalid' in values) return setError(t('number_invalid', {column: values.invalid}));
    const patch: MemberTaskPatch = {};
    if (title.trim() !== task.title) patch.title = title.trim();
    if (notes !== task.notes) patch.notes = notes;
    if ((due || null) !== task.due_on) {
      patch.due_on = due || null;
      if (!due) patch.due_time = null;
    }
    const nextTags = tagList(tags);
    if (nextTags.join('\n') !== task.tags.join('\n')) patch.tags = nextTags;
    if ((group || null) !== task.group) patch.group = group || null;
    if (status !== task.status) patch.status = status;
    if (Object.keys(values.properties).length) patch.properties = values.properties;
    onSave(patch);
  };
  return (
    <form onSubmit={save} className="space-y-3" aria-label={t('edit')}>
      <Field label={t('field_title')} htmlFor="member-edit-title" error={error}>
        <Input id="member-edit-title" dir="auto" value={title} onChange={event => setTitle(event.target.value)} />
      </Field>
      <Field label={t('field_notes')} htmlFor="member-edit-notes">
        <Textarea id="member-edit-notes" dir="auto" value={notes} onChange={event => setNotes(event.target.value)} />
      </Field>
      <StatusField board={board} id="member-edit-status" value={status} onChange={setStatus} />
      <Field label={t('field_due')} htmlFor="member-edit-due">
        <Input id="member-edit-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
      </Field>
      <Field label={t('field_tags')} htmlFor="member-edit-tags" hint={t('tags_hint')}>
        <Input id="member-edit-tags" dir="auto" value={tags} onChange={event => setTags(event.target.value)} />
      </Field>
      <Field label={t('field_group')} htmlFor="member-edit-group">
        <Select id="member-edit-group" value={group} onChange={event => setGroup(event.target.value)}>
          {groups.map(item => (
            <option key={item.id} value={item.id}>
              {item.title?.trim() || t('unnamed_group')}
            </option>
          ))}
          {task.group && !groups.some(item => item.id === task.group) && (
            <option value={task.group}>{t('unnamed_group')}</option>
          )}
          <option value="">{t('whole_project')}</option>
        </Select>
      </Field>
      <AudienceLine projectName={projectName} />
      <ColumnFields board={board} prefix="member-edit" drafts={columns} onChange={setColumns} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" busy={busy}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

function Reminders({
  task,
  me,
  enabled,
  busy,
  onChange,
}: {
  task: MemberDetail;
  me: MemberMe;
  enabled: boolean;
  busy: string | null;
  onChange: (key: string, patch: MemberTaskPatch, success: WordKey) => Promise<boolean>;
}) {
  const {t, moment} = useWords();
  const [adding, setAdding] = React.useState<number | 'new' | null>(null);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const mine = task.reminders.mine;
  const others = task.reminders.others;
  const set = async (event: React.FormEvent) => {
    event.preventDefault();
    const at = localMoment(value);
    if (!at || new Date(at).getTime() <= Date.now()) return setError(t('reminder_in_past'));
    const list = mine.map(item => item.at);
    if (adding === 'new') list.push(at);
    else if (typeof adding === 'number') list[adding] = at;
    if (await onChange('reminders', {reminders: list}, 'reminder_set')) {
      setAdding(null);
      setValue('');
      setError(null);
    }
  };
  const editable = enabled && !task.trashed;
  // A member removes their own reminders whenever they can write, even while new ones can't reach them (ADR-0265 D9).
  const removable = me.mode === 'write' && !task.trashed;
  return (
    <Section title={t('reminders')}>
      {mine.length === 0 && <p className="text-[13px] text-muted">{t('no_reminders_mine')}</p>}
      {mine.length > 0 && (
        <ul className="space-y-1" aria-label={t('reminders')}>
          {mine.map((item, index) => (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <Bell className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="flex-1">{moment(item.at)}</span>
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => {
                    setAdding(index);
                    setValue(localInput(item.at));
                  }}
                >
                  {t('change')}
                </Button>
              )}
              {removable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() =>
                    void onChange(
                      'reminders',
                      {reminders: mine.filter(other => other.id !== item.id).map(other => other.at)},
                      'reminder_removed',
                    )
                  }
                >
                  {t('remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <p className="text-[13px] text-muted">{others === 1 ? t('others_one') : t('others_many', {count: others})}</p>
      )}
      {editable && adding !== null && (
        <form onSubmit={set} className="flex flex-wrap items-end gap-2">
          <Field label={t('remind_when')} htmlFor="member-remind-at" error={error}>
            <Input
              id="member-remind-at"
              type="datetime-local"
              value={value}
              onChange={event => setValue(event.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit" busy={busy === 'reminders'}>
            {t('set')}
          </Button>
          <Button onClick={() => setAdding(null)}>{t('cancel')}</Button>
        </form>
      )}
      {editable && adding === null && mine.length < 10 && (
        <Button size="sm" disabled={!!busy} onClick={() => setAdding('new')}>
          <Bell aria-hidden /> {t('remind_me')}
        </Button>
      )}
      {me.mode === 'write' && !me.reminders.available && (
        <p className="text-[13px] text-muted">{t(whyKey[me.reminders.reason])}</p>
      )}
    </Section>
  );
}

function Comments({
  task,
  write,
  onSaved,
  onFailed,
  onChanged,
}: {
  task: MemberDetail;
  write: boolean;
  onSaved: (task: MemberDetail) => void;
  onFailed: (error: unknown) => Promise<void>;
  onChanged: () => void;
}) {
  const {t, moment} = useWords();
  const toast = useToast();
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const operation = React.useRef(operationId());
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      onSaved(await memberApi.comment(task.id, {operation_id: operation.current, text: text.trim()}));
      operation.current = operationId();
      setText('');
      toast(t('comment_added'));
      onChanged();
    } catch (error) {
      await onFailed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('comments')}>
      {!task.comment_list.length && <p className="text-[13px] text-muted">{t('no_comments')}</p>}
      {task.comment_list.length > 0 && (
        <ul className="space-y-3" aria-label={t('comments')}>
          {task.comment_list.map(comment => (
            <li key={comment.id} className="space-y-0.5">
              <p className="text-xs text-muted" dir="auto">
                <span className="font-medium text-fg">{actorName(comment.author, t)}</span> ·{' '}
                {moment(comment.created_at)}
              </p>
              <Plain text={comment.body} className="text-sm" />
            </li>
          ))}
        </ul>
      )}
      {write && !task.trashed && (
        <form onSubmit={send} className="flex items-end gap-2">
          <Textarea
            aria-label={t('write_comment')}
            placeholder={t('write_comment')}
            dir="auto"
            className="min-h-10 flex-1"
            value={text}
            onChange={event => setText(event.target.value)}
          />
          <Button type="submit" busy={busy} disabled={!text.trim()}>
            {t('send')}
          </Button>
        </form>
      )}
    </Section>
  );
}
