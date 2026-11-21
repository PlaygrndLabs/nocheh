/**
 * Chats: every chat Nocheh is in, and what each one may do. The chats are a
 * table; a chat opens in its place, with the way back and to any other chat.
 */
import {useParam, useView} from '../lib/navigation';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {LoadError, Notice} from '../ui/core';
import {Page, Tabs} from '../ui/page';
import {loadSettings} from '../lib/settings';
import {ChatList} from './chats/chat-list';
import {ChatDetail} from './chats/detail';
import {telegramSettingsHref, useTelegram} from './chats/shared';
import {SharingView} from './chats/sharing';

const views = tabIds('chats');

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
            {id: 'chats', label: pageTabs.chats.chats},
            {id: 'rules', label: pageTabs.chats.rules},
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

/** The table of chats, or the chat chosen from it: one at a time, each the full width of the page. */
function ChatsView({telegram}: {telegram: ReturnType<typeof useTelegram>}) {
  const selected = useParam('chat');
  return selected ? <ChatDetail key={selected} space={selected} telegram={telegram} /> : <ChatList />;
}
