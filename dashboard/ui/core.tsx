/** Shared building blocks. Every page is made of these, so pages look and behave alike. */
import * as React from 'react';
import {Slot, Switch as SwitchPrimitive} from 'radix-ui';
import {cva, type VariantProps} from 'class-variance-authority';
import {AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, XCircle} from 'lucide-react';
import {cn} from '../lib/utils';

const buttonStyles = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'border border-line-strong bg-surface text-fg hover:bg-subtle',
        ghost: 'text-fg hover:bg-subtle',
        danger: 'border border-bad/40 bg-surface text-bad hover:bg-bad-soft',
        link: 'h-auto px-0 text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        md: 'h-9 px-3.5 text-sm',
        sm: 'h-8 px-2.5 text-[13px]',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    compoundVariants: [{variant: 'link', className: 'h-auto px-0'}],
    defaultVariants: {variant: 'secondary', size: 'md'},
  },
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonStyles> & {asChild?: boolean; busy?: boolean};

export function Button({className, variant, size, asChild, busy, type = 'button', children, ...props}: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      type={asChild ? undefined : type}
      className={cn(buttonStyles({variant, size}), className)}
      {...(busy ? {'aria-busy': true, disabled: true} : {})}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {children}
        </>
      )}
    </Component>
  );
}

export function Card({className, ...props}: React.ComponentProps<'section'>) {
  return <section className={cn('rounded-xl border border-line bg-surface shadow-card', className)} {...props} />;
}

/** A card's title row. `action` sits on the right on wide screens and wraps below on phones. */
export function CardHeader({
  title,
  description,
  action,
  className,
  id,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pt-4', className)}>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({className, ...props}: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';
const toneStyles: Record<Tone, string> = {
  neutral: 'bg-subtle text-muted border-line',
  good: 'bg-good-soft text-good border-good/25',
  warn: 'bg-warn-soft text-warn border-warn/30',
  bad: 'bg-bad-soft text-bad border-bad/25',
  info: 'bg-info-soft text-info border-info/25',
  accent: 'bg-accent-soft text-accent-text border-accent/25',
};
const dotStyles: Record<Tone, string> = {
  neutral: 'bg-muted',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  info: 'bg-info',
  accent: 'bg-accent',
};

export function Badge({
  tone = 'neutral',
  dot,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & {tone?: Tone; dot?: boolean}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 truncate rounded-full border px-2 py-0.5 text-xs font-medium',
        toneStyles[tone],
        className,
      )}
      {...props}
    >
      {dot && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dotStyles[tone])} />}
      {children}
    </span>
  );
}

export function Dot({tone = 'neutral', className}: {tone?: Tone; className?: string}) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', dotStyles[tone], className)} />;
}

const noticeIcons = {info: Info, good: CheckCircle2, warn: AlertTriangle, bad: XCircle};
/** An inline message inside a page: what happened and, when useful, what to do. */
export function Notice({
  tone = 'info',
  title,
  action,
  className,
  children,
}: {
  tone?: 'info' | 'good' | 'warn' | 'bad';
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const Icon = noticeIcons[tone];
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3 text-sm',
        toneStyles[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-fg">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-[13px] text-fg/80')}>{children}</div>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({className}: {className?: string}) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-subtle', className)} />;
}

/** Placeholder rows while a list loads. */
export function LoadingRows({rows = 3}: {rows?: number}) {
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({length: rows}, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function Empty({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ComponentType<{className?: string}>;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      {Icon && <Icon className="mb-3 size-8 text-muted/60" />}
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 max-w-md text-[13px] text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A request that failed: says so plainly and offers a retry. Never shown as "nothing here". */
export function LoadError({what, onRetry, className}: {what: string; onRetry?: () => void; className?: string}) {
  return (
    <Notice
      tone="warn"
      className={className}
      title={`Couldn’t load ${what}`}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        )
      }
    >
      The service may be restarting. Values shown may be out of date.
    </Notice>
  );
}

/** Label, control and help text for one form field. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  aside,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </label>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-bad" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}

const controlStyles =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';

export function Input({className, ...props}: React.ComponentProps<'input'>) {
  return <input className={cn(controlStyles, 'h-9', className)} {...props} />;
}

export function Textarea({className, ...props}: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(controlStyles, 'min-h-20 py-2', className)} {...props} />;
}

export function Select({className, children, ...props}: React.ComponentProps<'select'>) {
  return (
    <select className={cn(controlStyles, 'h-9 pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

/** A small set of exclusive choices shown side by side. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  size = 'md',
}: {
  value: T;
  options: {value: T; label: React.ReactNode}[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 font-medium text-muted transition-colors disabled:opacity-50',
            size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px]',
            value === option.value ? 'bg-surface text-fg shadow-card' : 'hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One row of a settings card: what it is on the left, its control on the right. */
export function SettingRow({
  title,
  description,
  htmlFor,
  children,
  className,
  stack,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  stack?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-t border-line px-5 py-4 first:border-t-0',
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 sm:max-w-md">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {title}
        </label>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      <div className={cn('min-w-0', !stack && 'sm:w-72 sm:shrink-0')}>{children}</div>
    </div>
  );
}

/** A key number with a label. `tone` colours the value when it means something. */
export function Stat({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-[13px] text-muted">{label}</p>
      <p
        className={cn(
          'tabular mt-1 text-2xl font-semibold tracking-tight',
          tone === 'bad' && 'text-bad',
          tone === 'warn' && 'text-warn',
          tone === 'good' && 'text-good',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </>
  );
  const className = 'block rounded-xl border border-line bg-surface p-4 shadow-card';
  return href ? (
    <a href={href} className={cn(className, 'transition-colors hover:border-line-strong')}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** A plain responsive table. Wide tables scroll sideways inside their card on phones. */
export function Table({className, ...props}: React.ComponentProps<'table'>) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}
export function Th({className, ...props}: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'border-b border-line bg-subtle/60 px-4 py-2 text-xs font-medium whitespace-nowrap text-muted',
        className,
      )}
      {...props}
    />
  );
}
export function Td({className, ...props}: React.ComponentProps<'td'>) {
  return <td className={cn('border-b border-line px-4 py-2.5 align-top', className)} {...props} />;
}

/** Collapsible extra detail, closed by default. */
export function Details({
  summary,
  children,
  className,
  open,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details className={cn('group', className)} open={open}>
      <summary className="cursor-pointer list-none text-[13px] font-medium text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** Raw data for the curious, behind a disclosure. */
export function Technical({value, summary = 'Technical details'}: {value: unknown; summary?: string}) {
  return (
    <Details summary={summary}>
      <pre className="max-h-80 overflow-auto rounded-lg bg-subtle p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </Details>
  );
}

export function Spinner({className}: {className?: string}) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-hidden />;
}

/** Previous/next page controls; hidden when everything fits on one page. */
export function Pager({
  page,
  hasNext,
  onPage,
  summary,
}: {
  page: number;
  hasNext: boolean;
  onPage: (page: number) => void;
  summary?: React.ReactNode;
}) {
  if (page === 0 && !hasNext) return summary ? <p className="px-5 py-3 text-xs text-muted">{summary}</p> : null;
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <p className="text-xs text-muted">{summary}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
