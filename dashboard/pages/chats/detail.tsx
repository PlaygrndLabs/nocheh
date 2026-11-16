/** One chat: where Nocheh answers, who may talk, what it remembers and may do, the tools it may use, and, for a group or topic, its project. */
import {ArrowLeft} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
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
import {ShortId} from './chat-list';
import {MemoryCard} from './memory';
import {WhoCanTalk} from './people';
import {NochehHere} from './presence';
import {PrivateChatProject, ProjectCard} from './project';
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

export function ChatDetail({space, telegram}: {space: string; telegram: Telegram}) {
  const chat = useChat(space);
  // What the chat is comes from the chat directory, never from its id (ADR-0252).
  const parentId = parentOf(chat);
  const parentChat = useChat(parentId ?? '');
  const parent = parentId ? parentChat : null;
  const {items, find, settled} = useChats();
  const context = useResource<ChatContext>('/conversations/context?space=' + encodeURIComponent(space));
  // A chat the directory doesn't know, or hasn't answered for yet, is no private chat, group or topic: nothing is
  // offered for it, as nothing is decided from its id.
  if (chat.kind === 'unknown') return <UnknownChat chat={chat} loading={!settled(space)} />;
  const topics: Chat[] =
    chat.kind === 'group'
      ? items.filter(item => item.kind === 'topic' && item.parent_space === space).sort(byTopicKey)
      : [];
  const owner = chat.kind === 'private' && chat.owner === true;
  const group = chat.kind === 'group';
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
      <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={() => setParams({chat: null})}>
        <ArrowLeft aria-hidden /> All chats
      </Button>
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
                <a href={chatHref(parentId ?? '')} className="font-medium text-accent-text hover:underline" dir="auto">
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
      {context.error && !context.data && (
        <LoadError what="this chat’s details" onRetry={() => void refreshResources()} />
      )}
      <NochehHere chat={chat} parent={parent} telegram={telegram} />
      {/* A group Nocheh left or was removed from has nobody to choose: the owner adds Nocheh there first. */}
      {switchable(chat) && <WhoCanTalk group={chat} telegram={telegram} />}
      {(owner || on) && (
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
      )}
      {chat.kind === 'topic' && (
        <p className="px-1 text-[13px] text-muted">
          This topic uses its group’s role and skills.{' '}
          <a href={chatHref(parentId ?? '')} className="font-medium text-accent-text hover:underline">
            Open the group
          </a>
        </p>
      )}
      <MemoryCard chat={chat} telegram={telegram} context={context.data} />
      <AllowedActions chat={chat} context={context.data} />
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
      {isGroupChat(chat, find) ? (
        <ProjectCard chat={chat} served={on} />
      ) : (
        <PrivateChatProject chat={chat} yours={chat.owner === true} />
      )}
      {forum && <TopicsCard group={chat} topics={topics} />}
    </div>
  );
}

function UnknownChat({chat, loading}: {chat: Chat; loading: boolean}) {
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={() => setParams({chat: null})}>
        <ArrowLeft aria-hidden /> All chats
      </Button>
      <header className="min-w-0">
        <h2 className="truncate text-lg font-semibold" dir="auto">
          {loading ? 'Loading…' : chatName(chat)}
        </h2>
      </header>
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
