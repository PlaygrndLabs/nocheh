/** Nocheh noticed a name: remember it as a person or project, or link an account to someone known. */
import {useId, useState} from 'react';
import {Badge, Button, Field, Input, Technical} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {EvidenceLinks, ReviewDrawer, type ReviewState} from './review-drawer';
import {stateLabel, useCommand} from './shared';

type Suggestion = {
  id: string;
  kind: 'person' | 'project' | 'binding' | string;
  name: string;
  reason?: string;
  candidate_entity_id?: string | null;
  source_reference?: {id: string} | null;
  status?: string;
  revision: number;
};

const ENTITY_ID = /^[a-f0-9]{64}$/;

export function identityTitle(kind: string | undefined, name: string) {
  if (kind === 'project') return `Remember the project “${name}”?`;
  if (kind === 'binding') return `Is this account ${name}?`;
  return `Remember “${name}”?`;
}

export function IdentityReview({
  suggestion,
  review,
  onClose,
}: {
  suggestion: Suggestion;
  review: ReviewState;
  onClose: () => void;
}) {
  const {toast} = useFeedback();
  const command = useCommand();
  const id = useId();
  const [target, setTarget] = useState(suggestion.candidate_entity_id ?? '');
  const pending = (suggestion.status ?? 'pending') === 'pending';
  const binding = suggestion.kind === 'binding';
  const locked = !!(review.changed || review.unavailable) || !!command.busy;
  const targetError =
    binding && target && !ENTITY_ID.test(target.trim()) ? 'A person ID is 64 letters and digits.' : '';
  const [label, tone] = stateLabel(suggestion.status ?? 'pending');

  const decide = async (decision: 'confirm' | 'reject') => {
    const body: Record<string, unknown> = {decision, expected_revision: suggestion.revision};
    if (decision === 'confirm' && target.trim()) body.entity_id = target.trim();
    const done = await command.run('/entities/' + encodeURIComponent(suggestion.id) + '/decide', body, decision);
    if (!done) return;
    toast(decision === 'reject' ? 'Dismissed.' : binding ? 'Linked.' : `Nocheh will remember “${suggestion.name}”.`);
    onClose();
  };

  const explanation =
    suggestion.kind === 'project'
      ? 'Nocheh noticed what looks like a project. Confirm to keep track of it under Memory.'
      : binding
        ? 'Nocheh thinks this Telegram account belongs to a person you already know.'
        : 'Nocheh noticed someone new. Confirm to remember them as a person under Memory.';

  return (
    <ReviewDrawer
      title={identityTitle(suggestion.kind, suggestion.name)}
      onClose={onClose}
      review={review}
      error={command.error}
      footer={
        pending ? (
          <>
            <Button
              variant="primary"
              busy={command.busy === 'confirm'}
              disabled={locked || review.stale || (binding && (!target.trim() || !!targetError))}
              onClick={() => void decide('confirm')}
            >
              {binding ? 'Link' : 'Remember'}
            </Button>
            <Button busy={command.busy === 'reject'} disabled={locked} onClick={() => void decide('reject')}>
              Dismiss
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
      <p className="text-sm">{explanation}</p>
      {suggestion.reason && (
        <blockquote dir="auto" className="border-l-2 border-line-strong pl-3 text-sm text-fg/80">
          {suggestion.reason}
        </blockquote>
      )}
      {binding && pending && (
        <Field
          label="Person to link to"
          htmlFor={id + '-target'}
          error={targetError}
          hint="Nocheh filled in its best guess. Change it only if you know the person’s ID."
        >
          <Input
            id={id + '-target'}
            value={target}
            spellCheck={false}
            className="font-mono text-xs"
            disabled={!!command.busy}
            onChange={event => setTarget(event.target.value)}
          />
        </Field>
      )}
      <EvidenceLinks ids={[suggestion.source_reference?.id]} />
      <Technical value={suggestion} />
    </ReviewDrawer>
  );
}
