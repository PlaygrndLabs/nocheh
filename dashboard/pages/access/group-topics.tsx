import {useState, type FormEvent} from 'react';
import {call} from '../../lib/api';
import {errorText} from '../../lib/page-helpers';
import {Button} from '../../components/ui/primitives';
import type {Chat} from './chats';

const topicNumber = (topic: Chat) => Number(topic.space_id.split('/topic/')[1]);

/**
 * The topics Nocheh knows in one forum group. Telegram does not let bots list
 * topics, so the owner can add an older topic that has had no activity.
 */
export function GroupTopics({
  group,
  topics,
  onChanged,
  notify,
}: {
  group: Chat;
  topics: Chat[];
  onChanged: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [link, setLink] = useState(''),
    [name, setName] = useState('');
  const change = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      await call('/telegram/topics', body);
      onChanged();
      notify(message);
      return true;
    } catch (error) {
      notify(errorText(error), true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ref = link.trim();
    const target = /^\d+$/.test(ref) ? {chat_id: group.space_id, topic_id: Number(ref)} : {link: ref};
    if (await change({action: 'add', name: name.trim(), ...target}, 'Topic added.')) {
      setLink('');
      setName('');
    }
  };
  return (
    <div className="access-topics">
      {topics.length ? (
        <ul className="access-topic-list" aria-label={'Topics in ' + (group.name || group.space_id)}>
          {topics.map(topic => (
            <li key={topic.space_id}>
              <a href={'#access?view=chats&chat=' + encodeURIComponent(topic.space_id)} dir="auto">
                {topic.name || 'Topic ' + topicNumber(topic)}
              </a>
              <small className="n-muted">
                {[
                  topic.closed && 'closed',
                  topic.registered && 'added by you',
                  !topic.observed_at && !topic.registered && 'no message yet',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
              {topic.registered && (
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label={'Remove topic ' + (topic.name || topicNumber(topic))}
                  onClick={() =>
                    void change(
                      {action: 'remove', chat_id: group.space_id, topic_id: topicNumber(topic)},
                      'Topic removed from the list.',
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="n-muted">No topics seen yet.</p>
      )}
      <details className="access-topic-add">
        <summary>Add an older topic</summary>
        <p className="n-muted">
          New and renamed topics appear on their own. Telegram does not let bots list topics, so add an older, quiet
          topic here: in Telegram, open the topic and use Copy link. Adding a topic changes nobody's access.
        </p>
        <form onSubmit={add}>
          <label>
            Topic link or number
            <input
              value={link}
              disabled={busy}
              placeholder="https://t.me/c/…/12"
              onChange={e => setLink(e.target.value)}
            />
          </label>
          <label>
            Topic name
            <input value={name} disabled={busy} dir="auto" maxLength={128} onChange={e => setName(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !link.trim() || !name.trim()}>
            Add topic
          </Button>
        </form>
      </details>
    </div>
  );
}
