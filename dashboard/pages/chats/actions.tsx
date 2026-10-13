/** "Allowed actions": standing permissions Nocheh may use here without asking again. */
import {actionKindLabel, formatDate, type Chat} from '../../lib/chats-model';
import {href} from '../../lib/routes';
import {Button, Card, CardBody, CardHeader} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {ActionError, useAction} from './shared';
import type {ChatContext, Permission} from './detail';

export function AllowedActions({chat, context}: {chat: Chat; context: ChatContext | null}) {
  const action = useAction();
  const {confirm} = useFeedback();
  const now = Date.now();
  const permissions = (context?.external_actions?.permissions ?? []).filter(
    item => !item.revoked_at && item.remaining > 0 && new Date(item.expires_at).getTime() > now,
  );
  const revoke = async (permission: Permission) => {
    const ok = await confirm({
      title: 'Revoke this permission?',
      body: 'Nocheh will ask you again before doing this. Actions already done aren’t undone.',
      confirm: 'Revoke',
      danger: true,
    });
    if (ok)
      await action.run(
        permission.id,
        '/tools/revoke',
        {id: permission.id},
        {success: 'Permission revoked.', operation: false},
      );
  };
  return (
    <Card>
      <CardHeader
        title="Allowed actions"
        description={chat.kind === 'topic' ? 'Permissions belong to the whole group.' : undefined}
      />
      <CardBody className="pt-3">
        {!context ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : permissions.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {permissions.map(permission => (
              <li key={permission.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{actionKindLabel[permission.kind] ?? 'Other actions'}</p>
                  <p className="text-xs text-muted">
                    {permission.remaining} {permission.remaining === 1 ? 'use' : 'uses'} left · until{' '}
                    {formatDate(permission.expires_at)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  busy={action.busy === permission.id}
                  disabled={!!action.busy}
                  onClick={() => void revoke(permission)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nothing without asking. Each action waits for your approval in the{' '}
            <a href={href('inbox')} className="font-medium text-accent-text hover:underline">
              Inbox
            </a>
            .
          </p>
        )}
        <ActionError text={action.error} />
      </CardBody>
    </Card>
  );
}
