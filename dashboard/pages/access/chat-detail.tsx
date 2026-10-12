import {useState} from 'react';
import {call} from '../../lib/api';
import {errorText} from '../../lib/page-helpers';
import {refreshResources, useResource} from '../../lib/resource';
import {Alert, Button} from '../../components/ui/primitives';
import {StatusBadge} from '../../components/status';
import {conversationName} from '../../components/conversations';
import {AccessDefaults, AccessReview} from '../../components/memory-access';
import {GroupPeople} from './group-people';
import {GroupTopics} from './group-topics';
import {chatHref, type Chat} from './chats';
import type {TelegramSettings} from './telegram-settings';

type Notify = (text: string, error?: boolean) => void;
type Permission = {
  id: string;
  kind: string;
  remaining: number;
  expires_at: string;
  revoked_at?: string | null;
  current?: boolean;
};
type SharingRule = {id: string; name: string; enabled: boolean; sources: string[]; mode: string};
type Context = {
  knowledge_access?: {owner_access?: boolean; sharing_rules?: SharingRule[]};
  external_actions?: {permissions?: Permission[]};
  organization?: {effective?: {project?: {id: string; name: string} | null; inherited?: boolean}};
  memory?: {availability?: string};
};

const actionNames: Record<string, string> = {
  shell: 'Run a command',
  browser: 'Use the browser',
  telegram: 'Send a Telegram message',
};
const kindLabel = (chat: Chat) => (chat.kind === 'topic' ? 'Topic' : chat.kind === 'group' ? 'Group' : 'Private chat');

function telegramProblem(chat: Chat) {
  const state = chat.telegram?.state;
  if (state === 'migrated')
    return `Telegram upgraded this group to a supergroup with the new ID ${chat.telegram!.migrate_to_chat_id}. Turn Nocheh on in the new group instead.`;
  if (state === 'not_member') return 'Nocheh’s bot is not a member of this group. Add the bot in Telegram first.';
  if (state === 'not_found') return 'Telegram does not know this group.';
  return null;
}

/** One chat's access in three plain questions: who can talk, what is remembered, what may be done. */
export function ChatDetail({
  chat,
  topics,
  parent,
  telegram,
  notify,
}: {
  chat: Chat;
  topics: Chat[];
  parent: Chat | null;
  telegram: TelegramSettings;
  notify: Notify;
}) {
  const space = chat.space_id,
    group = chat.kind === 'topic' ? (chat.parent_space ?? '') : chat.kind === 'group' ? space : '',
    on = !!group && telegram.groupIds.includes(group),
    owner = chat.kind === 'private' && space === telegram.owner;
  const context = useResource<Context>('/conversations/context?space=' + encodeURIComponent(space)),
    data = context.data;
  const [busy, setBusy] = useState(false);
  const changed = (message?: string) => {
    void refreshResources();
    if (message) notify(message);
  };

  const switchGroup = async (enable: boolean) => {
    const changes: Record<string, string> = {
      TELEGRAM_GROUP_IDS: (enable ? [...telegram.groupIds, group] : telegram.groupIds.filter(id => id !== group)).join(
        ',',
      ),
    };
    if (!enable && telegram.access[group]) {
      // Saved settings may only hold people decisions for groups Nocheh is on in.
      if (!confirm('Turning Nocheh off here also forgets who you allowed in this group. Continue?')) return;
      const next = {...telegram.access};
      delete next[group];
      changes.TELEGRAM_GROUP_ACCESS = JSON.stringify(next);
    }
    await telegram.save(
      changes,
      (enable ? 'Nocheh is turned on in this group.' : 'Nocheh is turned off in this group.') +
        ' Apply saved settings for it to take effect.',
    );
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await call('/tools/revoke', {id});
      changed('Permission revoked. Actions already sent are not undone.');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setBusy(false);
    }
  };

  const names = telegram.names
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  const problem = telegramProblem(parent ?? chat);
  const permissions = (data?.external_actions?.permissions ?? []).filter(item => !item.revoked_at);
  const rules = data?.knowledge_access?.sharing_rules ?? [];
  const project = data?.organization?.effective?.project;

  return (
    <div className="access-detail">
      <header className="n-panel access-detail-head">
        <div>
          <span className="n-muted">{kindLabel(chat)}</span>
          <h2 dir="auto">{owner ? 'Your private chat' : conversationName(chat)}</h2>
          {parent && (
            <p>
              In <a href={chatHref(parent.space_id)}>{conversationName(parent)}</a>
            </p>
          )}
        </div>
        <small className="owner-identifier">ID {space}</small>
      </header>
      {context.error && !data && <Alert>Some details for this chat are unavailable. Try again shortly.</Alert>}

      <section className="n-panel access-card" aria-labelledby="access-talk">
        <h3 id="access-talk">Who can talk to Nocheh here</h3>
        {chat.kind === 'private' ? (
          <p>
            {owner
              ? 'Only you. Nocheh answers you here and can use everything it knows.'
              : 'Nocheh answers only you in private chats. It does not reply to this person.'}
          </p>
        ) : (
          <>
            {problem && <Alert>{problem}</Alert>}
            {chat.kind === 'topic' ? (
              <p>
                Topics follow their group. Nocheh is {on ? 'on' : 'off'} in{' '}
                <a href={chatHref(group)}>{parent ? conversationName(parent) : 'this group'}</a>
                {on ? '; the people allowed there can talk to it in every topic.' : '.'}
              </p>
            ) : (
              <div className="access-switch-row">
                <div>
                  <strong>{on ? 'Nocheh is on in this group' : 'Nocheh is off in this group'}</strong>
                  <p className="n-muted">
                    {on
                      ? 'You can always talk to it here. Choose who else may below.'
                      : 'Turn it on to let Nocheh answer here.'}
                  </p>
                </div>
                <div className="n-access-choice" role="group" aria-label="Nocheh in this group">
                  {[false, true].map(value => (
                    <button
                      type="button"
                      key={String(value)}
                      disabled={telegram.busy || !telegram.loaded}
                      aria-pressed={on === value}
                      onClick={() => on !== value && void switchGroup(value)}
                    >
                      {value ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {on && (
              <p className="n-muted">
                {telegram.replies === 'all'
                  ? 'Nocheh may answer any message from someone allowed here.'
                  : `Nocheh answers only when addressed: a reply to it, its @username, or a message starting with ${
                      names.length ? names.join(' or ') : 'its name'
                    }.`}{' '}
                <a href="#settings">Change in Settings</a>
              </p>
            )}
            {on && chat.kind === 'group' && <GroupPeople group={group} telegram={telegram} />}
          </>
        )}
      </section>

      <section className="n-panel access-card" aria-labelledby="access-memory">
        <h3 id="access-memory">What Nocheh remembers here</h3>
        <div className="health-strip">
          <StatusBadge
            state={data?.memory?.availability ?? 'unknown'}
            label={'Long-term memory · ' + (data?.memory?.availability ?? 'unknown')}
          />
        </div>
        <p>
          {chat.kind === 'private'
            ? owner
              ? 'Your private chat can recall everything: all chats, groups and memory.'
              : 'Nocheh does not use other chats here.'
            : telegram.topicMemory === 'topic'
              ? 'Each topic in a group remembers only its own messages.'
              : 'The whole group shares one memory: its General chat and every topic.'}{' '}
          {chat.kind !== 'private' && (
            <>
              It never sees your private chat or other groups, except facts you share with it below.{' '}
              <a href="#access?view=defaults">Change topic memory for all groups</a>
            </>
          )}
        </p>
        {!owner && (
          <>
            <h4>Requests to share with this chat</h4>
            <AccessReview mode="requests" destination={space} onChanged={changed} />
            <h4>Facts shared with this chat</h4>
            <AccessReview mode="grants" destination={space} onChanged={changed} />
            <h4>Sharing rules into this chat</h4>
            {rules.length ? (
              <ul className="access-rule-list">
                {rules.map(rule => (
                  <li key={rule.id}>
                    <strong>{rule.name}</strong>{' '}
                    <span className="n-muted">
                      {rule.enabled ? 'On' : 'Off'} · from {rule.sources.length}{' '}
                      {rule.sources.length === 1 ? 'chat' : 'chats'} ·{' '}
                      {rule.mode === 'approved' ? 'you approve the exact text' : 'automatic privacy filter'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="n-muted">No sharing rules bring other chats’ messages here.</p>
            )}
            <a href="#access?view=rules">Manage sharing rules →</a>
            <details className="access-more">
              <summary>Suggestion settings for this chat</summary>
              <AccessDefaults destination={space} onChanged={changed} />
            </details>
          </>
        )}
      </section>

      <section className="n-panel access-card" aria-labelledby="access-actions">
        <h3 id="access-actions">What Nocheh may do here</h3>
        {permissions.length ? (
          <ul className="access-permissions">
            {permissions.map(permission => (
              <li key={permission.id}>
                <div>
                  <strong>{actionNames[permission.kind] ?? permission.kind}</strong>
                  <small className="n-muted">
                    {permission.remaining} {permission.remaining === 1 ? 'use' : 'uses'} left · until{' '}
                    {new Date(permission.expires_at).toLocaleString()}
                  </small>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void revoke(permission.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{data ? 'Nothing without asking. Each action waits for your approval in the Inbox.' : '…'}</p>
        )}
        <a href="#inbox">Open the Inbox →</a>
      </section>

      <section className="n-panel access-card" aria-labelledby="access-project">
        <h3 id="access-project">Project</h3>
        <p>
          {project ? (
            <>
              Part of <strong>{project.name}</strong>
              {data?.organization?.effective?.inherited ? ', through its group.' : '.'}
            </>
          ) : (
            'Not part of a project.'
          )}{' '}
          A project organizes chats; it does not share memory between them.
        </p>
        <a href="#projects">Open projects →</a>
      </section>

      {chat.kind === 'group' && on && /^-100/.test(space) && (
        <section className="n-panel access-card" aria-labelledby="access-topics">
          <h3 id="access-topics">Topics</h3>
          <GroupTopics group={chat} topics={topics} onChanged={() => void refreshResources()} notify={notify} />
        </section>
      )}
    </div>
  );
}
