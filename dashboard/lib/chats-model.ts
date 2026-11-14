/** Pure helpers for the Chats page: chat names, the chat tree and the Telegram access settings. */
import type {ChatApp, ChatAppLabel, ChatKind, ChatState} from '../../src/chat-wire';
import {participantAllowed, switchDecision, type ParticipantRule} from './group-access';
import {sourceDate} from './messages-format';

export type Chat = {
  space_id: string;
  name: string | null;
  kind: ChatKind | 'unknown';
  parent_space?: string | null;
  parent_name?: string | null;
  configured?: boolean;
  observed_at?: string | null;
  closed?: boolean;
  registered?: boolean;
  telegram?: {state: string; migrate_to_chat_id: string | null} | null;
  /**
   * From the chat directory (ADR-0250). The dashboard reads what a chat is from these fields and never works it out
   * from its id: the id is Nocheh's own and says nothing.
   */
  topic_key?: string | null;
  /** The chat's ids in its app, current first, then older ones (a group Telegram upgraded). A topic has its group's. */
  app_ids?: ChatAppLabel[];
  is_forum?: boolean | null;
  /** Where Nocheh stands in the chat; a topic has its group's. */
  state?: ChatState | null;
  /** The owner's private chat, or one of its topics. */
  owner?: boolean;
};
export type Directory = {items: Chat[]; next_cursor: string | null; total?: number};
export type Person = {id: string; name?: string | null; username?: string | null};
export type IdentityGroup = {id: string; name?: string | null; users?: Person[]};
export type AccessRule = {granted: string[]; denied: string[]};
export type AccessMap = Record<string, AccessRule>;
/** Looks a chat up by its Nocheh id in the chat directory; null when no chat has that id. */
export type FindChat = (space: string | null | undefined) => Chat | null;

/** A Telegram user ID, typed by the owner for group access. Not a chat id. */
export const validUserId = (text: string) => /^[1-9]\d{0,18}$/.test(text.trim());

/** A chat known only by its id, for links to chats outside the loaded list. Nothing is read from the id. */
export const unknownChat = (space: string, name: string | null = null): Chat => ({
  space_id: space,
  name,
  kind: 'unknown',
  parent_space: null,
});

/** A chat's ids in an app, current first, then older ones. Labels only: shown, and matched with archive originals. */
export const appIds = (chat: Chat | null | undefined, app: ChatApp = 'telegram'): string[] =>
  (chat?.app_ids ?? []).filter(label => label.app === app).map(label => label.external);
/** The id the app uses for a chat now, or null when it has none. */
export const currentAppId = (chat: Chat | null | undefined, app: ChatApp = 'telegram'): string | null =>
  chat?.app_ids?.find(label => label.app === app && label.state === 'current')?.external ?? null;
const appNames: Record<ChatApp, string> = {telegram: 'Telegram', slack: 'Slack'};
/** "Telegram ID -1001…", and "earlier -4…" for a group Telegram upgraded; null for a chat with no app id. */
export function appIdLabel(chat: Chat | null | undefined): string | null {
  const labels = chat?.app_ids ?? [];
  const current = labels.find(label => label.state === 'current');
  if (!current) return null;
  const earlier = labels
    .filter(label => label.state === 'old' && label.app === current.app)
    .map(label => label.external);
  return (
    `${appNames[current.app] ?? current.app} ID ${current.external}` +
    (earlier.length ? ` · earlier ${earlier.join(', ')}` : '')
  );
}

/** A topic's group or private chat; null for anything else. */
export const parentOf = (chat: Chat | null | undefined): string | null =>
  chat?.kind === 'topic' ? (chat.parent_space ?? null) : null;
/** The group of a group or of one of its topics; null for a private chat, its topics and an unknown chat. */
export function groupOf(chat: Chat | null | undefined, find: FindChat): string | null {
  if (!chat) return null;
  if (chat.kind === 'group') return chat.space_id;
  const parent = chat.kind === 'topic' ? find(chat.parent_space) : null;
  return parent?.kind === 'group' ? parent.space_id : null;
}
/**
 * A group or one of its topics: the only chats that share, are shared with or join a project. Every other chat, one
 * the directory doesn't know included, counts as private, as the server's chat directory does (ADR-0242, ADR-0250).
 */
export const isGroupChat = (chat: Chat | null | undefined, find: FindChat): boolean => groupOf(chat, find) !== null;
/** Topics in the order their app numbers them. */
export const byTopicKey = (a: Chat, b: Chat): number =>
  Number(a.topic_key) - Number(b.topic_key) || String(a.topic_key ?? '').localeCompare(String(b.topic_key ?? ''));

export function chatName(chat: Chat | null | undefined): string {
  if (!chat) return 'Unknown chat';
  if (chat.kind === 'private' && chat.owner) return 'You';
  const name = chat.name?.trim();
  if (name) return name;
  if (chat.kind === 'topic') return chat.topic_key ? 'Topic ' + chat.topic_key : 'Topic';
  if (chat.kind === 'group') return 'Unnamed group';
  if (chat.kind === 'private') {
    const id = currentAppId(chat);
    return id ? 'Private chat ' + id : 'Private chat';
  }
  return 'Unknown chat';
}

export function kindLabel(chat: Chat): string {
  return chat.kind === 'topic'
    ? 'Topic'
    : chat.kind === 'group'
      ? 'Group'
      : chat.kind === 'private'
        ? 'Private chat'
        : 'Chat';
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

/**
 * Until chats.state is the only source (step 2b-2), TELEGRAM_GROUP_IDS still decides which groups Nocheh serves, by
 * their Telegram ids (ADR-0250). A group is listed when any of its Telegram ids is, an old one included.
 */
export const groupListed = (ids: string[], chat: Chat | null | undefined): boolean =>
  appIds(chat).some(id => ids.includes(id));
/** Lists a group by its current Telegram id, or drops every Telegram id it has had. */
export function withGroupListed(ids: string[], chat: Chat, on: boolean): string[] {
  const own = appIds(chat);
  if (!on) return ids.filter(id => !own.includes(id));
  const current = currentAppId(chat);
  return own.some(id => ids.includes(id)) || !current ? ids : [...ids, current];
}
/** The TELEGRAM_GROUP_ACCESS key a group's people are kept under: whichever of its Telegram ids has them, else its
 * current one. Null for a chat with no Telegram id. */
export const accessKey = (access: AccessMap, chat: Chat | null | undefined): string | null =>
  appIds(chat).find(id => access[id]) ?? currentAppId(chat);

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
 * Private chats (yours first), then groups (Nocheh-on first) with their topics under them. Groups people were seen
 * in appear even before the directory lists them.
 */
export function chatTree(
  items: Chat[],
  extraGroups: {id: string; name?: string | null}[],
  on: (chat: Chat) => boolean,
  query: string,
): ChatTree {
  const all = [...items];
  for (const group of extraGroups)
    if (!all.some(item => item.space_id === group.id || appIds(item).includes(group.id)))
      all.push({space_id: group.id, name: group.name ?? null, kind: 'group', parent_space: null});
  const q = query.trim().toLocaleLowerCase();
  const matches = (chat: Chat) =>
    !q ||
    [chat.space_id, chat.name, chat.parent_name, chatName(chat), ...appIds(chat)].some(value =>
      value?.toLocaleLowerCase().includes(q),
    );
  const topicsOf = (group: string) =>
    all.filter(item => item.kind === 'topic' && item.parent_space === group).sort(byTopicKey);
  const privates = all
    .filter(item => item.kind === 'private' && matches(item))
    .sort((a, b) => Number(!!b.owner) - Number(!!a.owner) || chatName(a).localeCompare(chatName(b)));
  const groups = all
    .filter(item => item.kind === 'group')
    .map(group => {
      const topics = topicsOf(group.space_id);
      return {group, topics: matches(group) ? topics : topics.filter(matches)};
    })
    .filter(entry => matches(entry.group) || entry.topics.length)
    .sort((a, b) => Number(on(b.group)) - Number(on(a.group)) || chatName(a.group).localeCompare(chatName(b.group)));
  return {privates, groups};
}

/**
 * The search hits a sharing rule may use: those whose chat is a source's group or one of its topics, as a topic
 * source reads its whole group. A hit names its chat by chat_id (ADR-0250), never by the archive's raw scope; a hit
 * with a scope but no chat is no source's.
 */
export function sourceHits<T extends {scope?: string; chat_id?: string | null}>(
  hits: T[],
  sources: string[],
  find: FindChat,
): T[] {
  const base = (id: string) => parentOf(find(id)) ?? id;
  const groups = new Set(sources.map(base));
  return hits.filter(hit => (hit.chat_id ? groups.has(base(hit.chat_id)) : !hit.scope));
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
/** Plain words for a refusal because a private chat would share, be shared with or join a project (ADR-0242). */
export const privateChatErrors: Record<string, string> = {
  sharing_private_chat: 'Private chats never share or get shared with. Choose only groups or topics.',
  project_private_chat: 'A private chat never joins a project. Choose a group or topic.',
  organization_private_chat: 'Nocheh organizes only groups and topics. Leave private chats out.',
  memory_grant_private_destination: 'A fact can be shared only into a group or topic, never into a private chat.',
  memory_grant_private_sources: 'This fact comes from a private chat. Confirm you want to share it first.',
  memory_access_private_evidence: 'This fact comes from a private chat, so Nocheh cancelled the request.',
  memory_access_private_destination: 'This request was for a private chat, so Nocheh cancelled it.',
};

export function chatError(error: unknown): string {
  const code = (error as Error)?.message || String(error || 'request_failed');
  if (privateChatErrors[code]) return privateChatErrors[code]!;
  if (/conflict|changed/.test(code)) return 'This changed somewhere else. Reload to see the latest, your text is kept.';
  if (code === 'sharing_source_not_selected')
    return 'One of the chosen messages isn’t from a chat this rule shares from.';
  if (code === 'sharing_rule_limit')
    return 'That goes past a sharing limit: at most ten automatic rules can share into one group, and at most 100 chats into one chat. Turn one off first.';
  if (code === 'project_topic_follows_group')
    return 'A topic always follows its group’s project. Change the group’s project instead.';
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
  const date = sourceDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}
