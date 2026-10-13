/** Dialogs, side panels, confirmations and toasts. */
import * as React from 'react';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {CheckCircle2, X, XCircle} from 'lucide-react';
import {cn} from '../lib/utils';
import {Button} from './core';

/** A centred window for a short task, such as adding a provider. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,760px)] w-[calc(100vw-24px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-surface shadow-xl focus:outline-none',
            className,
          )}
          {...(description ? {} : {'aria-describedby': undefined})}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-[13px] text-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A panel that slides in from the right to show one item without leaving the list. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-xl focus:outline-none',
            wide ? 'max-w-3xl' : 'max-w-xl',
          )}
          {...(description ? {} : {'aria-describedby': undefined})}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold break-words">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-[13px] text-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type ConfirmOptions = {title: string; body?: React.ReactNode; confirm?: string; danger?: boolean};
type Toast = {id: number; text: string; tone: 'good' | 'bad'};
type Feedback = {
  toast: (text: string, tone?: 'good' | 'bad') => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};
const FeedbackContext = React.createContext<Feedback>({toast: () => {}, confirm: async () => false});

/** Toasts and confirmation dialogs for the whole app. */
export function FeedbackProvider({children}: {children: React.ReactNode}) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [pending, setPending] = React.useState<(ConfirmOptions & {resolve: (ok: boolean) => void}) | null>(null);
  const counter = React.useRef(0);
  const value = React.useMemo<Feedback>(
    () => ({
      toast: (text, tone = 'good') => {
        const id = ++counter.current;
        setToasts(current => [...current.slice(-2), {id, text, tone}]);
        setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), tone === 'bad' ? 8000 : 4000);
      },
      confirm: options => new Promise<boolean>(resolve => setPending({...options, resolve})),
    }),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <Dialog
        open={!!pending}
        onOpenChange={open => !open && close(false)}
        title={pending?.title ?? ''}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {pending?.confirm ?? 'Continue'}
            </Button>
          </>
        }
      >
        {pending?.body && <div className="text-sm text-fg/80">{pending.body}</div>}
      </Dialog>
      <div
        aria-live="polite"
        className="pointer-events-none fixed top-4 right-4 left-4 z-[60] flex flex-col items-end gap-2 sm:left-auto"
      >
        {toasts.map(toast => (
          <div
            key={toast.id}
            role={toast.tone === 'bad' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-lg"
          >
            {toast.tone === 'bad' ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />
            )}
            <span className="min-w-0 flex-1">{toast.text}</span>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export const useFeedback = () => React.useContext(FeedbackContext);
