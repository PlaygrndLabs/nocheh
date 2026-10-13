/**
 * Hide a message from the assistant, or bring it back. Hiding is the owner's
 * reversible decision: the original stays kept and a reply already sent in
 * Telegram is not recalled. Delivered replies that answered or quote the
 * message are offered, never hidden implicitly.
 */
import {useState} from 'react';
import {Eye, EyeOff} from 'lucide-react';
import {useResource, refreshResources} from '../../lib/resource';
import {fullTime} from '../../lib/messages-format';
import {Badge, Button, Details, LoadError, Notice, Skeleton} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useCommand} from './use-command';

type Related = {event_id: string; relation: 'reply' | 'quote'; text: string | null; retired: boolean; revision: number};
type Retirement = {
  event_id: string;
  retired: boolean;
  revision: number;
  history?: {revision: number; retired: boolean; created_at: string}[];
  related_replies?: Related[];
};

export function HideControl({id}: {id: string}) {
  const path = `/sources/${id}/retirement`;
  const resource = useResource<Retirement>(path, 15000);
  const feedback = useFeedback();
  const command = useCommand();
  const [chosen, setChosen] = useState<string[]>([]);

  if (resource.error.includes('telegram_message_not_found')) return null;
  if (!resource.data && resource.error)
    return <LoadError what="whether the assistant may use this" onRetry={() => void refreshResources()} />;
  if (!resource.data) return <Skeleton className="h-16 w-full" />;
  const state = resource.data;
  const offered = (state.related_replies ?? []).filter(reply => !reply.retired);
  const selected = offered.filter(reply => chosen.includes(reply.event_id));
  const plural = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;

  /** Each selected reply is its own decision with its own revision check. */
  async function hideReplies(): Promise<number> {
    let done = 0;
    for (const reply of selected) {
      const result = await command.run('replies', `/sources/${reply.event_id}/retirement`, {
        retired: true,
        expected_revision: reply.revision,
      });
      if (!result) break;
      done++;
    }
    setChosen([]);
    return done;
  }

  async function hide() {
    const ok = await feedback.confirm({
      title: 'Hide this message from the assistant?',
      body: (
        <>
          The assistant stops using it in replies and learning. The original stays here, and a reply already sent in
          Telegram is not recalled. You can bring it back at any time.
          {selected.length > 0 && <> {plural(selected.length)} you selected will be hidden too.</>}
        </>
      ),
      confirm: selected.length ? `Hide message and ${plural(selected.length)}` : 'Hide message',
      danger: true,
    });
    if (!ok) return;
    const result = await command.run('toggle', path, {retired: true, expected_revision: state.revision});
    if (!result) return;
    const replies = selected.length ? await hideReplies() : 0;
    feedback.toast(`Hidden from the assistant.${replies ? ` ${plural(replies)} hidden too.` : ''}`);
  }

  async function bringBack() {
    const result = await command.run('toggle', path, {retired: false, expected_revision: state.revision});
    if (result) feedback.toast('The assistant may use this message again.');
  }

  async function hideSelected() {
    const replies = await hideReplies();
    if (replies) feedback.toast(`${plural(replies)} hidden from the assistant.`);
  }

  const toggle = (reply: string) =>
    setChosen(current => (current.includes(reply) ? current.filter(value => value !== reply) : [...current, reply]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
        {state.retired ? (
          <Badge>
            <EyeOff className="size-3" aria-hidden /> Hidden from assistant
          </Badge>
        ) : (
          <Badge tone="good">
            <Eye className="size-3" aria-hidden /> The assistant may use this
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {state.retired ? (
            <Button
              variant="primary"
              size="sm"
              busy={command.busy === 'toggle'}
              disabled={!!command.busy}
              onClick={() => void bringBack()}
            >
              Bring back
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              busy={command.busy === 'toggle'}
              disabled={!!command.busy}
              onClick={() => void hide()}
            >
              <EyeOff aria-hidden />
              {selected.length ? `Hide with ${plural(selected.length)}` : 'Hide from assistant'}
            </Button>
          )}
        </div>
      </div>
      <p className="text-[13px] text-muted">
        {state.retired
          ? 'The assistant won’t use this message or its edits in replies or learning. The original is still kept.'
          : 'Hiding never deletes the original or recalls a reply already sent in Telegram.'}
      </p>

      {offered.length > 0 && (
        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium">
            {state.retired ? 'Assistant replies still in use' : 'Also hide these assistant replies?'}
          </legend>
          <p className="text-xs text-muted">They are separate messages and stay in use unless you tick them.</p>
          {offered.map(reply => (
            <label
              key={reply.event_id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-subtle"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 accent-accent"
                checked={chosen.includes(reply.event_id)}
                disabled={!!command.busy}
                onChange={() => toggle(reply.event_id)}
              />
              <span className="min-w-0 text-[13px]">
                <span className="font-medium">
                  {reply.relation === 'reply' ? 'Direct reply' : 'Quotes this message'}
                </span>
                <span dir="auto" className="line-clamp-2 block text-muted">
                  {reply.text || 'Reply without text'}
                </span>
              </span>
            </label>
          ))}
          {state.retired && (
            <Button
              size="sm"
              busy={command.busy === 'replies'}
              disabled={!selected.length || !!command.busy}
              onClick={() => void hideSelected()}
            >
              Hide {selected.length ? plural(selected.length) : 'selected replies'}
            </Button>
          )}
        </fieldset>
      )}

      {command.error && (
        <Notice tone="bad" title="Not changed">
          {command.error}
        </Notice>
      )}

      {!!state.history?.length && (
        <Details summary="History of this choice">
          <ul className="space-y-1 text-[13px]">
            {state.history.map(item => (
              <li key={item.revision} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{item.retired ? 'Hidden' : 'Brought back'}</span>
                <span className="text-muted">{fullTime(item.created_at)}</span>
              </li>
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
}
