/** Nocheh noticed a name: remember it as a person or project, or link an account to someone known. */
import {useId, useState} from 'react';
import {useResource} from '../../lib/resource';
import {decisionLink} from '../../lib/supervision';
import {Badge, Button, Details, Field, Input, Notice, Select, Technical} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {EvidenceLinks, ReviewDrawer, type ReviewState} from './review-drawer';
import {stateLabel, useCommand} from './shared';

/** Another name for the same person or project, waiting on this card. */
type FoldedName = {id: string; name: string; reason?: string; revision: number; source_reference?: {id: string} | null};
type Suggestion = {
  id: string;
  kind: 'person' | 'project' | 'binding' | string;
  name: string;
  reason?: string;
  candidate_entity_id?: string | null;
  source_reference?: {id: string} | null;
  status?: string;
  revision: number;
  /** Set when this name was folded into another card; that card answers for it. */
  merged_into?: string | null;
  also_called?: FoldedName[];
};
type Known = {id: string; name: string; kind: string};

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
  const folded = pending && !!suggestion.merged_into;
  const also = suggestion.also_called ?? [];
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
  /** Take a folded name back out, so it waits as its own card. */
  const split = async (name: {id: string; name: string; revision: number}) => {
    const done = await command.run(
      '/entities/' + encodeURIComponent(name.id) + '/split',
      {expected_revision: name.revision},
      'split:' + name.id,
    );
    if (!done) return;
    toast(`“${name.name}” waits as its own card again.`);
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
        pending && !folded ? (
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
      {folded && (
        <Notice
          tone="info"
          title="This name waits on another card"
          action={
            <Button
              size="sm"
              busy={command.busy === 'split:' + suggestion.id}
              disabled={locked}
              onClick={() => void split(suggestion)}
            >
              Not the same
            </Button>
          }
        >
          Nocheh thinks it is the same {suggestion.kind === 'project' ? 'project' : 'person'}.{' '}
          <a className="text-accent-text hover:underline" href={decisionLink('entity', suggestion.merged_into!)}>
            Open that card
          </a>{' '}
          to answer for every name at once.
        </Notice>
      )}
      <p className="text-sm">{explanation}</p>
      {suggestion.reason && (
        <blockquote dir="auto" className="border-l-2 border-line-strong pl-3 text-sm text-fg/80">
          {suggestion.reason}
        </blockquote>
      )}
      {pending && also.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-muted">Also called</h3>
          <p className="mt-0.5 text-xs text-muted">Remember keeps every name below for this one {suggestion.kind}.</p>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line" aria-label="Also called">
            {also.map(name => (
              <li key={name.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span dir="auto" className="min-w-0 text-sm break-words">
                  {name.name}
                </span>
                <Button
                  size="sm"
                  busy={command.busy === 'split:' + name.id}
                  disabled={locked}
                  onClick={() => void split(name)}
                >
                  Not the same
                </Button>
              </li>
            ))}
          </ul>
        </div>
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
      {pending && !folded && !binding && (
        <SameAs suggestion={suggestion} locked={locked || !!review.stale} onClose={onClose} />
      )}
      <EvidenceLinks ids={[suggestion.source_reference?.id, ...also.map(name => name.source_reference?.id)]} />
      <Technical value={suggestion} />
    </ReviewDrawer>
  );
}

/** Says this card is the same person or project as another waiting card, or as one Nocheh already knows. */
function SameAs({suggestion, locked, onClose}: {suggestion: Suggestion; locked: boolean; onClose: () => void}) {
  const {toast} = useFeedback();
  const command = useCommand();
  const id = useId();
  const [choice, setChoice] = useState('');
  const kind = suggestion.kind === 'project' ? 'project' : 'person';
  const cards = useResource<{suggestions: Suggestion[]}>('/entities/suggestions?after=', 30000);
  const known = useResource<{entities: Known[]}>(
    '/entities?' + new URLSearchParams({kind, q: '', after: '', state: 'active'}),
    60000,
  );
  const waiting = (cards.data?.suggestions ?? []).filter(card => card.id !== suggestion.id && card.kind === kind);
  const remembered = known.data?.entities ?? [];
  if (!waiting.length && !remembered.length) return null;
  const [type, targetId] = choice.split(':') as ['card' | 'entity' | '', string | undefined];
  const chosen =
    type === 'card'
      ? waiting.find(card => card.id === targetId)?.name
      : remembered.find(entity => entity.id === targetId)?.name;

  const apply = async () => {
    if (!targetId || !chosen) return;
    const done =
      type === 'card'
        ? await command.run('/entities/' + encodeURIComponent(suggestion.id) + '/fold', {
            target_id: targetId,
            expected_revision: suggestion.revision,
          })
        : await command.run('/entities/' + encodeURIComponent(suggestion.id) + '/decide', {
            decision: 'confirm',
            entity_id: targetId,
            expected_revision: suggestion.revision,
          });
    if (!done) return;
    toast(
      type === 'card'
        ? `“${suggestion.name}” now waits on “${chosen}”.`
        : `Nocheh will remember “${suggestion.name}” as ${chosen}.`,
    );
    onClose();
  };

  return (
    <Details summary="Same as…">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          Is this the same {kind} as another name? Pick it. A waiting card then answers for both names, and a {kind}{' '}
          Nocheh knows gets this name too.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Same as" htmlFor={id + '-same'} className="min-w-48 flex-1">
            <Select id={id + '-same'} value={choice} onChange={event => setChoice(event.target.value)}>
              <option value="">Choose…</option>
              {waiting.length > 0 && (
                <optgroup label="Waiting for you">
                  {waiting.map(card => (
                    <option key={card.id} value={'card:' + card.id}>
                      {card.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {remembered.length > 0 && (
                <optgroup label={kind === 'project' ? 'Projects Nocheh knows' : 'People Nocheh knows'}>
                  {remembered.map(entity => (
                    <option key={entity.id} value={'entity:' + entity.id}>
                      {entity.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Button busy={!!command.busy} disabled={locked || !chosen} onClick={() => void apply()}>
            {type === 'entity' ? 'Remember as this' : 'Move to that card'}
          </Button>
        </div>
        {command.error && <p className="text-xs text-bad">{command.error}</p>}
      </div>
    </Details>
  );
}
