/** One chat, in four sub-tabs: where Nocheh answers and its members; its role and skills; what it may do and the tools it may use; what it remembers and, for a group or topic, its project. */
import {ArrowLeft} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {useSubTab} from '../../lib/navigation';
import {cn} from '../../lib/utils';
import {SubPanel, SubTabs} from '../../ui/page';
import {
  appIdLabel,
  byTopicKey,
  chatName,
  isGroupChat,
  isOn,
  parentOf,
  shortIdLabel,
  switchable,
  telegramProfile,
  type Chat,
} from '../../lib/chats-model';
import {Button, Card, CardBody, CardHeader, LoadError} from '../../ui/core';
import {AllowedActions} from './actions';
import {ChatSwitch, ShortId} from './chat-list';
import {MemoryCard} from './memory';
import {MembersHere} from './people';
import {NochehHere} from './presence';
import {PrivateChatProject, ProjectCard, useProjectUnanswered} from './project';
import {RoleAndSkills} from './role-skills';
import {chatHref, useChat, useChats, type Telegram} from './shared';
import {ToolSwitches} from './tools';
import {TopicsCard} from './topics';

export type Permission = {
  id: string;
  kind: string;
  remaining: number;
  expires_at: string;
  revoked_at?: string | null;
};
export type SharingRuleSummary = {
  id: string;
  name: string;
  enabled: boolean;
  sources: string[];
  mode: string;
  through_group?: boolean;
};
export type ChatContext = {
  knowledge_access?: {owner_access?: boolean; sharing_rules?: SharingRuleSummary[]};
  external_actions?: {permissions?: Permission[]};
  memory?: {availability?: string};
};

const tabs = [
  {id: 'access', label: 'Access'},
  {id: 'role', label: 'Role and skills'},
  {id: 'tools', label: 'Tools and limits'},
  {id: 'memory', label: 'Memory and project'},
] as const;
const tabIds = tabs.map(item => item.id);

export function ChatDetail({space, telegram}: {space: string; telegram: Telegram}) {
  const chat = useChat(space);
  // What the chat is comes from the chat directory, never from its id (ADR-0252).
  const parentId = parentOf(chat);
  const parentChat = useChat(parentId ?? '');
  const parent = parentId ? parentChat : null;
  const {items, find, settled} = useChats();
  const context = useResource<ChatContext>('/conversations/context?space=' + encodeURIComponent(space));
  const [tab, setTab] = useSubTab(tabIds);
  // A served group that hasn't said which project it joins is asked on the last tab, which is marked.
  const asks = useProjectUnanswered(chat, chat.kind === 'group' && isOn(chat));
  // A chat the directory doesn't know, or hasn't answered for yet, is no private chat, group or topic: nothing is
  // offered for it, as nothing is decided from its id.
  if (chat.kind === 'unknown') return <UnknownChat chat={chat} loading={!settled(space)} />;
  const topics: Chat[] =
    chat.kind === 'group'
      ? items.filter(item => item.kind === 'topic' && item.parent_space === space).sort(byTopicKey)
      : [];
  const owner = chat.kind === 'private' && chat.owner === true;
  const group = chat.kind === 'group';
  // A group or one of its topics; the owner's private chat has topics too.
  const inGroup = isGroupChat(chat, find);
  const on = group && isOn(chat);
  // Telegram lists no topics to a bot: a forum, or a group topics were already seen in, can have older ones added.
  const forum = on && (chat.is_forum === true || topics.length > 0);
  // The owner's own topics follow the private chat, so only its chat, served groups and their topics have switches.
  const tools = owner || on || (chat.kind === 'topic' && isOn(parent ?? chat));
  const where = owner ? 'your private chat' : chatName(chat);
  const label = appIdLabel(chat);
  const short = shortIdLabel(chat);
  const profile = telegramProfile(chat);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap-reverse items-start justify-between gap-x-4 gap-y-2">
        <header className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-lg font-semibold" dir="auto">
              {owner ? 'Your private chat' : chatName(chat)}
            </h2>
            {short && <ShortId value={short} />}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
            <span>
              {chat.kind === 'topic' ? (
                <>
                  Topic in{' '}
                  <a
                    href={chatHref(parentId ?? '')}
                    className="font-medium text-accent-text hover:underline"
                    dir="auto"
                  >
                    {parent ? chatName(parent) : 'its group'}
                  </a>
                </>
              ) : group ? (
                topics.length ? (
                  `Group · ${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}`
                ) : (
                  'Group'
                )
              ) : (
                'Private chat'
              )}
            </span>
            {profile && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={profile.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent-text hover:underline"
                  dir="ltr"
                >
                  {profile.handle}
                </a>
              </>
            )}
            {label && (
              <>
                <span aria-hidden>·</span>
                <span className="font-mono text-xs">{label}</span>
              </>
            )}
          </p>
        </header>
        <BackToChats selected={space} />
      </div>
      {context.error && !context.data && (
        <LoadError what="this chat’s details" onRetry={() => void refreshResources()} />
      )}
      {/* Four short screens instead of one long one; every panel stays on the page so its unsaved edits are kept. */}
      <SubTabs
        label="This chat"
        tabs={tabs.map(item => ({...item, count: item.id === 'memory' && asks ? 1 : null}))}
        value={tab}
        onChange={setTab}
      />
      <SubPanel id="access" current={tab}>
        {/* Side by side on a wide screen: where Nocheh stands and the topics, then who may talk here. */}
        <div className={cn('grid items-start gap-5', switchable(chat) && 'lg:grid-cols-2')}>
          <div className="min-w-0 space-y-5">
            <NochehHere chat={chat} parent={parent} telegram={telegram} />
            {forum && <TopicsCard group={chat} topics={topics} />}
          </div>
          {/* Who may talk in a group Nocheh is in, read-only: each member's switches are on the Members page. */}
          {switchable(chat) && <MembersHere group={chat} telegram={telegram} />}
        </div>
      </SubPanel>
      <SubPanel id="role" current={tab}>
        {owner || on ? (
          <RoleAndSkills
            scope={space}
            where={where}
            audience={group ? 'group' : 'owner'}
            description={
              group
                ? 'Only you set these. Every topic in this group uses them, on top of its project’s if it has one. Defaults for groups are in Settings › Assistant.'
                : 'Only you set these. The default for your private chat is in Settings › Assistant; groups never use either.'
            }
          />
        ) : chat.kind === 'topic' ? (
          <p className="px-1 text-[13px] text-muted">
            This topic uses its group’s role and skills.{' '}
            <a href={chatHref(parentId ?? '')} className="font-medium text-accent-text hover:underline">
              Open the group
            </a>
          </p>
        ) : (
          <p className="px-1 text-[13px] text-muted">
            {group
              ? 'A group gets its own role and skills once Nocheh is on in it.'
              : 'Only your own private chat has a role and skills of its own.'}
          </p>
        )}
      </SubPanel>
      <SubPanel id="tools" current={tab}>
        <AllowedActions chat={chat} group={inGroup} context={context.data} />
        {tools && (
          <ToolSwitches
            space={space}
            parent={parentId ?? '*'}
            title="Tools"
            where={where}
            description={
              chat.kind === 'topic'
                ? 'Only you set these. Default follows its group, one tool at a time.'
                : group
                  ? 'Only you set these. Every topic in this group follows them unless it sets its own. Defaults are in Settings › Assistant.'
                  : 'Only you set these, for this chat and its topics. Defaults for every chat are in Settings › Assistant.'
            }
          />
        )}
      </SubPanel>
      <SubPanel id="memory" current={tab}>
        <div className={cn('grid items-start gap-5', inGroup && 'lg:grid-cols-2')}>
          <MemoryCard chat={chat} telegram={telegram} context={context.data} />
          {inGroup ? (
            <ProjectCard chat={chat} served={on} />
          ) : (
            <PrivateChatProject chat={chat} yours={chat.owner === true} />
          )}
        </div>
      </SubPanel>
    </div>
  );
}

/** Back to the table of chats, and the way straight to another chat. */
function BackToChats({selected}: {selected: string}) {
  return (
    <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-between">
      <Button variant="ghost" size="sm" onClick={() => setParams({chat: null, tab: null})}>
        <ArrowLeft aria-hidden /> All chats
      </Button>
      <ChatSwitch selected={selected} />
    </div>
  );
}

function UnknownChat({chat, loading}: {chat: Chat; loading: boolean}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap-reverse items-start justify-between gap-x-4 gap-y-2">
        <header className="min-w-0">
          <h2 className="truncate text-lg font-semibold" dir="auto">
            {loading ? 'Loading…' : chatName(chat)}
          </h2>
        </header>
        <BackToChats selected={chat.space_id} />
      </div>
      <Card>
        <CardHeader title="Nocheh here" />
        <CardBody className="pt-2 text-sm">
          {loading
            ? 'Loading this chat…'
            : 'Nocheh doesn’t know this chat. It shows here once Nocheh sees a message from it.'}
        </CardBody>
      </Card>
    </div>
  );
}
