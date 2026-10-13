/**
 * Chats: every chat Nocheh is in, and what each one may do. The list sits
 * beside the open chat on wide screens; on a phone the chat opens full width.
 */
import {MessagesSquare} from 'lucide-react';
import {useParam, useView} from '../lib/navigation';
import {cn} from '../lib/utils';
import {Card, Empty, LoadError, Notice} from '../ui/core';
import {Page, Tabs} from '../ui/page';
import {loadSettings} from '../lib/settings';
import {ChatList} from './chats/chat-list';
import {ChatDetail} from './chats/detail';
import {telegramSettingsHref, useTelegram} from './chats/shared';
import {SharingView} from './chats/sharing';

const views = ['chats', 'rules'] as const;

export default function ChatsPage() {
  const [view, setView] = useView(views);
  const telegram = useTelegram();
  return (
    <Page
      saveable
      title="Chats"
      description="Every chat Nocheh is in, and what each one may do."
      tabs={
        <Tabs
          label="Chats"
          value={view}
          onChange={setView}
          tabs={[
            {id: 'chats', label: 'Chats'},
            {id: 'rules', label: 'Sharing'},
          ]}
        />
      }
    >
      {telegram.error && !telegram.loaded && <LoadError what="Telegram settings" onRetry={() => void loadSettings()} />}
      {telegram.loaded && !telegram.enabled && (
        <Notice
          tone="warn"
          title="Telegram is off"
          action={
            <a href={telegramSettingsHref} className="text-[13px] font-medium text-accent-text hover:underline">
              Settings › Telegram
            </a>
          }
        >
          Nocheh isn’t answering in any chat until you turn it on.
        </Notice>
      )}
      {view === 'rules' ? <SharingView telegram={telegram} /> : <ChatsView telegram={telegram} />}
    </Page>
  );
}

function ChatsView({telegram}: {telegram: ReturnType<typeof useTelegram>}) {
  const selected = useParam('chat');
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
      <div className={cn('lg:sticky lg:top-6', selected && 'hidden lg:block')}>
        <ChatList selected={selected} telegram={telegram} />
      </div>
      <div className={cn('min-w-0', !selected && 'hidden lg:block')}>
        {selected ? (
          <ChatDetail key={selected} space={selected} telegram={telegram} />
        ) : (
          <Card>
            <Empty icon={MessagesSquare} title="Choose a chat">
              See whether Nocheh answers there, who may talk to it, what it remembers and what it may do.
            </Empty>
          </Card>
        )}
      </div>
    </div>
  );
}
