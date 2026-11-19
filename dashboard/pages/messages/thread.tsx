/**
 * A message's Thread and Learned into memory sections (ADR-0261 step 4): what it replies to, its topic, where a forward
 * came from and the messages replying to it; and the facts long-term memory learned from it. Every message is named in
 * your own words by storage; a retired one is never linked. The thread is read when the panel opens and again when
 * Messages' live updates tick. What was learned is asked of long-term memory itself, so it is read only when the panel
 * opens and when you check again: never on a live update or a timer.
 */
import {useState} from 'react';
import {refreshResources, useResource} from '../../lib/resource';
import {factsReasonText, threadRows, type LearnedFromMessage, type MessageThread} from '../../lib/memory-sources';
import {FactItem, OriginalItem, OriginalList} from '../../lib/originals';
import {Button, LoadError, Skeleton} from '../../ui/core';

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
            {row.kind === 'reply_to' && <OriginalItem original={row.original} linkText="The message it replies to" />}
            {(row.kind === 'reply_elsewhere' || row.kind === 'reply_private' || row.kind === 'forward') && (
              <span dir="auto">{row.text}</span>
            )}
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
              <OriginalList originals={row.items} more={row.more} label="Replies to this message" item="Reply" />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LearnedSection({id}: {id: string}) {
  const [asked, setAsked] = useState(0);
  const learned = useResource<LearnedFromMessage>('/memory/message-facts?id=' + id, 0, asked);
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
  const again = (
    <Button size="sm" variant="ghost" busy={learned.loading} onClick={() => setAsked(value => value + 1)}>
      Check again
    </Button>
  );
  if (!facts.length)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] text-muted">{factsReasonText(reason, 'message')}</p>
        {again}
      </div>
    );
  return (
    <>
      <ul className="space-y-2" aria-label="Facts learned from this message">
        {facts.map(fact => (
          <FactItem key={fact.id} fact={fact} current={id} />
        ))}
      </ul>
      {more && <p className="mt-2 text-xs text-muted">Only the first page is shown.</p>}
      <div className="mt-2">{again}</div>
    </>
  );
}
