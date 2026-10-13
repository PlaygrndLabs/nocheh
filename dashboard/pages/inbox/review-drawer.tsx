/** The side panel every Inbox item opens in, with the notices all reviews share. */
import * as React from 'react';
import {RefreshCw} from 'lucide-react';
import {Button, Notice} from '../../ui/core';
import {Drawer} from '../../ui/overlay';

export type ReviewState = {
  /** The item changed elsewhere after this panel opened. */
  changed?: boolean;
  /** Something it depends on changed, so it can no longer be approved. */
  stale?: boolean;
  /** The latest copy could not be loaded; what is shown may be out of date. */
  unavailable?: boolean;
  onReload?: () => void;
};

export function ReviewDrawer({
  title,
  description,
  footer,
  onClose,
  review = {},
  error,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  review?: ReviewState;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <Drawer open onOpenChange={open => !open && onClose()} title={title} description={description} footer={footer}>
      <div className="space-y-5">
        {review.changed && (
          <Notice
            tone="warn"
            title="This changed somewhere else"
            action={
              review.onReload && (
                <Button size="sm" onClick={review.onReload}>
                  <RefreshCw aria-hidden /> Reload
                </Button>
              )
            }
          >
            Reload to see the latest, your text is kept. Until then the buttons are off.
          </Notice>
        )}
        {review.unavailable && !review.changed && (
          <Notice tone="warn" title="Couldn’t check for changes">
            Nocheh didn’t answer just now, so this may be out of date. Deciding stays off until it answers.
          </Notice>
        )}
        {children}
        {error && (
          <Notice tone="bad" title="That didn’t work">
            {error}
          </Notice>
        )}
      </div>
    </Drawer>
  );
}

/** A labelled value in a review: "To", "Asked in", "Ends". */
export function Fact({label, children}: {label: React.ReactNode; children: React.ReactNode}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm break-words first-letter:uppercase">{children}</dd>
    </div>
  );
}

export function Facts({children}: {children: React.ReactNode}) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>;
}

/** The exact text or command being approved, shown as it will be used. */
export function Exact({label, children, mono}: {label: React.ReactNode; children: React.ReactNode; mono?: boolean}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      <div
        dir="auto"
        className={
          'max-h-80 overflow-auto rounded-lg border border-line bg-subtle px-3.5 py-3 text-sm break-words whitespace-pre-wrap' +
          (mono ? ' font-mono text-[13px]' : '')
        }
      >
        {children}
      </div>
    </div>
  );
}

/** Links to the original messages behind a suggestion. */
export function EvidenceLinks({ids}: {ids: (string | undefined | null)[]}) {
  const list = ids.filter((id): id is string => !!id);
  if (!list.length) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {list.map((id, index) => (
        <li key={id + index}>
          <a className="text-accent-text hover:underline" href={'#messages?source=' + encodeURIComponent(id)}>
            {list.length === 1 ? 'Open the original message' : `Original message ${index + 1}`}
          </a>
        </li>
      ))}
    </ul>
  );
}
