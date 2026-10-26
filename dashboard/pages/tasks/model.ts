/** Tasks as the owner API returns them, and small helpers the Tasks pages share. */
import type {Tone} from '../../ui/core';

export type TaskState = 'open' | 'done' | 'dropped';
export type Person = {id: string; name: string};
export type LinkedTask = {id: string; title: string; state: TaskState; project_id: string | null};
export type Actor = {kind: 'owner'} | {kind: 'member'; name?: string} | {kind: 'nocheh'};
export type Repeat = {
  every: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays?: number[];
  from: 'due' | 'done';
};
export type Attachment =
  {kind: 'message'; id: string; url: null; title: string} | {kind: 'link'; id: null; url: string; title: string};
export type Task = {
  id: string;
  title: string;
  notes: string;
  status: string;
  state: TaskState;
  priority: number;
  start_on: string | null;
  start_time: string | null;
  due_on: string | null;
  due_time: string | null;
  repeat: Repeat | null;
  repeated_to: string | null;
  parent_id: string | null;
  position: number;
  project_id: string | null;
  group_id: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  external: Record<string, string>;
  people: Person[];
  assignees: Person[];
  subtasks: {open: number; total: number};
  blocked_by: LinkedTask[];
  reminders: {at: string; state: 'pending' | 'sending' | 'sent' | 'uncertain' | 'skipped'}[];
  attachments: Attachment[];
  comments: number;
  origin: 'dashboard' | 'chat' | 'repeat';
  created_by: Actor;
  finished_by: Actor | null;
  revision: number;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
};
/** One task opened on its own, with what sits under it, its links, comments and history. */
export type Detail = Omit<Task, 'subtasks' | 'comments'> & {
  parent: {id: string; title: string; state: TaskState} | null;
  subtasks: Task[];
  blocking: LinkedTask[];
  related: LinkedTask[];
  duplicate_of: LinkedTask[];
  duplicates: LinkedTask[];
  comments: {id: string; body: string; author: Actor; origin: string; created_at: string}[];
  activity: {id: string; at: string; actor: Actor; origin: string; changes: Record<string, any>}[];
};

export type StatusCategory = 'not_started' | 'active' | 'done' | 'cancelled';
export type TaskStatus = {id: string; name: string; category: StatusCategory; color: Tone};
export type PropertyType = 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'checkbox' | 'url' | 'person';
export type TaskProperty = {
  id: string;
  name: string;
  type: PropertyType;
  options: {id: string; name: string; color: Tone}[];
};
export type TaskSettings = {
  statuses: TaskStatus[];
  priorities: {level: number; name: string; color: Tone}[];
  properties: TaskProperty[];
  time_zone: string;
};
/** A list: 'personal', or a project's own list. */
export type Scope = {id: string; name: string | null; open: number};
export type TaskPage = {
  tasks: Task[];
  next: string | null;
  counts: Record<TaskState | 'today' | 'upcoming' | 'archive' | 'trash', number>;
  scopes: Scope[];
  tags: {name: string; open: number}[];
  settings: TaskSettings;
  today: string;
};

export const scopeName = (scope: Scope | undefined) =>
  !scope ? 'Personal' : scope.id === 'personal' ? 'Personal' : scope.name || 'Project';

/** Today as the owner's own calendar day, YYYY-MM-DD. */
export function localToday(): string {
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

export function addDays(value: string, days: number): string {
  return new Date(Date.parse(value + 'T00:00:00Z') + days * 864e5).toISOString().slice(0, 10);
}

export const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const units = {day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years']};
/** "Every week on Mon, Thu" or "Every 2 days after it is done". */
export function repeatText(repeat: Repeat): string {
  const [one, many] = units[repeat.unit];
  let text = repeat.every === 1 ? `Every ${one}` : `Every ${repeat.every} ${many}`;
  if (repeat.weekdays?.length) text += ' on ' + repeat.weekdays.map(index => weekdayNames[index]).join(', ');
  if (repeat.from === 'done') text += ' after it is done';
  return text;
}

export function actorName(actor: Actor | null | undefined): string {
  if (!actor || actor.kind === 'owner') return 'You';
  if (actor.kind === 'nocheh') return 'Nocheh';
  return actor.name || 'Someone in the chat';
}

export const statusOf = (settings: TaskSettings | undefined, id: string) =>
  settings?.statuses.find(status => status.id === id);
export const priorityOf = (settings: TaskSettings | undefined, level: number) =>
  settings?.priorities.find(priority => priority.level === level);
