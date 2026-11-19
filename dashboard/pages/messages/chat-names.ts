import {useChatDirectory} from '../../lib/chat-directory';
import {currentAppId, type Chat, type FindChat} from '../../lib/chats-model';

/**
 * Whether a chat is someone else's private chat with Nocheh, or a topic of one (step 4): a member's, or the chat of
 * someone who wrote to Nocheh privately without being a member. Read from what the directory says the chat is, never
 * from its id. Messages keeps these under their own "Members' chats" filter.
 */
export function otherPrivate(chat: Chat | null, find: FindChat): boolean {
  if (!chat || chat.owner) return false;
  const base = chat.kind === 'topic' ? find(chat.parent_space) : chat;
  return base?.kind === 'private' && !base.owner;
}

/** The chat filter's value for every other person's private chat at once; no chat id starts with a colon. */
export const membersChats = ':members';

/** What the chat filter asks the archive for: one chat, the members' chats, or (by default) everything else. */
export function chatFilter(chat: string): Record<string, string> {
  if (chat === membersChats) return {private_chats: 'only'};
  return chat ? {scope: chat} : {private_chats: 'hide'};
}

/** A private chat that is not the owner's, by its person's name: “Mira Chen’s private chat”. */
export function otherPrivateName(chat: Chat): string {
  const name = chat.name?.trim();
  if (name) return `${name}’s private chat`;
  const label = currentAppId(chat);
  return label ? 'Private chat ' + label : 'A private chat';
}

/**
 * Turns a stored chat into its name, or a plain description when no name is known. An archive original keeps the
 * app's own chat id (its scope), which names a chat through the chat directory's app ids, current or old; a job or a
 * browser capture names its chat by Nocheh's id. Neither id is read for what the chat is (ADR-0252).
 */
export function useChatNames(): (scope: string) => string {
  const chats = useChatDirectory(60000);
  return scope => {
    if (!scope) return 'Unknown chat';
    if (scope.startsWith('import:') || scope.startsWith('desktop:')) return 'Imported chat';
    const chat = chats.find(scope) ?? chats.byAppId(scope);
    if (!chat) return 'Unknown chat';
    if (chat.owner && chat.kind === 'private') return 'Private chat';
    if (chat.kind === 'private') return otherPrivateName(chat);
    if (chat.name) return chat.parent_name ? `${chat.parent_name} › ${chat.name}` : chat.name;
    if (chat.kind === 'topic') return chat.topic_key ? 'Topic ' + chat.topic_key : 'A topic';
    const label = currentAppId(chat);
    if (chat.kind === 'group') return label ? 'Group ' + label : 'A group';
    return label ? 'Chat ' + label : 'Unknown chat';
  };
}

/**
 * Whether an archive scope belongs to someone else's private chat, for the Messages chat filter; null while the
 * directory hasn't answered, so a chat it may still name is never put under the wrong heading.
 */
export function useOtherPrivate(): (scope: string) => boolean | null {
  const chats = useChatDirectory(60000);
  return scope => {
    if (!scope || scope.startsWith('import:') || scope.startsWith('desktop:')) return false;
    const chat = chats.find(scope) ?? chats.byAppId(scope);
    if (chat) return otherPrivate(chat, chats.find);
    return chats.directory.data && !chats.more ? false : null;
  };
}
