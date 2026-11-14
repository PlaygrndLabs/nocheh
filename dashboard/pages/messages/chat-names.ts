import {useChatDirectory} from '../../lib/chat-directory';
import {currentAppId} from '../../lib/chats-model';

/**
 * Turns a stored chat into its name, or a plain description when no name is known. An archive original keeps the
 * app's own chat id (its scope), which names a chat through the chat directory's app ids, current or old; a job or a
 * browser capture names its chat by Nocheh's id. Neither id is read for what the chat is (ADR-0250).
 */
export function useChatNames(): (scope: string) => string {
  const chats = useChatDirectory(60000);
  return scope => {
    if (!scope) return 'Unknown chat';
    if (scope.startsWith('import:') || scope.startsWith('desktop:')) return 'Imported chat';
    const chat = chats.find(scope) ?? chats.byAppId(scope);
    if (!chat) return 'Unknown chat';
    if (chat.owner && chat.kind === 'private') return 'Private chat';
    if (chat.name) return chat.parent_name ? `${chat.parent_name} › ${chat.name}` : chat.name;
    if (chat.kind === 'topic') return chat.topic_key ? 'Topic ' + chat.topic_key : 'A topic';
    const label = currentAppId(chat);
    if (chat.kind === 'group') return label ? 'Group ' + label : 'A group';
    return label ? 'Chat ' + label : 'Unknown chat';
  };
}
