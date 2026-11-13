/** A chat asked to use something from your memory: see where it came from and who will see it, edit the wording,
 * choose how long, approve or not. */
import {useId, useState} from 'react';
import {Badge, Button, Details, Field, Notice, Segmented, Technical, Textarea} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {parentOf} from '../../lib/chats-model';
import {EvidenceLinks, Fact, Facts, ReviewDrawer, type ReviewState} from './review-drawer';
import {fromNow, fullTime, stateLabel, useChatNames, useCommand} from './shared';

type Request = {
  id: string;
  destination: string;
  state: string;
  revision: number;
  expires_at: string;
  created_at?: string;
  wording: string | null;
  relationship_path?: string[];
  evidence?: {id: string}[];
  provenance?: unknown;
  /** The chats the fact came from; null is a source Nocheh can no longer place. */
  source_spaces?: (string | null)[];
  /** Where Nocheh may reuse a lasting share: the destination, or every chat of its group when topics share memory. */
  audience?: {space: string; group: string | null};
  /** Whether "Until I revoke it" also posts the wording now, unless the owner changes it. */
  post_default?: boolean;
};

export function MemoryAccessReview({
  request,
  review,
  onClose,
}: {
  request: Request;
  review: ReviewState;
  onClose: () => void;
}) {
  const {toast} = useFeedback();
  const chat = useChatNames();
  const command = useCommand();
  const id = useId();
  const [wording, setWording] = useState(request.wording ?? '');
  const [mode, setMode] = useState<'one_time' | 'persistent'>('one_time');
  const [post, setPost] = useState(!!request.post_default);
  const pending = request.state === 'pending';
  const locked = !!(review.changed || review.unavailable) || !!command.busy;
  const where = chat(request.destination);
  // Every member of a group can read all of its topics, so whatever is posted or answered there is seen by the whole group.
  const readers = chat(parentOf(request.destination) ?? request.destination);
  const sources = request.source_spaces ?? [];
  const [label, tone] = stateLabel(request.state);

  const decide = async (decision: 'one_time' | 'persistent' | 'reject') => {
    const done = await command.run(
      '/memory-access/requests/' + encodeURIComponent(request.id) + '/decide',
      {
        decision,
        expected_revision: request.revision,
        ...(decision === 'reject' ? {} : {wording}),
        ...(decision === 'persistent' ? {post} : {}),
      },
      decision === 'reject' ? 'reject' : 'approve',
    );
    if (!done) return;
    toast(
      decision === 'reject'
        ? 'Not shared.'
        : decision === 'one_time'
          ? `Posted once in ${where}.`
          : `${where} can use this until you revoke it.` + (post ? ' Nocheh posts it there now.' : ''),
    );
    onClose();
  };

  return (
    <ReviewDrawer
      title={`Share a fact with ${where}?`}
      description={pending ? 'Only the wording below is shared. Where it came from stays private.' : undefined}
      onClose={onClose}
      review={review}
      error={command.error}
      footer={
        pending ? (
          <>
            <Button
              variant="primary"
              busy={command.busy === 'approve'}
              disabled={locked || review.stale || !wording.trim()}
              onClick={() => void decide(mode)}
            >
              {mode === 'one_time' ? `Post it once in ${where}` : 'Share until I revoke it'}
            </Button>
            <Button busy={command.busy === 'reject'} disabled={locked} onClick={() => void decide('reject')}>
              Don’t share
            </Button>
          </>
        ) : undefined
      }
    >
      {!pending && (
        <Badge tone={tone} dot>
          {label}
        </Badge>
      )}
      {review.stale && pending && (
        <Notice tone="warn" title="Can’t be shared in this form">
          The fact changed or the request ran out of time after it was suggested. You can still say no.
        </Notice>
      )}
      <Facts>
        <Fact label="Chat">{where}</Fact>
        <Fact label="Came from">
          {sources.length
            ? sources.map(space => (space ? chat(space) : 'A chat Nocheh can’t place')).join(', ')
            : 'Unknown'}
        </Fact>
        <Fact label="Who will see it">Everyone in {readers}</Fact>
        <Fact label="Answer needed">
          <span title={fullTime(request.expires_at)}>
            {new Date(request.expires_at).getTime() > Date.now() ? 'Ends ' + fromNow(request.expires_at) : 'Expired'}
          </span>
        </Fact>
      </Facts>
      {pending ? (
        <>
          <Field
            label="Wording the chat may see"
            htmlFor={id + '-wording'}
            hint="You can shorten or soften it before sharing."
            aside={`${wording.length} / 12000`}
          >
            <Textarea
              id={id + '-wording'}
              rows={5}
              dir="auto"
              maxLength={12000}
              value={wording}
              disabled={!!command.busy}
              onChange={event => setWording(event.target.value)}
            />
          </Field>
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium">How long</p>
            <Segmented
              label="How long"
              value={mode}
              onChange={setMode}
              disabled={!!command.busy}
              options={[
                {value: 'one_time', label: 'Just this once'},
                {value: 'persistent', label: 'Until I revoke it'},
              ]}
            />
            <p className="text-xs text-muted">
              {mode === 'one_time'
                ? 'Nocheh posts this exact wording there now.'
                : request.audience?.group
                  ? `Nocheh may use it when it answers in ${chat(request.audience.group)} and all its topics, until you revoke it under Chats.`
                  : `Nocheh may use it when it answers in ${where} only, until you revoke it under Chats.`}
            </p>
            {mode === 'persistent' && (
              <label className="flex cursor-pointer items-start gap-2.5 pt-1 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-accent"
                  checked={post}
                  disabled={!!command.busy}
                  onChange={event => setPost(event.target.checked)}
                />
                <span>Also post it in {where} now</span>
              </label>
            )}
          </div>
        </>
      ) : (
        <div dir="auto" className="rounded-lg border border-line bg-subtle px-3.5 py-3 text-sm whitespace-pre-wrap">
          {request.wording || 'The wording couldn’t be read.'}
        </div>
      )}
      <Details summary="Why Nocheh suggested this">
        <div className="space-y-3 text-sm">
          <p>
            {request.relationship_path?.length
              ? 'It is connected through ' + request.relationship_path.join(' → ') + '.'
              : 'It is connected through confirmed messages.'}
          </p>
          <EvidenceLinks ids={(request.evidence ?? []).map(item => item.id)} />
          <Technical value={request.provenance ?? null} summary="Where it came from (only you see this)" />
        </div>
      </Details>
    </ReviewDrawer>
  );
}
