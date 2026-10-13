/** "Memory": what this chat can recall, and what other chats share into it. */
import {ArrowRight} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {type Chat} from '../../lib/chats-model';
import {Badge, Button, Card, CardBody, CardHeader, Details, type Tone} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {ActionError, memoryRequestsHref, rulesHref, useAction, type Telegram} from './shared';
import {ChatSuggestions} from './suggestions';
import type {ChatContext} from './detail';

type Grant = {
  id: string;
  destination: string;
  mode: string;
  state: string;
  revision: number;
  wording: string | null;
  suspended_reason: string | null;
};
type Request = {id: string; state: string};

const availability: Record<string, {tone: Tone; label: string}> = {
  available: {tone: 'good', label: 'Long-term memory ready'},
  limited: {tone: 'warn', label: 'Long-term memory limited'},
  unavailable: {tone: 'neutral', label: 'Long-term memory off'},
};

function Subhead({children, action}: {children: React.ReactNode; action?: React.ReactNode}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{children}</h3>
      {action}
    </div>
  );
}

export function MemoryCard({chat, telegram, context}: {chat: Chat; telegram: Telegram; context: ChatContext | null}) {
  const space = chat.space_id;
  const owner = chat.kind === 'private' && space === telegram.owner;
  const state = context?.memory?.availability;
  const badge = state ? availability[state] : null;

  let recall: string;
  if (owner) recall = 'Can recall everything Nocheh knows, from every chat.';
  else if (chat.kind === 'private') recall = 'Nocheh doesn’t answer here, so nothing is recalled.';
  else
    recall =
      (telegram.topicMemory === 'topic'
        ? chat.kind === 'topic'
          ? 'Remembers only this topic’s messages.'
          : 'Each topic remembers only its own messages.'
        : 'The whole group shares one memory: its main chat and every topic.') +
      ' It never sees your private chat or other groups, except what you share below.';

  return (
    <Card>
      <CardHeader title="Memory" action={badge && <Badge tone={badge.tone}>{badge.label}</Badge>} />
      <CardBody className="space-y-5 pt-2">
        <p className="text-sm">
          {recall}{' '}
          {chat.kind !== 'private' && (
            <a href={rulesHref()} className="font-medium text-accent-text hover:underline">
              Change topic memory
            </a>
          )}
        </p>
        {!owner && (
          <>
            <SharedFacts space={space} />
            <RulesInto context={context} />
            <PendingRequests space={space} />
            <Details summary="Suggestion settings for this chat">
              <ChatSuggestions space={space} />
            </Details>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SharedFacts({space}: {space: string}) {
  const resource = useResource<{grants: Grant[]; next: string | null}>(
    '/memory-access/grants?destination=' + encodeURIComponent(space),
  );
  const action = useAction();
  const {confirm} = useFeedback();
  const current = (resource.data?.grants ?? []).filter(grant => ['active', 'suspended'].includes(grant.state));
  const revoke = async (grant: Grant) => {
    const ok = await confirm({
      title: 'Stop sharing this fact here?',
      body: 'Nocheh can’t use it in this chat any more. Messages already sent stay as they are.',
      confirm: 'Revoke',
      danger: true,
    });
    if (ok)
      await action.run(
        grant.id,
        '/memory-access/grants/' + grant.id + '/revoke',
        {expected_revision: grant.revision},
        {
          success: 'Fact no longer shared here.',
        },
      );
  };
  return (
    <section>
      <Subhead>Facts shared into this chat</Subhead>
      {resource.error && !resource.data ? (
        <p className="text-[13px] text-warn">Shared facts couldn’t be loaded. Try again shortly.</p>
      ) : !resource.data ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : current.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {current.map(grant => (
            <li key={grant.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm" dir="auto">
                  {grant.wording || 'The approved wording isn’t available.'}
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge>{grant.mode === 'one_time' ? 'For one reply' : 'Until revoked'}</Badge>
                  {grant.state === 'suspended' && <Badge tone="warn">Paused until you approve its new wording</Badge>}
                </div>
              </div>
              <Button
                size="sm"
                variant="danger"
                busy={action.busy === grant.id}
                disabled={!!action.busy}
                onClick={() => void revoke(grant)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">
          Nothing shared yet. Facts you approve from the Inbox, or share from Memory, appear here.
        </p>
      )}
      <ActionError text={action.error} />
    </section>
  );
}

function RulesInto({context}: {context: ChatContext | null}) {
  const rules = context?.knowledge_access?.sharing_rules ?? [];
  return (
    <section>
      <Subhead
        action={
          <a href={rulesHref()} className="text-[13px] font-medium text-accent-text hover:underline">
            Sharing rules
          </a>
        }
      >
        Chats that share into this one
      </Subhead>
      {!context ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : rules.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rules.map(rule => (
            <li key={rule.id}>
              <a
                href={rulesHref({rule: rule.id})}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-subtle"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
                  {rule.name}
                </span>
                <span className="text-xs text-muted">
                  from {rule.sources.length} {rule.sources.length === 1 ? 'chat' : 'chats'}
                </span>
                <Badge tone={rule.enabled ? 'good' : 'neutral'}>{rule.enabled ? 'On' : 'Off'}</Badge>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No other chat shares into this one.</p>
      )}
    </section>
  );
}

function PendingRequests({space}: {space: string}) {
  const resource = useResource<{requests: Request[]; next: string | null}>(
    '/memory-access/requests?destination=' + encodeURIComponent(space),
    30000,
  );
  const pending = (resource.data?.requests ?? []).filter(request => request.state === 'pending').length;
  if (!resource.data || !pending) return null;
  return (
    <a
      href={memoryRequestsHref}
      className="flex items-center gap-3 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm hover:border-warn/60"
    >
      <span className="flex-1">
        <strong>
          {pending}
          {resource.data.next ? '+' : ''} {pending === 1 ? 'request' : 'requests'}
        </strong>{' '}
        to share a fact here {pending === 1 ? 'waits' : 'wait'} for you.
      </span>
      <span className="flex items-center gap-1 font-medium text-accent-text">
        Review in Inbox <ArrowRight className="size-4" aria-hidden />
      </span>
    </a>
  );
}
