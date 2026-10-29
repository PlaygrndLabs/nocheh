/** One chat: where Nocheh answers, who may talk, what it remembers and may do, and its project. */
import {ArrowLeft} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {chatName, parentOf, topicNumber, type Chat} from '../../lib/chats-model';
import {Button, LoadError} from '../../ui/core';
import {AllowedActions} from './actions';
import {MemoryCard} from './memory';
import {WhoCanTalk} from './people';
import {NochehHere} from './presence';
import {ProjectCard} from './project';
import {RoleAndSkills} from './role-skills';
import {chatHref, useChat, useChats, type Telegram} from './shared';
import {TopicsCard} from './topics';

export type Permission = {
  id: string;
  kind: string;
  remaining: number;
  expires_at: string;
  revoked_at?: string | null;
};
export type SharingRuleSummary = {id: string; name: string; enabled: boolean; sources: string[]; mode: string};
export type ChatContext = {
  knowledge_access?: {owner_access?: boolean; sharing_rules?: SharingRuleSummary[]};
  external_actions?: {permissions?: Permission[]};
  memory?: {availability?: string};
};

export function ChatDetail({space, telegram}: {space: string; telegram: Telegram}) {
  const chat = useChat(space);
  const parentId = chat.kind === 'topic' ? (chat.parent_space ?? parentOf(space)) : null;
  const parentChat = useChat(parentId ?? '');
  const parent = parentId ? parentChat : null;
  const {items} = useChats();
  const context = useResource<ChatContext>('/conversations/context?space=' + encodeURIComponent(space));
  const topics: Chat[] =
    chat.kind === 'group'
      ? items
          .filter(item => item.kind === 'topic' && (item.parent_space ?? parentOf(item.space_id)) === space)
          .sort((a, b) => topicNumber(a.space_id) - topicNumber(b.space_id))
      : [];
  const owner = chat.kind === 'private' && space === telegram.owner;
  const group = chat.kind === 'group';
  const forum = group && telegram.isOn(space) && /^-100/.test(space);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2 lg:hidden" onClick={() => setParams({chat: null})}>
        <ArrowLeft aria-hidden /> All chats
      </Button>
      <header className="min-w-0">
        <h2 className="truncate text-lg font-semibold" dir="auto">
          {owner ? 'Your private chat' : chatName(chat, telegram.owner)}
        </h2>
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
          <span aria-hidden>·</span>
          <span className="font-mono text-xs">ID {space}</span>
        </p>
      </header>
      {context.error && !context.data && (
        <LoadError what="this chat’s details" onRetry={() => void refreshResources()} />
      )}
      <NochehHere chat={chat} parent={parent} telegram={telegram} />
      {group && <WhoCanTalk group={space} telegram={telegram} />}
      {(owner || (group && telegram.isOn(space))) && (
        <RoleAndSkills
          scope={space}
          where={owner ? 'your private chat' : chatName(chat, telegram.owner)}
          description={
            group
              ? 'Only you set these. Every topic in this group uses them, on top of its project’s if it has one. Defaults are in Settings › Assistant.'
              : 'Only you set these, on top of its project’s if it has one. Defaults for every chat are in Settings › Assistant.'
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
      <ProjectCard chat={chat} />
      {forum && <TopicsCard group={chat} topics={topics} />}
    </div>
  );
}
