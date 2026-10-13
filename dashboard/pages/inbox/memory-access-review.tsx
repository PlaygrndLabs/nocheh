/** A chat asked to use something from your memory: edit the wording, choose how long, approve or not. */
import {useId, useState} from 'react';
import {Badge, Button, Details, Field, Notice, Segmented, Technical, Textarea} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
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
  const pending = request.state === 'pending';
  const locked = !!(review.changed || review.unavailable) || !!command.busy;
  const where = chat(request.destination);
  const [label, tone] = stateLabel(request.state);

  const decide = async (decision: 'one_time' | 'persistent' | 'reject') => {
    const done = await command.run(
      '/memory-access/requests/' + encodeURIComponent(request.id) + '/decide',
      {decision, expected_revision: request.revision, ...(decision === 'reject' ? {} : {wording})},
      decision === 'reject' ? 'reject' : 'approve',
    );
    if (!done) return;
    toast(
      decision === 'reject'
        ? 'Not shared.'
        : decision === 'one_time'
          ? `Shared once with ${where}.`
          : `${where} can use this until you revoke it.`,
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
              {mode === 'one_time' ? 'Share once' : 'Share until I revoke it'}
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
                ? 'Used for one reply in this chat, then it ends.'
                : 'This chat can use it again until you revoke it under Chats.'}{' '}
              If this chat’s settings allow it, Nocheh posts its follow-up there right after you approve.
            </p>
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
