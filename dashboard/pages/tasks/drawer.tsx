/**
 * One task in a side panel: every field the task has, edited and saved together
 * from the top of the panel, plus its subtasks, comments and history, which
 * change at once.
 */
import * as React from 'react';
import {useEffect, useState} from 'react';
import {
  Archive,
  ArchiveRestore,
  Bell,
  Check,
  CornerLeftUp,
  ExternalLink,
  Link2,
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {Markdown} from '../../lib/markdown';
import {useResource} from '../../lib/resource';
import {cn} from '../../lib/utils';
import {
  Badge,
  Button,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Segmented,
  Select,
  Switch,
  Textarea,
} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import {ChatPicker} from '../chats/chat-picker';
import {useCommand, when} from '../memory/shared';
import {ListField, PeopleField, TagsField, withPending} from './fields';
import {
  actorName,
  day,
  priorityOf,
  repeatText,
  statusOf,
  weekdayNames,
  type Attachment,
  type Detail,
  type LinkedTask,
  type Person,
  type Repeat,
  type Scope,
  type Task,
  type TaskPage,
  type TaskSettings,
} from './model';

type Draft = {
  title: string;
  notes: string;
  status: string;
  priority: number;
  start_on: string;
  start_time: string;
  due_on: string;
  due_time: string;
  repeat: Repeat | null;
  scope: string;
  group: string | null;
  tags: string[];
  assignees: Person[];
  people: Person[];
  properties: Record<string, unknown>;
  reminders: string[];
  blocked_by: LinkedTask[];
  related: LinkedTask[];
  attachments: Attachment[];
};

/** A reminder's moment as the value of a date-and-time box, in this device's time. */
function localMoment(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function draftOf(task: Detail): Draft {
  return {
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    start_on: task.start_on ?? '',
    start_time: task.start_time ?? '',
    due_on: task.due_on ?? '',
    due_time: task.due_time ?? '',
    repeat: task.repeat,
    scope: task.project_id ?? 'personal',
    group: task.group_id,
    tags: task.tags,
    assignees: task.assignees,
    people: task.people,
    properties: task.properties,
    reminders: task.reminders.filter(item => item.state === 'pending').map(item => localMoment(item.at)),
    blocked_by: task.blocked_by,
    related: task.related,
    attachments: task.attachments,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ids = (items: {id: string}[]) => items.map(item => item.id).sort();

/** Only what changed, in the form the owner API takes. */
function changes(before: Draft, after: Draft, pendingTag: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const tags = withPending(after.tags, pendingTag);
  if (after.title !== before.title) body.title = after.title;
  if (after.notes !== before.notes) body.notes = after.notes;
  if (after.status !== before.status) body.status = after.status;
  if (after.priority !== before.priority) body.priority = after.priority;
  for (const key of ['start_on', 'start_time', 'due_on', 'due_time'] as const)
    if (after[key] !== before[key]) body[key] = after[key] || null;
  if (!same(after.repeat, before.repeat)) body.repeat = after.repeat;
  if (after.scope !== before.scope) body.scope = after.scope;
  if (after.group !== before.group) body.group = after.group;
  if (!same(tags, before.tags)) body.tags = tags;
  if (!same(ids(after.assignees), ids(before.assignees))) body.assignees = ids(after.assignees);
  if (!same(ids(after.people), ids(before.people))) body.people = ids(after.people);
  const properties: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]))
    if (!same(after.properties[key] ?? null, before.properties[key] ?? null))
      properties[key] = after.properties[key] ?? null;
  if (Object.keys(properties).length) body.properties = properties;
  if (!same(after.reminders, before.reminders)) body.reminders = after.reminders.filter(Boolean);
  if (!same(ids(after.blocked_by), ids(before.blocked_by))) body.blocked_by = ids(after.blocked_by);
  if (!same(ids(after.related), ids(before.related))) body.related = ids(after.related);
  if (!same(after.attachments, before.attachments))
    body.attachments = after.attachments.map(item =>
      item.kind === 'message'
        ? {kind: 'message', id: item.id, title: item.title}
        : {kind: 'link', url: item.url, title: item.title},
    );
  return body;
}

export function TaskDrawer({
  id,
  scopes,
  tags: knownTags,
  settings,
  groupName,
  onOpen,
  onClose,
}: {
  id: string;
  scopes: Scope[];
  tags: string[];
  settings: TaskSettings | undefined;
  groupName: (space: string) => string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const detail = useResource<Detail>('/tasks/' + id);
  const task = detail.data;
  const command = useCommand();
  const feedback = useFeedback();
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState(0);
  const [pendingTag, setPendingTag] = useState('');
  // A newer copy replaces the form only when nothing is being edited.
  useEffect(() => {
    if (!task) return;
    const fresh = draftOf(task);
    if (!draft || !base || (same(draft, base) && !pendingTag) || task.revision === revision) {
      setBase(fresh);
      setDraft(fresh);
      setRevision(task.revision);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.revision, task?.id]);
  const edited = base && draft ? changes(base, draft, pendingTag) : {};
  const dirty = Object.keys(edited).length > 0;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(current => (current ? {...current, [key]: value} : current));
  const discard = () => {
    setDraft(base);
    setPendingTag('');
    command.clear();
  };
  const save = async () => {
    if (!task || !dirty) return;
    const saved = await command.run('/tasks/' + task.id, {expected_revision: revision, ...edited});
    if (saved) {
      const fresh = draftOf({...task, ...saved});
      setBase(fresh);
      setDraft(fresh);
      setRevision(saved.revision);
      setPendingTag('');
      feedback.toast('Task saved.');
    }
  };
  const act = async (body: Record<string, unknown>, done: string) => {
    if (!task) return;
    const saved = await command.run('/tasks/' + task.id, {expected_revision: revision, ...body});
    if (saved) {
      setRevision(saved.revision);
      feedback.toast(done);
    }
  };
  const remove = async () => {
    if (!task) return;
    const ok = await feedback.confirm({
      title: 'Delete this task for good?',
      body: 'It and everything under it are deleted and can’t be brought back.',
      confirm: 'Delete for good',
      danger: true,
    });
    if (ok && (await command.run('/tasks/' + task.id + '/delete', {}))) {
      feedback.toast('Task deleted.');
      onClose();
    }
  };

  const trashed = !!task?.deleted_at;
  const actions = draft && task && !trashed && (
    <>
      <Button size="sm" disabled={!dirty || command.busy} onClick={discard}>
        Discard
      </Button>
      <Button
        size="sm"
        variant="primary"
        busy={command.busy}
        disabled={!dirty || !draft.title.trim()}
        onClick={() => void save()}
        title={dirty ? undefined : 'No unsaved changes'}
      >
        Save
      </Button>
    </>
  );
  return (
    <Drawer
      open
      wide
      onOpenChange={open => {
        if (open) return;
        if (dirty)
          void feedback
            .confirm({
              title: 'Leave without saving?',
              body: 'Your changes to this task will be lost.',
              confirm: 'Leave',
              danger: true,
            })
            .then(ok => ok && onClose());
        else onClose();
      }}
      title={task ? (trashed ? 'In the trash' : task.archived_at ? 'Archived task' : 'Task') : 'Task'}
      actions={actions}
      footer={
        task && (
          <div className="flex w-full flex-wrap gap-2">
            {trashed ? (
              <>
                <Button size="sm" disabled={command.busy} onClick={() => void act({trashed: false}, 'Task restored.')}>
                  <RotateCcw aria-hidden /> Restore
                </Button>
                <Button size="sm" variant="danger" disabled={command.busy} onClick={() => void remove()}>
                  <Trash2 aria-hidden /> Delete for good
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={command.busy || dirty}
                  onClick={() =>
                    void act(
                      {archived: !task.archived_at},
                      task.archived_at ? 'Task back in its list.' : 'Task archived.',
                    )
                  }
                >
                  {task.archived_at ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                  {task.archived_at ? 'Unarchive' : 'Archive'}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={command.busy || dirty}
                  onClick={() => void act({trashed: true}, 'Task moved to the trash.')}
                >
                  <Trash2 aria-hidden /> Move to trash
                </Button>
              </>
            )}
          </div>
        )
      }
    >
      {detail.error && !task ? (
        <LoadError what="this task" />
      ) : !task || !draft ? (
        <LoadingRows rows={6} />
      ) : (
        <TaskForm
          task={task}
          draft={draft}
          set={set}
          scopes={scopes}
          knownTags={knownTags}
          settings={settings}
          pendingTag={pendingTag}
          onPendingTag={setPendingTag}
          groupName={groupName}
          onOpen={onOpen}
          error={command.error}
          readOnly={trashed}
        />
      )}
    </Drawer>
  );
}

function Section({title, children, aside}: {title: string; children: React.ReactNode; aside?: React.ReactNode}) {
  return (
    <section className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TaskForm({
  task,
  draft,
  set,
  scopes,
  knownTags,
  settings,
  pendingTag,
  onPendingTag,
  groupName,
  onOpen,
  error,
  readOnly,
}: {
  task: Detail;
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  scopes: Scope[];
  knownTags: string[];
  settings: TaskSettings | undefined;
  pendingTag: string;
  onPendingTag: (text: string) => void;
  groupName: (space: string) => string;
  onOpen: (id: string) => void;
  error: string;
  readOnly: boolean;
}) {
  const [writing, setWriting] = useState<'write' | 'preview'>(task.notes ? 'preview' : 'write');
  const zone = settings?.time_zone;
  return (
    <fieldset disabled={readOnly} className="min-w-0 space-y-4">
      {error && <Notice tone="bad">{error}</Notice>}
      {task.parent && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[13px] text-accent-text hover:underline"
          onClick={() => onOpen(task.parent!.id)}
        >
          <CornerLeftUp className="size-3.5" aria-hidden /> Under “{task.parent.title}”
        </button>
      )}
      <Field label="Task" htmlFor="task-panel-title">
        <Input
          id="task-panel-title"
          value={draft.title}
          maxLength={300}
          onChange={event => set('title', event.target.value)}
          dir="auto"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status" htmlFor="task-panel-status">
          <Select id="task-panel-status" value={draft.status} onChange={event => set('status', event.target.value)}>
            {settings?.statuses.map(status => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="task-panel-priority">
          <Select
            id="task-panel-priority"
            value={String(draft.priority)}
            onChange={event => set('priority', Number(event.target.value))}
          >
            {settings?.priorities.map(priority => (
              <option key={priority.level} value={priority.level}>
                {priority.name}
              </option>
            ))}
          </Select>
        </Field>
        <ListField
          id="task-panel"
          scopes={scopes}
          scope={draft.scope}
          onScope={value => set('scope', value)}
          disabled={!!task.parent_id}
          {...(task.parent_id ? {hint: 'A subtask stays in its parent’s list.'} : {})}
        />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Start" htmlFor="task-panel-start">
          <Input
            id="task-panel-start"
            type="date"
            value={draft.start_on}
            onChange={event => set('start_on', event.target.value)}
          />
        </Field>
        <Field label="Start time" htmlFor="task-panel-start-time">
          <Input
            id="task-panel-start-time"
            type="time"
            value={draft.start_time}
            disabled={!draft.start_on}
            onChange={event => set('start_time', event.target.value)}
          />
        </Field>
        <Field label="Due" htmlFor="task-panel-due">
          <Input
            id="task-panel-due"
            type="date"
            value={draft.due_on}
            onChange={event => set('due_on', event.target.value)}
          />
        </Field>
        <Field label="Due time" htmlFor="task-panel-due-time">
          <Input
            id="task-panel-due-time"
            type="time"
            value={draft.due_time}
            disabled={!draft.due_on}
            onChange={event => set('due_time', event.target.value)}
          />
        </Field>
      </div>
      {zone && <p className="-mt-2 text-xs text-muted">Times are in {zone.replace(/_/g, ' ')}.</p>}
      <RepeatField repeat={draft.repeat} onRepeat={value => set('repeat', value)} />
      <RemindersField
        reminders={draft.reminders}
        sent={task.reminders.filter(item => item.state !== 'pending')}
        onReminders={value => set('reminders', value)}
        zone={zone}
      />
      <TagsField
        id="task-panel"
        tags={draft.tags}
        onTags={value => set('tags', value)}
        pending={pendingTag}
        onPending={onPendingTag}
        known={knownTags}
      />
      <ChatPicker
        label="Group"
        value={draft.group ? [draft.group] : []}
        onChange={value => set('group', value.at(-1) ?? null)}
        groupsOnly
        hint={
          draft.group
            ? 'Points to ' + groupName(draft.group) + '.'
            : 'The group, or a topic in it, this task belongs to.'
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <PeopleField
          id="task-panel-assignees"
          label="Assigned to"
          hint="Who does it. Leave empty for you."
          people={draft.assignees}
          onPeople={value => set('assignees', value)}
        />
        <PeopleField
          id="task-panel-people"
          label="People"
          hint="Who it is about, from Memory › People."
          people={draft.people}
          onPeople={value => set('people', value)}
        />
      </div>
      {!!settings?.properties.length && (
        <PropertiesField settings={settings} values={draft.properties} onValues={value => set('properties', value)} />
      )}
      <Field
        label="Notes"
        htmlFor="task-panel-notes"
        aside={
          <Segmented
            label="Notes view"
            size="sm"
            value={writing}
            onChange={setWriting}
            options={[
              {value: 'write', label: 'Write'},
              {value: 'preview', label: 'Preview'},
            ]}
          />
        }
        hint="Markdown works: **bold**, lists, [links](https://…)."
      >
        {writing === 'write' ? (
          <Textarea
            id="task-panel-notes"
            value={draft.notes}
            maxLength={20000}
            rows={6}
            dir="auto"
            onChange={event => set('notes', event.target.value)}
          />
        ) : draft.notes.trim() ? (
          <Markdown text={draft.notes} className="rounded-lg border border-line px-3 py-2" />
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">No notes yet.</p>
        )}
      </Field>
      <LinksField task={task} draft={draft} set={set} />
      <AttachmentsField attachments={draft.attachments} onAttachments={value => set('attachments', value)} />
      {!readOnly && <Subtasks task={task} settings={settings} onOpen={onOpen} />}
      <Comments task={task} readOnly={readOnly} />
      <History task={task} settings={settings} />
      {!!Object.keys(task.external).length && (
        <p className="text-xs text-muted">
          Linked outside Nocheh:{' '}
          {Object.entries(task.external)
            .map(([name, value]) => name + ' ' + value)
            .join(', ')}
        </p>
      )}
    </fieldset>
  );
}

function RepeatField({repeat, onRepeat}: {repeat: Repeat | null; onRepeat: (repeat: Repeat | null) => void}) {
  const unit = repeat?.unit ?? 'none';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Repeat" htmlFor="task-panel-repeat" className="w-44">
          <Select
            id="task-panel-repeat"
            value={unit}
            onChange={event =>
              onRepeat(
                event.target.value === 'none'
                  ? null
                  : {
                      every: repeat?.every ?? 1,
                      unit: event.target.value as Repeat['unit'],
                      from: repeat?.from ?? 'due',
                    },
              )
            }
          >
            <option value="none">Doesn’t repeat</option>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
          </Select>
        </Field>
        {repeat && (
          <>
            <Field label="Every" htmlFor="task-panel-every" className="w-24">
              <Input
                id="task-panel-every"
                type="number"
                min={1}
                max={365}
                value={repeat.every}
                onChange={event =>
                  onRepeat({...repeat, every: Math.max(1, Math.min(365, Number(event.target.value) || 1))})
                }
              />
            </Field>
            <Field label="Count from" htmlFor="task-panel-from" className="w-44">
              <Select
                id="task-panel-from"
                value={repeat.from}
                onChange={event => onRepeat({...repeat, from: event.target.value as Repeat['from']})}
              >
                <option value="due">Its due day</option>
                <option value="done">The day it’s done</option>
              </Select>
            </Field>
          </>
        )}
      </div>
      {repeat?.unit === 'week' && (
        <div role="group" aria-label="Repeat on" className="flex flex-wrap gap-1">
          {weekdayNames.map((name, index) => {
            const on = !!repeat.weekdays?.includes(index);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                className={cn(
                  'h-7 rounded-md border px-2 text-xs',
                  on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:text-fg',
                )}
                onClick={() => {
                  const days = on
                    ? repeat.weekdays!.filter(item => item !== index)
                    : [...(repeat.weekdays ?? []), index].sort();
                  const {weekdays: _old, ...rest} = repeat;
                  onRepeat(days.length ? {...rest, weekdays: days} : rest);
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      {repeat && <p className="text-xs text-muted">{repeatText(repeat)}. Finishing it makes the next one.</p>}
    </div>
  );
}

function RemindersField({
  reminders,
  sent,
  onReminders,
  zone,
}: {
  reminders: string[];
  sent: Task['reminders'];
  onReminders: (value: string[]) => void;
  zone: string | undefined;
}) {
  return (
    <Field
      label="Reminders"
      hint={'Sent to your private chat with Nocheh' + (zone ? `, at times in ${zone.replace(/_/g, ' ')}.` : '.')}
    >
      <div className="space-y-2">
        {reminders.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <Bell className="size-4 shrink-0 text-muted" aria-hidden />
            <Input
              type="datetime-local"
              aria-label={'Reminder ' + (index + 1)}
              value={value}
              className="w-60"
              onChange={event => onReminders(reminders.map((item, at) => (at === index ? event.target.value : item)))}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={'Remove reminder ' + (index + 1)}
              onClick={() => onReminders(reminders.filter((_, at) => at !== index))}
            >
              <X aria-hidden />
            </Button>
          </div>
        ))}
        {sent.map(item => (
          <p key={item.at} className="flex items-center gap-2 text-xs text-muted">
            <Check className="size-3.5" aria-hidden />
            {item.state === 'sent'
              ? 'Sent'
              : item.state === 'skipped'
                ? 'Not needed'
                : item.state === 'uncertain'
                  ? 'May not have arrived'
                  : 'Sending'}{' '}
            · {when(item.at)}
          </p>
        ))}
        {reminders.length < 10 && (
          <Button size="sm" onClick={() => onReminders([...reminders, ''])}>
            <Plus aria-hidden /> Add reminder
          </Button>
        )}
      </div>
    </Field>
  );
}

/** The owner's own columns from Settings › Tasks. */
function PropertiesField({
  settings,
  values,
  onValues,
}: {
  settings: TaskSettings;
  values: Record<string, unknown>;
  onValues: (values: Record<string, unknown>) => void;
}) {
  const set = (id: string, value: unknown) => {
    const next = {...values};
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) delete next[id];
    else next[id] = value;
    onValues(next);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {settings.properties.map(property => {
        const id = 'task-property-' + property.id;
        const value = values[property.id];
        if (property.type === 'checkbox')
          return (
            <Field key={property.id} label={property.name} htmlFor={id}>
              <Switch
                id={id}
                label={property.name}
                checked={value === true}
                onChange={on => set(property.id, on || null)}
              />
            </Field>
          );
        if (property.type === 'select')
          return (
            <Field key={property.id} label={property.name} htmlFor={id}>
              <Select
                id={id}
                value={String(value ?? '')}
                onChange={event => set(property.id, event.target.value || null)}
              >
                <option value="">—</option>
                {property.options.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
          );
        if (property.type === 'multi_select' || property.type === 'person') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          if (property.type === 'person')
            return (
              <PersonProperty
                key={property.id}
                id={id}
                name={property.name}
                chosen={chosen}
                onChosen={next => set(property.id, next)}
              />
            );
          return (
            <Field key={property.id} label={property.name}>
              <div role="group" aria-label={property.name} className="flex flex-wrap gap-1">
                {property.options.map(option => {
                  const on = chosen.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set(property.id, on ? chosen.filter(item => item !== option.id) : [...chosen, option.id])
                      }
                      className={cn(
                        'h-7 rounded-md border px-2 text-xs',
                        on ? 'border-accent bg-accent-soft text-accent-text' : 'border-line text-muted hover:text-fg',
                      )}
                    >
                      {option.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          );
        }
        return (
          <Field key={property.id} label={property.name} htmlFor={id}>
            <Input
              id={id}
              type={
                property.type === 'number'
                  ? 'number'
                  : property.type === 'date'
                    ? 'date'
                    : property.type === 'url'
                      ? 'url'
                      : 'text'
              }
              value={value === undefined || value === null ? '' : String(value)}
              placeholder={property.type === 'url' ? 'https://' : undefined}
              onChange={event =>
                set(
                  property.id,
                  property.type === 'number'
                    ? event.target.value === ''
                      ? null
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          </Field>
        );
      })}
    </div>
  );
}

function PersonProperty({
  id,
  name,
  chosen,
  onChosen,
}: {
  id: string;
  name: string;
  chosen: string[];
  onChosen: (ids: string[]) => void;
}) {
  const known = useResource<{entities: Person[]}>('/entities?kind=person&q=&after=&state=active', 60000);
  const people = chosen.map(
    item => known.data?.entities.find(person => person.id === item) ?? {id: item, name: 'Someone'},
  );
  return (
    <PeopleField
      id={id}
      label={name}
      hint=""
      people={people}
      onPeople={next => onChosen(next.map(person => person.id))}
    />
  );
}

/** Tasks this one waits on, and related tasks, picked from the same list. */
function LinksField({
  task,
  draft,
  set,
}: {
  task: Detail;
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const others = useResource<TaskPage>(
    `/tasks?state=open&scope=${encodeURIComponent(task.project_id ?? 'personal')}&limit=200&sort=title`,
  );
  const candidates = (others.data?.tasks ?? []).filter(item => item.id !== task.id);
  const picker = (key: 'blocked_by' | 'related', label: string, hint: string) => {
    const chosen = draft[key];
    return (
      <Field label={label} htmlFor={'task-panel-' + key} hint={hint}>
        <div className="space-y-2">
          {!!chosen.length && (
            <ul className="space-y-1" aria-label={label}>
              {chosen.map(item => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <Link2 className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <span
                    className={cn('min-w-0 flex-1 truncate', item.state !== 'open' && 'text-muted line-through')}
                    dir="auto"
                  >
                    {item.title}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={'Remove ' + item.title}
                    onClick={() =>
                      set(
                        key,
                        chosen.filter(other => other.id !== item.id),
                      )
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Select
            id={'task-panel-' + key}
            value=""
            onChange={event => {
              const item = candidates.find(other => other.id === event.target.value);
              if (item)
                set(key, [...chosen, {id: item.id, title: item.title, state: item.state, project_id: item.project_id}]);
            }}
          >
            <option value="">Add a task…</option>
            {candidates
              .filter(item => !chosen.some(other => other.id === item.id))
              .map(item => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </Select>
        </div>
      </Field>
    );
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {picker('blocked_by', 'Waiting on', 'Tasks that must be done first.')}
      {picker('related', 'Related', 'Shown on both tasks.')}
      {!!task.blocking.length && (
        <p className="text-xs text-muted sm:col-span-2">
          Holding up: {task.blocking.map(item => item.title).join(', ')}
        </p>
      )}
    </div>
  );
}

function AttachmentsField({
  attachments,
  onAttachments,
}: {
  attachments: Attachment[];
  onAttachments: (value: Attachment[]) => void;
}) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const valid = /^https?:\/\/\S+$/.test(address.trim());
  return (
    <Field
      label="Links and messages"
      htmlFor="task-panel-link"
      hint="Web links, and messages Nocheh keeps that belong with this task."
    >
      <div className="space-y-2">
        {!!attachments.length && (
          <ul className="space-y-1" aria-label="Links and messages">
            {attachments.map((item, index) => (
              <li key={index} className="flex items-center gap-2 text-sm">
                {item.kind === 'link' ? (
                  <ExternalLink className="size-3.5 shrink-0 text-muted" aria-hidden />
                ) : (
                  <MessageSquare className="size-3.5 shrink-0 text-muted" aria-hidden />
                )}
                <a
                  className="min-w-0 flex-1 truncate text-accent-text hover:underline"
                  href={item.kind === 'link' ? item.url : '#messages?source=' + encodeURIComponent(item.id)}
                  {...(item.kind === 'link' ? {target: '_blank', rel: 'noreferrer noopener'} : {})}
                  dir="auto"
                >
                  {item.title || (item.kind === 'link' ? item.url : 'A message')}
                </a>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={'Remove ' + (item.title || (item.kind === 'link' ? item.url : 'message'))}
                  onClick={() => onAttachments(attachments.filter((_, at) => at !== index))}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {attachments.length < 20 && (
          <div className="flex flex-wrap gap-2">
            <Input
              id="task-panel-link"
              type="url"
              placeholder="https://"
              value={address}
              className="min-w-0 flex-1 basis-48"
              onChange={event => setAddress(event.target.value)}
            />
            <Input
              aria-label="Link name"
              placeholder="Name (optional)"
              value={label}
              maxLength={200}
              className="w-44"
              onChange={event => setLabel(event.target.value)}
            />
            <Button
              disabled={!valid}
              onClick={() => {
                onAttachments([...attachments, {kind: 'link', id: null, url: address.trim(), title: label.trim()}]);
                setAddress('');
                setLabel('');
              }}
            >
              <Plus aria-hidden /> Add link
            </Button>
          </div>
        )}
      </div>
    </Field>
  );
}

function Subtasks({
  task,
  settings,
  onOpen,
}: {
  task: Detail;
  settings: TaskSettings | undefined;
  onOpen: (id: string) => void;
}) {
  const command = useCommand();
  const [title, setTitle] = useState('');
  const open = task.subtasks.filter(item => item.state === 'open').length;
  const add = async () => {
    if (!title.trim()) return;
    if (await command.run('/tasks', {title, parent: task.id})) setTitle('');
  };
  return (
    <Section
      title="Subtasks"
      aside={
        task.subtasks.length ? (
          <span className="text-xs text-muted">
            {task.subtasks.length - open} of {task.subtasks.length} done
          </span>
        ) : null
      }
    >
      {!!task.subtasks.length && (
        <ul className="space-y-1" aria-label="Subtasks">
          {task.subtasks.map(item => (
            <li key={item.id} className="flex items-center gap-2">
              <button
                type="button"
                role="checkbox"
                aria-checked={item.state === 'done'}
                aria-label={item.state === 'open' ? `Mark “${item.title}” done` : `Reopen “${item.title}”`}
                disabled={command.busy}
                onClick={() =>
                  void command.run('/tasks/' + item.id, {
                    expected_revision: item.revision,
                    state: item.state === 'open' ? 'done' : 'open',
                  })
                }
                className={cn(
                  'flex size-4.5 shrink-0 items-center justify-center rounded border border-line-strong hover:border-accent',
                  item.state === 'done' && 'border-accent bg-accent text-on-accent',
                )}
              >
                {item.state === 'done' && <Check className="size-3" aria-hidden />}
              </button>
              <button
                type="button"
                className={cn(
                  'min-w-0 flex-1 truncate text-left text-sm hover:underline',
                  item.state !== 'open' && 'text-muted line-through',
                )}
                onClick={() => onOpen(item.id)}
                dir="auto"
              >
                {item.title}
              </button>
              {item.status !== settings?.statuses[0]?.id && item.state === 'open' && (
                <Badge tone={statusOf(settings, item.status)?.color ?? 'neutral'}>
                  {statusOf(settings, item.status)?.name}
                </Badge>
              )}
              {item.due_on && <span className="text-xs text-muted">{day(item.due_on)}</span>}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          void add();
        }}
      >
        <Input
          aria-label="New subtask"
          placeholder="Add a subtask"
          value={title}
          maxLength={300}
          onChange={event => setTitle(event.target.value)}
        />
        <Button type="submit" disabled={!title.trim()} busy={command.busy}>
          <Plus aria-hidden /> Add
        </Button>
      </form>
      {command.error && <p className="text-xs text-bad">{command.error}</p>}
    </Section>
  );
}

function Comments({task, readOnly}: {task: Detail; readOnly: boolean}) {
  const command = useCommand();
  const feedback = useFeedback();
  const [text, setText] = useState('');
  return (
    <Section title="Comments">
      {!task.comments.length && <p className="text-sm text-muted">No comments yet.</p>}
      <ul className="space-y-3" aria-label="Comments">
        {task.comments.map(comment => (
          <li key={comment.id} className="group space-y-0.5">
            <p className="flex items-center gap-2 text-xs text-muted">
              <span className="font-medium text-fg">{actorName(comment.author)}</span>
              {comment.origin === 'chat' && 'in chat'} · {when(comment.created_at)}
              {!readOnly && (
                <button
                  type="button"
                  className="ml-auto text-muted opacity-0 group-hover:opacity-100 hover:text-bad focus:opacity-100"
                  aria-label="Remove comment"
                  onClick={async () => {
                    if (await feedback.confirm({title: 'Remove this comment?', confirm: 'Remove', danger: true}))
                      await command.run('/tasks/' + task.id + '/comments', {remove: comment.id});
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </p>
            <Markdown text={comment.body} />
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form
          className="space-y-2"
          onSubmit={async event => {
            event.preventDefault();
            if (text.trim() && (await command.run('/tasks/' + task.id + '/comments', {text}))) setText('');
          }}
        >
          <Textarea
            aria-label="New comment"
            placeholder="Write a comment"
            value={text}
            maxLength={4000}
            rows={2}
            dir="auto"
            onChange={event => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!text.trim()} busy={command.busy}>
            Comment
          </Button>
        </form>
      )}
      {command.error && <p className="text-xs text-bad">{command.error}</p>}
    </Section>
  );
}

const fieldNames: Record<string, string> = {
  title: 'Title',
  notes: 'Notes',
  status_id: 'Status',
  priority: 'Priority',
  start_on: 'Start',
  start_time: 'Start time',
  due_on: 'Due',
  due_time: 'Due time',
  repeat: 'Repeat',
  project_id: 'List',
  group_id: 'Group',
  parent_id: 'Parent task',
  tags: 'Tags',
  properties: 'Columns',
  external: 'Outside links',
  people: 'People',
  assignees: 'Assigned to',
  blocked_by: 'Waiting on',
  related: 'Related',
  duplicate_of: 'Duplicate of',
  reminders: 'Reminders',
  attachments: 'Links and messages',
};

/** One line of history in plain words. */
function describe(changes: Record<string, any>, settings: TaskSettings | undefined): string[] {
  const lines: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key === 'created') lines.push('Added the task');
    else if (key === 'repeated_from') lines.push('Made as the next one of a repeating task');
    else if (key === 'reminded') lines.push('Sent a reminder');
    else if (key === 'state') continue;
    else if (key === 'archived') lines.push(change.to ? 'Archived it' : 'Took it out of the archive');
    else if (key === 'trashed') lines.push(change.to ? 'Moved it to the trash' : 'Restored it from the trash');
    else if (key === 'status_id')
      lines.push(
        `Status: ${statusOf(settings, change.from)?.name ?? change.from} → ${statusOf(settings, change.to)?.name ?? change.to}`,
      );
    else if (key === 'priority')
      lines.push(
        `Priority: ${priorityOf(settings, change.from)?.name ?? change.from} → ${priorityOf(settings, change.to)?.name ?? change.to}`,
      );
    else if (key === 'title') lines.push(`Renamed to “${change.to}”`);
    else if (['start_on', 'due_on'].includes(key))
      lines.push(`${fieldNames[key]}: ${change.to ? day(change.to) : 'none'}`);
    else if (['start_time', 'due_time'].includes(key)) lines.push(`${fieldNames[key]}: ${change.to ?? 'none'}`);
    else if (key === 'repeat') lines.push(change.to ? 'Repeat: ' + repeatText(change.to) : 'Stopped repeating');
    else if (key === 'project_id') lines.push('Moved to another list');
    else lines.push(`Changed ${(fieldNames[key] ?? key).toLowerCase()}`);
  }
  return lines;
}

function History({task, settings}: {task: Detail; settings: TaskSettings | undefined}) {
  return (
    <Section title="History">
      <ul className="space-y-2" aria-label="History">
        {task.activity.map(entry => (
          <li key={entry.id} className="text-xs">
            <span className="text-muted">
              {when(entry.at)} · {actorName(entry.actor)}
              {entry.origin === 'chat' ? ' in chat' : ''}
            </span>
            <span className="block text-fg">{describe(entry.changes, settings).join('; ')}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Added by {actorName(task.created_by)} {when(task.created_at)}
        {task.finished_by && task.done_at
          ? ` · ${task.state === 'done' ? 'Done' : 'Dropped'} by ${actorName(task.finished_by)} ${when(task.done_at)}`
          : ''}
      </p>
    </Section>
  );
}
