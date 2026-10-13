/** Standing permissions: exact actions Nocheh may repeat without asking, and revoking them. */
import {useState} from 'react';
import {ShieldCheck} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {Badge, Button, Card, CardHeader, Details, Empty, LoadError, LoadingRows, Notice} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {
  actionName,
  actionSummary,
  fromNow,
  fullTime,
  useChatNames,
  useCommand,
  type ActionQueue,
  type Permission,
} from './shared';

const isActive = (p: Permission) => !p.revoked_at && p.remaining > 0 && new Date(p.expires_at).getTime() > Date.now();

export function Allowed() {
  const queue = useResource<ActionQueue>('/tools/actions', 15000);
  const permissions = queue.data?.permissions ?? [];
  const active = permissions.filter(isActive);
  const ended = permissions.filter(p => !isActive(p));
  return (
    <div className="space-y-4">
      {queue.error && <LoadError what="allowed actions" onRetry={() => void refreshResources()} />}
      <Card>
        <CardHeader
          title="Allowed actions"
          description="Nocheh may repeat these exact actions without asking until they run out or end."
        />
        <div className="pt-3">
          {!queue.data ? (
            queue.error ? (
              <Empty title="Allowed actions are unavailable">Nocheh didn’t answer. Try again in a moment.</Empty>
            ) : (
              <LoadingRows rows={2} />
            )
          ) : active.length === 0 ? (
            <Empty icon={ShieldCheck} title="Every action asks you first">
              To skip asking for one exact action, turn on “Allow this exact action again” when you approve it.
            </Empty>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {active.map(p => (
                <PermissionRow key={p.id} permission={p} disabled={!!queue.error} />
              ))}
            </ul>
          )}
        </div>
        {ended.length > 0 && (
          <div className="border-t border-line px-5 py-4">
            <Details summary={`Ended or revoked (${ended.length})`}>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {ended.map(p => (
                  <PermissionRow key={p.id} permission={p} />
                ))}
              </ul>
            </Details>
          </div>
        )}
      </Card>
    </div>
  );
}

function PermissionRow({permission: p, disabled}: {permission: Permission; disabled?: boolean}) {
  const {toast, confirm} = useFeedback();
  const chat = useChatNames();
  const command = useCommand();
  const [done, setDone] = useState(false);
  const active = isActive(p) && !done;
  const revoke = async () => {
    const ok = await confirm({
      title: 'Revoke this permission?',
      body: 'Nocheh will ask you again next time. Anything already started keeps running.',
      confirm: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    const body: Record<string, unknown> = {id: p.id};
    if (typeof p.revision === 'number') body.expected_revision = p.revision;
    if (await command.run('/tools/revoke', body, 'revoke')) {
      setDone(true);
      toast('Revoked. Nocheh will ask next time.');
    }
  };
  const ended = p.revoked_at
    ? 'Revoked ' + fromNow(p.revoked_at)
    : p.remaining <= 0
      ? 'Used up'
      : new Date(p.expires_at).getTime() <= Date.now()
        ? 'Ended ' + fromNow(p.expires_at)
        : 'Ends ' + fromNow(p.expires_at);
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{actionName(p.kind)}</p>
        <p
          className="mt-1 line-clamp-2 rounded bg-subtle px-2 py-1 font-mono text-xs break-all"
          title={actionSummary(p)}
        >
          {actionSummary(p) || 'Exact details unavailable'}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>In {chat(p.scope)}</span>
          {active && <Badge tone="good">{p.remaining === 1 ? '1 use left' : `${p.remaining} uses left`}</Badge>}
          <span title={fullTime(p.revoked_at ?? p.expires_at)}>{done ? 'Revoked just now' : ended}</span>
        </p>
        {command.error && (
          <Notice tone="bad" className="mt-2">
            {command.error}
          </Notice>
        )}
      </div>
      {active && (
        <Button
          size="sm"
          variant="danger"
          busy={command.busy === 'revoke'}
          disabled={disabled}
          onClick={() => void revoke()}
          aria-label={`Revoke permission to ${actionName(p.kind).toLowerCase()}`}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}
