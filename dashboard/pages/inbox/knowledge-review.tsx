/** A proposed change to how memory is organized: projects, names, corrections, sharing rules. */
import type {ReactNode} from 'react';
import {Badge, Button, Details, Notice, Technical} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {knowledgeDecisionControls} from '../../lib/supervision';
import {EvidenceLinks, Fact, Facts, ReviewDrawer, type ReviewState} from './review-drawer';
import {stateLabel, useChatNames, useCommand} from './shared';

export type Proposal = {
  id: string;
  kind: string;
  state: string;
  revision: number;
  created_at?: string;
  source_scope?: string;
  source_reference?: {id: string} | null;
  proposal?: any;
  result?: unknown;
  decision_history?: unknown[];
  error_code?: string | null;
  delegation_id?: string | null;
  delegation_revision?: number | null;
  affected_topics?: Record<string, string[]>;
};

const titles: Record<string, string> = {
  organization: 'Organize chats into projects',
  project_save: 'Save a project',
  project_assignment: 'Move a chat to a project',
  entity_rename: 'Rename someone',
  entity_correct: 'Correct something Nocheh knows',
  entity_merge: 'Treat two people as one',
  entity_unmerge: 'Separate two people',
  sharing_rule: 'Change a sharing rule',
  fact_grant: 'Let a chat use a fact',
  fact_revoke: 'Stop a chat using a fact',
};
const effects: Record<string, string> = {
  organization: 'Creates projects and moves chats into them. Nobody gains access to anything.',
  project_save: 'Saves this project’s name, description and status. Archiving keeps its history.',
  project_assignment: 'Changes which project this chat belongs to. Nothing is shared.',
  entity_rename: 'Changes the name Nocheh shows for them.',
  entity_correct: 'Replaces what Nocheh believes with your correction. The old version is kept in history.',
  entity_merge: 'Links these as the same person. Check the evidence first.',
  entity_unmerge: 'Undoes a link between two people. The earlier decision stays in history.',
  sharing_rule: 'Changes which chats share with which, and how.',
  fact_grant: 'Lets this chat use the wording below.',
  fact_revoke: 'Stops this chat using the fact from now on. Messages already sent stay sent.',
};
export const proposalTitle = (kind: string) => titles[kind] ?? 'Change how memory is organized';
export const proposalEffect = (kind: string) => effects[kind] ?? 'Applies the exact change shown.';

const fieldLabels: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  state: 'Status',
  space_id: 'Chat',
  project_id: 'Project',
  mode: 'Mode',
  content: 'Corrected text',
  attribution: 'Source',
  uncertainty: 'Certainty',
  retired: 'Forget this',
  sources: 'From chats',
  destination: 'To chat',
  instructions: 'Privacy instructions',
  enabled: 'Turned on',
  wording: 'Wording',
};
const chatFields = new Set(['space_id', 'destination', 'sources']);

export function KnowledgeReview({
  proposal,
  review,
  onClose,
}: {
  proposal: Proposal;
  review: ReviewState;
  onClose: () => void;
}) {
  const {toast, confirm} = useFeedback();
  const chat = useChatNames();
  const command = useCommand();
  const content = proposal.proposal ?? {};
  const kind = String(content.kind ?? proposal.kind);
  const controls = knowledgeDecisionControls(proposal.state, {
    unavailable: review.unavailable,
    changed: review.changed,
    busy: !!command.busy,
    stale: review.stale,
  });
  const [label, tone] = stateLabel(proposal.state);
  const path = '/knowledge/proposals/' + encodeURIComponent(proposal.id);

  const decide = async (decision: 'approve' | 'reject' | 'cancel', message: string) => {
    if (await command.run(path + '/decide', {decision, expected_revision: proposal.revision}, decision)) {
      toast(message);
      onClose();
    }
  };
  const undo = async () => {
    const ok = await confirm({
      title: 'Undo this organization?',
      body: 'Projects it created and chats it moved go back to how they were, unless you changed them since.',
      confirm: 'Undo',
      danger: true,
    });
    if (ok && (await command.run(path + '/undo', {expected_revision: proposal.revision}, 'undo'))) {
      toast('Undone.');
      onClose();
    }
  };

  const projectName = (assignment: any) =>
    assignment.project_id
      ? 'an existing project'
      : (content.creates?.find((c: any) => c.key === assignment.project_key)?.name ?? 'a new project');

  let footer: ReactNode;
  if (proposal.state === 'review')
    footer = (
      <>
        <Button
          variant="primary"
          busy={command.busy === 'approve'}
          disabled={!controls.approve}
          onClick={() => void decide('approve', 'Approved. It applies in a moment.')}
        >
          Approve
        </Button>
        <Button
          busy={command.busy === 'reject'}
          disabled={!controls.reject}
          onClick={() => void decide('reject', 'Rejected.')}
        >
          Reject
        </Button>
      </>
    );
  else if (['queued', 'waiting'].includes(proposal.state))
    footer = (
      <Button
        busy={command.busy === 'cancel'}
        disabled={!controls.cancel}
        onClick={() => void decide('cancel', 'Cancelled.')}
      >
        Cancel this change
      </Button>
    );
  else if (['stale', 'failed'].includes(proposal.state))
    footer = (
      <Button
        busy={command.busy === 'cancel'}
        disabled={!controls.cancel}
        onClick={() => void decide('cancel', 'Dismissed.')}
      >
        Dismiss
      </Button>
    );
  else if (proposal.state === 'applied' && kind === 'organization')
    footer = (
      <Button variant="danger" busy={command.busy === 'undo'} disabled={!controls.undo} onClick={() => void undo()}>
        Undo
      </Button>
    );

  const topics = Object.entries(proposal.affected_topics ?? {}).filter(([, list]) => list.length > 0);

  return (
    <ReviewDrawer
      title={proposalTitle(kind) + (proposal.state === 'review' ? '?' : '')}
      description={proposalEffect(kind)}
      onClose={onClose}
      review={review}
      error={command.error}
      footer={footer}
    >
      <Badge tone={tone} dot>
        {label}
      </Badge>
      {proposal.state === 'stale' && (
        <Notice tone="warn" title="Can’t be applied">
          Something changed after this was prepared. Dismiss it; Nocheh will suggest a fresh one if still needed.
        </Notice>
      )}
      {proposal.state === 'failed' && (
        <Notice tone="bad" title="Applying it failed">
          {proposal.error_code
            ? 'Reason: ' + proposal.error_code.replaceAll('_', ' ') + '.'
            : 'No reason was recorded.'}
        </Notice>
      )}
      {['queued', 'waiting'].includes(proposal.state) && (
        <p className="text-[13px] text-muted">
          You approved this. It applies when Nocheh is not in the middle of a reply.
        </p>
      )}
      {review.stale && proposal.state === 'review' && (
        <Notice tone="warn" title="Can’t be approved any more">
          Something it depends on changed. You can still reject it.
        </Notice>
      )}
      {content.reason && (
        <blockquote dir="auto" className="border-l-2 border-line-strong pl-3 text-sm text-fg/80">
          {content.reason}
        </blockquote>
      )}

      {kind === 'organization' ? (
        <div className="space-y-4">
          {!!content.creates?.length && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">New projects</h3>
              <ul className="space-y-2">
                {content.creates.map((create: any) => (
                  <li key={create.key} className="rounded-lg border border-line p-3">
                    <p className="text-sm font-medium">{create.name}</p>
                    {create.description && <p className="mt-0.5 text-[13px] text-muted">{create.description}</p>}
                    <div className="mt-2">
                      <EvidenceLinks ids={create.evidence_ids ?? []} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!content.assignments?.length && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Chats to move</h3>
              <ul className="space-y-2">
                {content.assignments.map((assignment: any) => (
                  <li key={assignment.space_id} className="rounded-lg border border-line p-3">
                    <p className="text-sm">
                      <span className="font-medium">{chat(assignment.space_id)}</span> → {projectName(assignment)}
                    </p>
                    {assignment.reason && <p className="mt-0.5 text-[13px] text-muted">{assignment.reason}</p>}
                    <div className="mt-2">
                      <EvidenceLinks ids={assignment.evidence_ids ?? []} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <Facts>
          {Object.entries(content.payload ?? {})
            .filter(([key]) => fieldLabels[key])
            .map(([key, value]) => (
              <Fact key={key} label={fieldLabels[key]}>
                <span dir="auto" className="whitespace-pre-wrap">
                  {chatFields.has(key)
                    ? (Array.isArray(value) ? value : [value]).map(v => chat(String(v))).join(', ')
                    : Array.isArray(value)
                      ? value.join(', ')
                      : typeof value === 'boolean'
                        ? value
                          ? 'Yes'
                          : 'No'
                        : String(value ?? 'None')}
                </span>
              </Fact>
            ))}
        </Facts>
      )}

      {topics.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Topics that follow their group</h3>
          <p className="mb-2 text-[13px] text-muted">These topics move with their group too.</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {topics
              .flatMap(([, list]) => list)
              .map(topic => (
                <li key={topic}>{chat(topic)}</li>
              ))}
          </ul>
        </section>
      )}

      <Details summary="Where this came from">
        <div className="space-y-3 text-sm">
          {proposal.source_scope && (
            <Facts>
              <Fact label="Suggested in">{chat(proposal.source_scope)}</Fact>
              {proposal.delegation_id && (
                <Fact label="Allowed by">Your standing permission to organize (checked again before applying)</Fact>
              )}
            </Facts>
          )}
          <EvidenceLinks ids={[proposal.source_reference?.id]} />
          <Technical
            value={{
              proposal: proposal.proposal,
              result: proposal.result,
              decision_history: proposal.decision_history,
              delegation: proposal.delegation_id
                ? {id: proposal.delegation_id, revision: proposal.delegation_revision}
                : null,
            }}
          />
        </div>
      </Details>
    </ReviewDrawer>
  );
}
