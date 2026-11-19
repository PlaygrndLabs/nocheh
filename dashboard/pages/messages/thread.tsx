/**
 * A message's Thread and Learned into memory sections (ADR-0261 step 4): what it replies to, its topic, where a forward
 * came from and the messages replying to it; and the facts long-term memory learned from it. Every message is named in
 * your own words by storage; a retired one is never linked. Each is read when the panel opens and again when Messages'
 * live updates tick, not on a timer: what was learned is asked of long-term memory itself.
 */
import {refreshResources, useResource} from '../../lib/resource';
import {factsReasonText, threadRows, type LearnedFromMessage, type MessageThread} from '../../lib/memory-sources';
import {FactItem, OriginalItem, OriginalList} from '../../lib/originals';
import {LoadError, Skeleton} from '../../ui/core';

export function ThreadSection({id}: {id: string}) {
  const thread = useResource<MessageThread>('/events/' + id + '/thread');
  if (thread.error && !thread.data)
    return <LoadError what="this message’s thread" error={thread.error} onRetry={() => void refreshResources()} />;
  if (!thread.data) return <Skeleton className="h-12 w-full" />;
  const rows = threadRows(thread.data);
  if (!rows.length) return <p className="text-[13px] text-muted">It isn’t a reply, and nothing replies to it yet.</p>;
  return (
    <dl className="space-y-2.5 text-[13px]">
      {rows.map(row => (
        <div key={row.kind}>
          <dt className="text-xs font-medium text-muted">{row.heading}</dt>
          <dd className="mt-0.5 break-words">
            {row.kind === 'reply_to' && <OriginalItem original={row.original} />}
            {(row.kind === 'reply_elsewhere' || row.kind === 'forward') && <span dir="auto">{row.text}</span>}
            {row.kind === 'topic' && (
              <>
                <span dir="auto">{row.label}</span>
                {row.opens && <span className="text-muted"> · this message opens the topic</span>}
                {row.opening && (
                  <span className="mt-0.5 block">
                    <OriginalItem original={row.opening} linkText="The topic’s first message" />
                  </span>
                )}
              </>
            )}
            {row.kind === 'replies' && (
              <OriginalList originals={row.items} more={row.more} label="Replies to this message" />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LearnedSection({id}: {id: string}) {
  const learned = useResource<LearnedFromMessage>('/events/' + id + '/learned');
  if (learned.error && !learned.data)
    return (
      <LoadError
        what="what was learned from this message"
        error={learned.error}
        onRetry={() => void refreshResources()}
      />
    );
  if (!learned.data) return <Skeleton className="h-12 w-full" />;
  const {facts, reason, more} = learned.data;
  if (!facts.length) return <p className="text-[13px] text-muted">{factsReasonText(reason, 'message')}</p>;
  return (
    <>
      <ul className="space-y-2" aria-label="Facts learned from this message">
        {facts.map(fact => (
          <FactItem key={fact.id} fact={fact} current={id} />
        ))}
      </ul>
      {more && <p className="mt-2 text-xs text-muted">Only the first page is shown.</p>}
    </>
  );
}
