/**
 * A setup window: numbered steps to connect something from outside the dashboard, such as a storage key or a
 * machine, and a status line at the bottom that says what Nocheh is waiting for.
 */
import * as React from 'react';
import {Check, Copy} from 'lucide-react';
import {cn} from '../lib/utils';
import {Button, Dot, type Tone} from './core';
import {Dialog, useFeedback} from './overlay';

export type SetupStatus = {tone: Tone; text: string};

/** What a setup window says while it waits for the owner, works, or stopped. */
export function setupStatus({
  busy,
  problem,
  waiting,
}: {
  busy?: string | false | null;
  problem?: unknown;
  waiting: string;
}): SetupStatus {
  if (busy) return {tone: 'info', text: busy};
  if (problem) return {tone: 'bad', text: 'Stopped. See the message above.'};
  return {tone: waiting.endsWith('…') ? 'neutral' : 'accent', text: waiting};
}

export function SetupWindow({
  open,
  onOpenChange,
  title,
  description,
  status,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  status: SetupStatus;
  /** True while a call runs that goes on after the window closes. */
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <div className="mr-auto flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1">
          <p role="status" className="flex items-center gap-2 text-[13px] text-fg">
            <Dot tone={status.tone} className={cn(busy && 'animate-pulse')} />
            {status.text}
          </p>
          {busy && <p className="text-[12px] text-muted">Closing this window won’t stop it.</p>}
        </div>
      }
    >
      <ol className="grid gap-5">{children}</ol>
    </Dialog>
  );
}

/** One numbered step, joined to the next by a line. A done step shows a tick instead of its number. */
export function SetupStep({
  number,
  title,
  done,
  last,
  children,
}: {
  number: number;
  title: string;
  done?: boolean;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
            done ? 'border-good/25 bg-good-soft text-good' : 'border-line',
          )}
        >
          {done ? <Check aria-label="Done" className="size-3.5" /> : number}
        </span>
        {!last && <span aria-hidden className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className="grid min-w-0 gap-2.5 pb-1">
        <p className="pt-0.5 text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Muted words under a step's title. */
export function SetupText({children}: {children: React.ReactNode}) {
  return <p className="text-[13px] text-muted">{children}</p>;
}

/** A link or address to copy, cut to one line, with a copy button. */
export function CopyLine({value, label, children}: {value: string; label: string; children?: React.ReactNode}) {
  const feedback = useFeedback();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      feedback.toast(label + ' copied.');
    } catch {
      feedback.toast('This browser didn’t allow copying. Select the text instead.', 'bad');
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-subtle py-1.5 pr-1.5 pl-3">
      <span className="min-w-0 flex-1 truncate font-mono text-xs select-all" title={value}>
        {children ?? value}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label={'Copy ' + label.toLowerCase()} onClick={() => void copy()}>
        <Copy aria-hidden />
      </Button>
    </div>
  );
}
