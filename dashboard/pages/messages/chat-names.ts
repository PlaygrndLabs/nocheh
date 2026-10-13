import {useResource} from '../../lib/resource';
import {useSettings} from '../../lib/settings';

type Conversations = {items?: {space_id: string; name: string | null; parent_name?: string | null}[]};

/** Turns a stored conversation id into the chat's name, or a plain description when no name is known. */
export function useChatNames(): (scope: string) => string {
  const conversations = useResource<Conversations>('/conversations?limit=100', 60000);
  const settings = useSettings();
  const owner = settings.saved('TELEGRAM_OWNER_ID');
  const names = new Map<string, string>();
  for (const item of conversations.data?.items ?? [])
    if (item.name) names.set(item.space_id, item.parent_name ? `${item.parent_name} › ${item.name}` : item.name);
  return scope => {
    if (!scope) return 'Unknown chat';
    if (owner && scope === owner) return 'Private chat';
    const known = names.get(scope);
    if (known) return known;
    if (scope.startsWith('import:') || scope.startsWith('desktop:')) return 'Imported chat';
    if (scope.includes('/topic/')) return 'Topic ' + scope.split('/topic/')[1];
    if (scope.startsWith('-')) return 'Group ' + scope;
    return 'Chat ' + scope;
  };
}
