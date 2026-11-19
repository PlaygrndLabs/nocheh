/**
 * Original messages as the dashboard links them (ADR-0261 step 4): a link that opens the message, with a short label in
 * your own words and when it was sent. A retired message is never linked; it reads "Hidden from assistant". A message whose
 * label can't be made now has no link either, only its reason.
 */
import {createContext, useContext, useMemo, type ReactNode} from 'react';
import {useResource} from './resource';
import {href} from './routes';
import {cn} from './utils';
import {
  ORIGINAL_LOOKUPS,
  originalLookups,
  originalsById,
  originalView,
  factBadge,
  type Fact,
  type Original,
  type Originals,
} from './memory-sources';
import {Badge} from '../ui/core';

/** A short date such as "12 Oct 2026, 14:05". */
export function sentAt(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * The names of these originals, asked once for a whole page or drawer (at most 200, in lookups of 50). Until the
 * answer comes, or when it can't come, the map is empty and links show without labels.
 */
export function useOriginals(ids: readonly (string | null | undefined)[]): Map<string, Original> {
  const key = ids.join(',');
  const paths = useMemo(() => originalLookups(key ? key.split(',') : []), [key]);
  // The same lookups every time (ORIGINAL_LOOKUPS of them); an unused one asks nothing.
  const first = useResource<Originals>(paths[0] ?? null, 60000).data;
  const second = useResource<Originals>(paths[1] ?? null, 60000).data;
  const third = useResource<Originals>(paths[2] ?? null, 60000).data;
  const fourth = useResource<Originals>(paths[3] ?? null, 60000).data;
  return useMemo(
    () => originalsById(paths, [first, second, third, fourth].slice(0, ORIGINAL_LOOKUPS)),
    [paths, first, second, third, fourth],
  );
}

const Named = createContext<Map<string, Original> | null>(null);
/** Names every original under it with one lookup, so each list below doesn't ask on its own. */
export function OriginalNames({ids, children}: {ids: readonly (string | null | undefined)[]; children: ReactNode}) {
  return <Named.Provider value={useOriginals(ids)}>{children}</Named.Provider>;
}
/** The names of these originals: from an OriginalNames above, or asked here. */
export function useNamedOriginals(ids: readonly (string | null | undefined)[]): Map<string, Original> {
  const above = useContext(Named);
  const own = useOriginals(above ? [] : ids);
  return above ?? own;
}

/** One original: a link with its label and time, "Hidden from assistant", or why it can't be opened. */
export function OriginalItem({
  original,
  linkText = 'Original message',
  current,
  short,
}: {
  original: Original;
  linkText?: string;
  /** The message open now, shown as "This message" rather than a link to itself. */
  current?: string;
  /** Without its label, where the label is said already. */
  short?: boolean;
}) {
  const view = originalView(original);
  if ('text' in view)
    return <span className="text-muted">{'unavailable' in view ? view.text : linkText + ' · ' + view.text}</span>;
  if (view.link === current) return <span className="font-medium">This message</span>;
  const when = sentAt(view.at);
  return (
    <span>
      <a className="text-accent-text hover:underline" href={href('messages', {source: view.link})}>
        {linkText}
      </a>
      {!short && (
        <span dir="auto" className="text-muted">
          {' · ' + view.label + (when ? ' · ' + when : '')}
        </span>
      )}
    </span>
  );
}

/** A list of originals, numbered when there are several, and how many more there are. `item` is what each link
 *  says (“Original message”, or “Reply” for the messages replying to one). */
export function OriginalList({
  originals,
  more = 0,
  current,
  short,
  className,
  label,
  item = 'Original message',
}: {
  originals: Original[];
  more?: number;
  current?: string;
  short?: boolean;
  className?: string;
  label?: string;
  item?: string;
}) {
  if (!originals.length && !more) return <p className={cn('text-[13px] text-muted', className)}>No linked messages.</p>;
  return (
    <ul aria-label={label} className={cn('space-y-0.5 text-[13px]', short && 'flex flex-wrap gap-x-4', className)}>
      {originals.map((original, index) => (
        <li key={index} className="break-words">
          <OriginalItem
            original={original}
            current={current}
            short={short}
            linkText={item + (originals.length + more > 1 ? ' ' + (index + 1) : '')}
          />
        </li>
      ))}
      {more > 0 && <li className="text-muted">and {more.toLocaleString()} more</li>}
    </ul>
  );
}

/** One fact long-term memory learned: its words, its source badge, when it was learned and its originals. */
export function FactItem({fact, current}: {fact: Fact; current?: string}) {
  const badge = factBadge(fact);
  const learned = sentAt(fact.learned_at);
  return (
    <li className="space-y-1.5 rounded-lg border border-line px-3.5 py-3">
      <p dir="auto" className="text-sm break-words">
        {fact.text}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {badge && (
          <Badge tone={badge.tone} dot>
            {badge.label}
          </Badge>
        )}
        {learned && <span>Learned {learned}</span>}
      </div>
      <OriginalList originals={fact.originals} more={fact.more} current={current} label="Where it came from" />
    </li>
  );
}
