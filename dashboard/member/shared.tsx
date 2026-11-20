/**
 * What the members' app's tabs share: its words and formats, a board's status and column names, who does a task, a side
 * sheet, short messages, and safe links and text.
 */
import * as React from 'react';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {X} from 'lucide-react';
import type {
  MemberActor,
  MemberMe,
  MemberRemindersReason,
  MemberTask,
  MemberTaskColumn,
  MemberTaskStatus,
} from '../../src/member-app-wire';
import {cn} from '../lib/utils';
import {Button} from '../ui/core';
import {memberAppErrors} from '../../src/member-app-wire';
import {MemberApiError} from './api';
import {translate, type Translate, type WordKey} from './i18n';

export type Words = {
  t: Translate;
  /** A day such as 2026-11-20, as a date (no time zone: it is a calendar day). */
  day: (value: string) => string;
  /** A moment, in the phone's own time zone. */
  moment: (value: string) => string;
};
export function makeWords(): Words {
  const days = new Intl.DateTimeFormat('en', {dateStyle: 'medium'});
  const moments = new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'short'});
  return {
    t: translate,
    day: value => {
      const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      return found ? days.format(new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]))) : value;
    },
    moment: value => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : moments.format(date);
    },
  };
}
export const WordsContext = React.createContext<Words>(makeWords());
export const useWords = () => React.useContext(WordsContext);

/** Who did something, by their Telegram name; never the owner's names for people. */
export function actorName(actor: MemberActor | undefined, t: Translate): string {
  if (!actor) return '';
  if (actor.kind === 'owner') return t('owner');
  if (actor.kind === 'nocheh') return t('nocheh');
  return actor.name?.trim() || t('a_member');
}

/** What a board names a task's status and shared columns by: the page's `statuses` and `columns` (MemberTaskPage). */
export type Board = {statuses: MemberTaskStatus[]; columns: MemberTaskColumn[]};
export const emptyBoard: Board = {statuses: [], columns: []};

const stateWords: Record<MemberTask['state'], WordKey> = {
  open: 'state_open',
  done: 'state_done',
  dropped: 'state_dropped',
};
/** A status by the name the owner gave it; one the board does not list says only what it means. */
export function statusName(task: Pick<MemberTask, 'status' | 'state'>, board: Board, t: Translate): string {
  return board.statuses.find(item => item.id === task.status)?.name ?? t(stateWords[task.state] ?? 'state_open');
}

/** "a, b and c": the page's own way of listing. */
export function listText(items: string[], t: Translate): string {
  if (items.length < 2) return items[0] ?? '';
  return t('list_and', {first: items.slice(0, -1).join(', '), last: items[items.length - 1]!});
}
/**
 * Who does a task, as the member may see it: assignees by their Telegram name, and everyone else counted ("Sara, Omid
 * and 2 other people"); null when it has none. The owner's own names for people never reach the page.
 */
export function assigneeText(task: Pick<MemberTask, 'assignees' | 'assignees_other'>, t: Translate): string | null {
  const names = task.assignees.map(item => item.name.trim()).filter(Boolean);
  const others = Math.max(0, Math.trunc(task.assignees_other || 0)) + (task.assignees.length - names.length);
  const items = others ? [...names, others === 1 ? t('other_person') : t('other_people', {count: others})] : names;
  return items.length ? listText(items, t) : null;
}

export const whyKey: Record<MemberRemindersReason, WordKey> = {
  read_only: 'why_read_only',
  reminders_off: 'why_reminders_off',
  private_chat_off: 'why_private_chat_off',
};

/**
 * What a failed write says, or null when the answer already ended the visit (a 401 or a closed app shows its screen).
 * `reload` is true when what the member may do changed (read only now, reminders off), so the page reads /me again.
 */
export function problem(error: unknown): {word: WordKey; reload: boolean} | null {
  if (!(error instanceof MemberApiError)) return {word: 'failed', reload: false};
  if (error.status === 401 || error.code === memberAppErrors.closed || error.code === memberAppErrors.memberRequired)
    return null;
  if (error.code === memberAppErrors.readOnly) return {word: 'read_only_now', reload: true};
  if (error.code === memberAppErrors.remindersOff) return {word: 'why_reminders_off', reload: true};
  if (error.code === memberAppErrors.remindersUnavailable) return {word: 'reminders_unavailable', reload: true};
  if (error.code === memberAppErrors.busy) return {word: 'busy', reload: false};
  if (error.code === memberAppErrors.fieldNotAllowed) return {word: 'not_allowed', reload: false};
  if (error.code === memberAppErrors.conflict) return {word: 'conflict', reload: false};
  if (error.status === 404) return {word: 'not_found', reload: false};
  return {word: 'failed', reload: false};
}

/** A group's Telegram title, from the member's own groups. */
export function groupTitle(me: MemberMe, group: string | null, t: Translate): string {
  if (!group) return t('whole_project');
  return me.groups.find(item => item.id === group)?.title?.trim() || t('unnamed_group');
}

/** Only http(s) links are ever followed; anything else is shown as text. */
export function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Text someone wrote, as plain text: never HTML, and its own direction. */
export function Plain({text, className}: {text: string; className?: string}) {
  return (
    <p className={cn('break-words whitespace-pre-wrap', className)} dir="auto">
      {text}
    </p>
  );
}

/** A day plus a time as written, for a task's due date. */
export function dueText(task: Pick<MemberTask, 'due_on' | 'due_time'>, words: Words): string | null {
  if (!task.due_on) return null;
  return words.day(task.due_on) + (task.due_time ? ' ' + task.due_time : '');
}

/** An ISO moment with the phone's own offset, from a datetime-local value; null when unreadable. */
export function localMoment(value: string): string | null {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${offset >= 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}
/** A moment as a datetime-local value in the phone's zone. */
export function localInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Splits "a, b" into tags. */
export const tagList = (value: string) => [
  ...new Set(
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  ),
];

/** Says who will see a task in this group, or in the whole project. */
export function AudienceLine({me, group, projectName}: {me: MemberMe; group: string; projectName: string}) {
  const {t} = useWords();
  return (
    <p className="text-xs text-muted" dir="auto">
      {group ? t('group_line', {group: groupTitle(me, group, t)}) : t('whole_project_line', {project: projectName})}
    </p>
  );
}

/** A panel over the page, for one task or one form, with its own Close. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const {t} = useWords();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-xl border border-line bg-surface shadow-xl focus:outline-none"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <DialogPrimitive.Title className="min-w-0 text-base font-semibold break-words" dir="auto">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('close')}>
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type Toast = {id: number; text: string; bad: boolean};
const ToastContext = React.createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => React.useContext(ToastContext);
/** Short messages at the bottom, read out by screen readers. */
export function Toasts({children}: {children: React.ReactNode}) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const next = React.useRef(0);
  const show = React.useCallback((text: string, bad = false) => {
    const id = ++next.current;
    setToasts(list => [...list.slice(-2), {id, text, bad}]);
    setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4"
        role="status"
      >
        {toasts.map(toast => (
          <p
            key={toast.id}
            className={cn(
              'rounded-lg px-3 py-2 text-[13px] shadow-lg',
              toast.bad ? 'bg-bad text-on-accent' : 'bg-fg text-bg',
            )}
          >
            {toast.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
