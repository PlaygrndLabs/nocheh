/**
 * Memory › Projects › a project: the record of its Answer privately buttons (ADR-0249). Each row says when the
 * question was asked, where, which groups the private answer could read (frozen at the tap) and what became of it,
 * with a link to the archived question. Read only.
 */
import {refreshResources, useResource} from '../../lib/resource';
import {Badge, LoadError, LoadingRows, type Tone} from '../../ui/core';
import {useChats, when} from './shared';

type PrivateAnswer = {
  id: string;
  question_event: string;
  from_chat_id: string;
  read_chats: string[] | null;
  state: 'offered' | 'pressed' | 'answered' | 'needs_private_chat' | 'refused' | 'expired';
  refusal_code: string | null;
  offered_at: string;
  pressed_at: string | null;
  answered_at: string | null;
};

const states: Record<PrivateAnswer['state'], {label: string; tone: Tone}> = {
  offered: {label: 'Not tapped', tone: 'neutral'},
  pressed: {label: 'Waiting for /start', tone: 'info'},
  answered: {label: 'Answered', tone: 'good'},
  needs_private_chat: {label: 'Private chat not open', tone: 'warn'},
  refused: {label: 'Refused', tone: 'warn'},
  expired: {label: 'Expired', tone: 'neutral'},
};
const reasons: Record<string, string> = {
  only_asker: 'someone else tapped it',
  used: 'already answered',
  expired: 'too late',
  changed: 'the project’s groups or the question changed',
  not_yours: 'meant for someone else',
  not_delivered: 'its answer was not sent',
};

export function PrivateAnswers({project}: {project: string}) {
  const chats = useChats();
  const list = useResource<{answers: PrivateAnswer[]; next: string | null}>(
    '/private-answers?' + new URLSearchParams({project}),
    30000,
  );
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">Private answers</h3>
      <p className="mb-2 text-[13px] text-muted">
        Under your own answer in a group of this project, Answer privately answers the same question in your private
        chat from all of the project’s groups. Only you can use it, and it only reads.
      </p>
      {list.error && !list.data && (
        <LoadError what="private answers" error={list.error} onRetry={() => void refreshResources()} />
      )}
      {!list.data && !list.error && <LoadingRows rows={2} />}
      {list.data && !list.data.answers.length && <p className="text-[13px] text-muted">No button offered yet.</p>}
      {list.data && list.data.answers.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border text-[13px]">
          {list.data.answers.slice(0, 20).map(row => {
            const state = states[row.state] ?? {label: row.state, tone: 'neutral' as Tone};
            const reason = row.refusal_code ? (reasons[row.refusal_code] ?? row.refusal_code.replace(/_/g, ' ')) : '';
            return (
              <li key={row.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{chats.name(row.from_chat_id)}</span>
                  <Badge tone={state.tone}>{state.label}</Badge>
                  {reason && <span className="text-muted">({reason})</span>}
                  <span className="flex-1" />
                  <span className="text-muted">{when(row.offered_at)}</span>
                </div>
                {row.read_chats && (
                  <p className="text-muted">Could read: {row.read_chats.map(chat => chats.name(chat)).join(', ')}</p>
                )}
                <a
                  className="text-accent-text hover:underline"
                  href={'#messages?source=' + encodeURIComponent(row.question_event)}
                >
                  The question
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {list.data && list.data.answers.length > 20 && (
        <p className="mt-2 text-[13px] text-muted">Showing the latest 20.</p>
      )}
    </section>
  );
}
