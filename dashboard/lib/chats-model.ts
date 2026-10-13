/** Pure helpers for the Chats page: chat names, the chat tree and the Telegram access settings. */
import {participantAllowed, switchDecision, type ParticipantRule} from './group-access';

export type Chat = {
  space_id: string;
  name: string | null;
  kind: string;
  parent_space?: string | null;
  parent_name?: string | null;
  configured?: boolean;
  observed_at?: string | null;
  closed?: boolean;
  registered?: boolean;
  telegram?: {state: string; migrate_to_chat_id: string | null} | null;
};
export type Directory = {items: Chat[]; next_cursor: string | null; total?: number};
export type Person = {id: string; name?: string | null; username?: string | null};
export type IdentityGroup = {id: string; name?: string | null; users?: Person[]};
export type AccessRule = {granted: string[]; denied: string[]};
export type AccessMap = Record<string, AccessRule>;

/** A chat or topic ID: `42`, `-10042` or `-10042/topic/7`. */
export const isSpaceId = (text: string) => /^-?[1-9]\d{0,18}(\/topic\/[1-9]\d{0,9})?$/.test(text.trim());
export const validUserId = (text: string) => /^[1-9]\d{0,18}$/.test(text.trim());
export const parentOf = (space: string) => (space.includes('/topic/') ? space.split('/topic/')[0]! : null);
export const topicNumber = (space: string) => Number(space.split('/topic/')[1]);
export const inferKind = (space: string) =>
  space.includes('/topic/') ? 'topic' : space.startsWith('-') ? 'group' : 'private';

/** A chat known only by its ID, for links to chats outside the loaded list. */
export function chatFromId(space: string): Chat {
  return {space_id: space, name: null, kind: inferKind(space), parent_space: parentOf(space)};
}

export function chatName(chat: Chat | null | undefined, owner?: string): string {
  if (!chat) return 'Unknown chat';
  if (chat.kind === 'private' && owner && chat.space_id === owner) return 'You';
  const name = chat.name?.trim();
  if (name) return name;
  if (chat.kind === 'topic') return 'Topic ' + topicNumber(chat.space_id);
  if (chat.kind === 'group') return 'Unnamed group';
  return 'Private chat ' + chat.space_id;
}

export function kindLabel(chat: Chat): string {
  return chat.kind === 'topic' ? 'Topic' : chat.kind === 'group' ? 'Group' : 'Private chat';
}

export const parseGroupIds = (text: string): string[] =>
  text
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

/** The saved text when the set of groups is unchanged, so a no-op edit is no change. */
export function serializeGroupIds(ids: string[], savedText: string): string {
  const unique = [...new Set(ids)];
  const saved = parseGroupIds(savedText);
  if (unique.length === saved.length && unique.every(id => saved.includes(id))) return savedText;
  return unique.join(',');
}

export function parseAccess(text: string): AccessMap {
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: AccessMap = {};
    for (const [group, rule] of Object.entries(value as Record<string, any>))
      result[group] = {
        granted: Array.isArray(rule?.granted) ? rule.granted.map(String) : [],
        denied: Array.isArray(rule?.denied) ? rule.denied.map(String) : [],
      };
    return result;
  } catch {
    return {};
  }
}

const canonicalAccess = (map: AccessMap) =>
  JSON.stringify(
    Object.keys(map)
      .sort()
      .filter(group => map[group]!.granted.length || map[group]!.denied.length)
      .map(group => [group, [...map[group]!.granted].sort(), [...map[group]!.denied].sort()]),
  );

/** Groups with no decisions are dropped; the saved text is kept when nothing really changed. */
export function serializeAccess(map: AccessMap, savedText: string): string {
  if (canonicalAccess(map) === canonicalAccess(parseAccess(savedText))) return savedText;
  const clean: AccessMap = {};
  for (const group of Object.keys(map).sort()) {
    const rule = map[group]!;
    if (rule.granted.length || rule.denied.length)
      clean[group] = {granted: [...new Set(rule.granted)].sort(), denied: [...new Set(rule.denied)].sort()};
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : '{}';
}

export const emptyRule = (): AccessRule => ({granted: [], denied: []});
export const isAllowed = (rule: ParticipantRule, id: string) => participantAllowed(rule, id);

/** Allows or stops one person, restoring the saved decision when the switch goes back. */
export function withPersonDecision(
  access: AccessMap,
  saved: AccessMap,
  group: string,
  id: string,
  allow: boolean,
): AccessMap {
  const current = access[group] ?? emptyRule();
  const decision = switchDecision(saved[group], current, id, allow);
  if (!decision) return access;
  const granted = current.granted.filter(item => item !== id);
  const denied = current.denied.filter(item => item !== id);
  if (decision === 'grant') granted.push(id);
  if (decision === 'deny') denied.push(id);
  const next = {...access};
  if (granted.length || denied.length) next[group] = {granted, denied};
  else delete next[group];
  return next;
}

export type ChatTree = {
  privates: Chat[];
  groups: {group: Chat; topics: Chat[]}[];
};

/**
 * Private chats, then groups (Nocheh-on first) with their topics under them.
 * Groups Nocheh was turned on in or has seen people in appear even before the directory lists them.
 */
export function chatTree(
  items: Chat[],
  extraGroups: {id: string; name?: string | null}[],
  groupIds: string[],
  query: string,
  owner: string,
): ChatTree {
  const all = [...items];
  for (const group of extraGroups)
    if (!all.some(item => item.space_id === group.id))
      all.push({space_id: group.id, name: group.name ?? null, kind: 'group', parent_space: null});
  const q = query.trim().toLocaleLowerCase();
  const matches = (chat: Chat) =>
    !q ||
    [chat.space_id, chat.name, chat.parent_name, chatName(chat, owner)].some(value =>
      value?.toLocaleLowerCase().includes(q),
    );
  const topicsOf = (group: string) =>
    all
      .filter(item => item.kind === 'topic' && (item.parent_space ?? parentOf(item.space_id)) === group)
      .sort((a, b) => topicNumber(a.space_id) - topicNumber(b.space_id));
  const privates = all
    .filter(item => item.kind === 'private' && matches(item))
    .sort(
      (a, b) => Number(b.space_id === owner) - Number(a.space_id === owner) || chatName(a).localeCompare(chatName(b)),
    );
  const groups = all
    .filter(item => item.kind === 'group')
    .map(group => {
      const topics = topicsOf(group.space_id);
      return {group, topics: matches(group) ? topics : topics.filter(matches)};
    })
    .filter(entry => matches(entry.group) || entry.topics.length)
    .sort(
      (a, b) =>
        Number(groupIds.includes(b.group.space_id)) - Number(groupIds.includes(a.group.space_id)) ||
        chatName(a.group).localeCompare(chatName(b.group)),
    );
  return {privates, groups};
}

export const actionKindLabel: Record<string, string> = {
  shell: 'Run commands',
  browser: 'Use the browser',
  mcp: 'Use connected tools',
  telegram: 'Send Telegram messages',
};

export const lifetimeChoices: {seconds: number; label: string}[] = [
  {seconds: 3600, label: '1 hour'},
  {seconds: 6 * 3600, label: '6 hours'},
  {seconds: 86400, label: '1 day'},
  {seconds: 3 * 86400, label: '3 days'},
  {seconds: 7 * 86400, label: '1 week'},
  {seconds: 30 * 86400, label: '30 days'},
];

export function lifetimeLabel(seconds: number): string {
  const known = lifetimeChoices.find(choice => choice.seconds === seconds);
  if (known) return known.label;
  if (seconds % 86400 === 0) return seconds / 86400 + ' days';
  if (seconds % 3600 === 0) return seconds / 3600 + ' hours';
  return Math.round(seconds / 60) + ' minutes';
}

/** Plain words for an API error code from this page's actions. */
export function chatError(error: unknown): string {
  const code = (error as Error)?.message || String(error || 'request_failed');
  if (/conflict|changed/.test(code)) return 'This changed somewhere else. Reload to see the latest, your text is kept.';
  if (code === 'sharing_source_not_selected')
    return 'One of the chosen messages isn’t from a chat this rule shares from.';
  if (code === 'telegram_refresh_unavailable') return 'Telegram couldn’t be reached. Try again shortly.';
  if (code === 'topic_name_required') return 'Give the topic a name.';
  if (/topic/.test(code) && /invalid/.test(code))
    return 'That doesn’t look like a topic link or number from this group. In Telegram, open the topic and use Copy link.';
  if (/pending|busy|in_progress/.test(code)) return 'Nocheh is busy with another change. Try again in a moment.';
  if (code === 'owner_required') return 'Only you can do this.';
  if (code === 'memory_access_settings_missing') return 'Suggestion settings aren’t set up yet. Try again shortly.';
  if (code === 'fixture_capability_unavailable' || code === 'not_found')
    return 'This isn’t available on this installation.';
  if (/\s/.test(code)) return code;
  return 'That didn’t work (' + code.replaceAll('_', ' ') + '). Try again.';
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}
