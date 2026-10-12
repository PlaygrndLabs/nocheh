import {Inbox, MessagesSquare, Share2, SlidersHorizontal, Sparkles} from 'lucide-react';
import {WorkspaceTabs} from '../../components/workspace-tabs';
import {AccessDefaults, AccessReview} from '../../components/memory-access';
import {Alert, Button} from '../../components/ui/primitives';
import {refreshResources} from '../../lib/resource';
import {Sharing} from '../sharing';
import {ChatsView} from './chats';
import {useTelegramSettings, type TelegramSettings} from './telegram-settings';

type Notify = (text: string, error?: boolean) => void;

/** Saved Telegram changes reach the running services only when applied. */
function ApplyBar({telegram}: {telegram: TelegramSettings}) {
  if (!telegram.pending) return null;
  return (
    <div className="n-panel access-apply" role="status">
      <p>
        <strong>Saved, not applied yet.</strong> Apply to update Nocheh. Telegram replies may pause for a moment.
      </p>
      <Button variant="default" disabled={telegram.busy} onClick={() => void telegram.apply()}>
        Apply saved settings
      </Button>
    </div>
  );
}

function TopicMemory({telegram}: {telegram: TelegramSettings}) {
  return (
    <section className="n-panel" aria-labelledby="topic-memory-title">
      <h3 id="topic-memory-title">Topic memory</h3>
      <p className="n-muted">
        For every group with topics. Either way, a group never sees your private chat or other groups.
      </p>
      <div className="n-access-choice access-topic-memory" role="group" aria-label="Topic memory">
        {[
          ['group', 'Whole group', 'Its General chat and every topic share one memory.'],
          ['topic', 'Each topic', 'A topic remembers only its own messages.'],
        ].map(([value, label, note]) => (
          <button
            type="button"
            key={value}
            disabled={telegram.busy || !telegram.loaded}
            aria-pressed={telegram.topicMemory === value}
            onClick={() =>
              telegram.topicMemory !== value &&
              void telegram.save(
                {TELEGRAM_TOPIC_MEMORY: value!},
                `Topic memory set to ${label}. Apply saved settings for it to take effect.`,
              )
            }
          >
            <strong>{label}</strong>
            <small>{note}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

/** The one place to decide who can talk to Nocheh and what each chat may remember and use. */
export function ChatsAccess({notify}: {notify: Notify}) {
  const telegram = useTelegramSettings(notify);
  const changed = (message?: string) => {
    void refreshResources();
    if (message) notify(message);
  };
  return (
    <>
      {telegram.error && !telegram.loaded && <Alert>Telegram settings are unavailable. Try again shortly.</Alert>}
      <ApplyBar telegram={telegram} />
      <WorkspaceTabs
        page="access"
        label="Chats & access"
        views={[
          {
            id: 'chats',
            label: 'Chats',
            Icon: MessagesSquare,
            render: () => <ChatsView telegram={telegram} notify={notify} />,
          },
          {
            id: 'requests',
            label: 'Requests',
            Icon: Inbox,
            render: () => <AccessReview mode="requests" onChanged={changed} />,
          },
          {
            id: 'shared',
            label: 'Shared facts',
            Icon: Sparkles,
            render: () => <AccessReview mode="grants" onChanged={changed} />,
          },
          {id: 'rules', label: 'Sharing rules', Icon: Share2, render: () => <Sharing />},
          {
            id: 'defaults',
            label: 'Defaults',
            Icon: SlidersHorizontal,
            render: () => (
              <>
                <TopicMemory telegram={telegram} />
                <AccessDefaults onChanged={changed} />
              </>
            ),
          },
        ]}
      />
    </>
  );
}
