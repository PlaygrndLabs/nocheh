/** Page frame: title, optional actions and tabs, then the content. */
import * as React from 'react';
import {cn} from '../lib/utils';
import {SaveControls, useSaveState} from './save-bar';

export function Page({
  title,
  description,
  actions,
  tabs,
  saveable,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  /** The page edits settings: Save and Discard always show at the top, turned off until there is something to save. */
  saveable?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    if (typeof title === 'string') document.title = title + ' · Nocheh';
  }, [title]);
  const save = useSaveState();
  // Pages with settings keep the header pinned all the time so nothing moves when an edit starts.
  const pinned = saveable || save.visible;
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-8', className)}>
      <header
        className={cn(
          'flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-6 pb-5 sm:pt-8',
          pinned && 'sticky top-0 z-20 -mx-4 border-b border-line bg-bg px-4 pt-4 pb-3 sm:-mx-8 sm:px-8 sm:pt-4',
        )}
      >
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {description && !pinned && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          <SaveControls state={save} persistent={saveable} />
        </div>
        {save.visible && save.failed && save.detail && (
          <p role="alert" className="w-full text-[13px] text-bad">
            {save.detail}
          </p>
        )}
      </header>
      {pinned && description && <p className="-mt-1 mb-5 text-sm text-muted">{description}</p>}
      {tabs && <div className="mb-5">{tabs}</div>}
      <div className="space-y-5 pb-10">{children}</div>
    </div>
  );
}

export type TabItem<T extends string> = {id: T; label: React.ReactNode; count?: number | null};

/** Tabs along the top of a page; the choice is part of the address. Scrolls sideways on phones. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === tab.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {tab.label}
          {!!tab.count && (
            <span className="tabular rounded-full bg-accent px-1.5 text-[11px] leading-5 font-semibold text-on-accent">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
