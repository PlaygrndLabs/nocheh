/** Pure helpers for the Chats page: chat names, the chat tree, chat states and plain words for errors. */
import type {ChatApp, ChatAppLabel, ChatKind, ChatState} from '../../src/chat-wire';
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
   * From the chat directory (ADR-0252). The dashboard reads what a chat is from these fields and never works it out
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
  /** The chat's short label (ADR-0254): the one a send card, a notice or a reminder line adds after a name that reads
   * like another's. A hash of the chat's id, so it says nothing of the id. */
  short_id?: string;
  /** A person's public Telegram username, without its @, when the server gives one; checked there by the one username
   * rule (src/chats-telegram.ts). */
  username?: string | null;
  /** Who last added Nocheh to the chat (ADR-0253): you, someone else, someone anonymous, someone Telegram didn't name, or
   * nobody on record (a chat from before step 2b, or one Nocheh only saw). */
  added_by?: 'owner' | 'other' | 'anonymous' | 'unknown' | 'seeded' | null;
  added_at?: string | null;
  /** Whether Telegram told Nocheh that someone removed it from the chat. */
  removed_event?: boolean;
};
export type Directory = {items: Chat[]; next_cursor: string | null; total?: number};
/** A person Nocheh saw in a group: whether they are in it now (null when Telegram never said), whether the group's own
 * messages show them (they wrote there, or a message there says they joined), and whether they are a member. Someone known
 * only from leaving or a member update has `seen` false; so has a member Telegram never showed there. */
export type Person = {
  id: string;
  name?: string | null;
  username?: string | null;
  state?: 'in' | 'left' | null;
  seen?: boolean;
  member?: boolean;
};
/** A group people were seen in: its Nocheh chat id and its current Telegram id. */
export type IdentityGroup = {id: string; external?: string | null; name?: string | null; users?: Person[]};
/** Looks a chat up by its Nocheh id in the chat directory; null when no chat has that id. */
export type FindChat = (space: string | null | undefined) => Chat | null;

/** A Telegram user ID, typed by the owner to add a member by it. Not a chat id; the server checks it again. */
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
 * the directory doesn't know included, counts as private, as the server's chat directory does (ADR-0242, ADR-0252).
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

/**
 * '…' and the short id after a group's or a person's name, the same one a send card, a notice or a reminder line adds to
 * tell apart names that read alike (ADR-0254), so the owner can check which chat a card means. A topic's card names its
 * group's, and the owner's own chat needs none: null for those and for a chat without one.
 */
export function shortIdLabel(chat: Chat | null | undefined): string | null {
  if (!chat?.short_id || chat.owner || (chat.kind !== 'group' && chat.kind !== 'private')) return null;
  return '…' + chat.short_id;
}

/** A person's public Telegram profile, as a send card links it: '@username' and its t.me address. Null for any other
 * chat and for a person with no username. */
export function telegramProfile(chat: Chat | null | undefined): {handle: string; href: string} | null {
  const name = chat?.kind === 'private' && !chat.owner ? chat.username?.trim() : null;
  return name ? {handle: '@' + name, href: 'https://t.me/' + encodeURIComponent(name)} : null;
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

/** Whether Nocheh answers in a chat now: its state, which a topic takes from its group, is active (ADR-0253). */
export const isOn = (chat: Chat | null | undefined): boolean => chat?.state === 'active';
/** Where Nocheh stands in a group, in a word or two, as the chat list and the group's page show it (ADR-0253). */
export const chatStateLabels: Record<ChatState, string> = {
  active: 'On',
  off: 'Off',
  pending: 'Leaving',
  left: 'Left',
  removed: 'Removed',
  could_not_leave: 'Couldn’t leave',
  archived: 'Imported history',
};
/**
 * Only the owner adds Nocheh to a group (ADR-0253), so only a group Nocheh is in has a switch: one that is on, off, or
 * that someone else added and Nocheh couldn't leave. One it left, was removed from or knows only from imported history
 * has none: the owner adds Nocheh there in Telegram.
 */
export const switchable = (chat: Chat | null | undefined): boolean =>
  chat?.kind === 'group' && (chat.state === 'active' || chat.state === 'off' || chat.state === 'could_not_leave');
/**
 * What a group's state means, for its page. A group the seeder made (from before step 2b, or from imported history)
 * has no add or removal on record, so its text claims neither. Telegram hides who added Nocheh when an admin adds it
 * with Remain anonymous on, which may be the owner, so that add never says someone else.
 */
export function chatStateText(chat: Chat): string {
  const hidden = chat.added_by === 'anonymous';
  switch (chat.state) {
    case 'active':
      return 'You can always talk to it here.';
    case 'pending':
      return hidden
        ? 'Someone added Nocheh here without showing who, so it is leaving.'
        : 'Someone else added Nocheh here, so it is leaving.';
    case 'left':
      return hidden
        ? 'Nocheh left because someone added it without showing who. To use it here, turn off Remain anonymous and add Nocheh yourself.'
        : chat.added_by === 'other'
          ? 'Nocheh left because someone else added it. Add Nocheh yourself to use it here.'
          : 'Nocheh isn’t in this group any more.';
    case 'removed':
      return chat.removed_event ? 'Nocheh was removed from this group.' : 'Nocheh isn’t in this group any more.';
    case 'could_not_leave':
      return hidden
        ? 'Someone added Nocheh here without showing who, and it couldn’t leave. It stays silent.'
        : 'Someone else added Nocheh here and it couldn’t leave. It stays silent.';
    case 'archived':
      return 'From your imported history. Nocheh isn’t in this group.';
    default:
      return 'Nocheh doesn’t answer here.';
  }
}
export type ChatTree = {
  privates: Chat[];
  groups: {group: Chat; topics: Chat[]}[];
};

/**
 * Private chats (yours first), then groups (Nocheh-on first) with their topics under them. Groups people were seen
 * in appear even before the directory lists them.
 */
export function chatTree(items: Chat[], extraGroups: {id: string; name?: string | null}[], query: string): ChatTree {
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
    .sort(
      (a, b) => Number(isOn(b.group)) - Number(isOn(a.group)) || chatName(a.group).localeCompare(chatName(b.group)),
    );
  return {privates, groups};
}

/**
 * The search hits a sharing rule may use: those whose chat is a source's group or one of its topics, as a topic
 * source reads its whole group. A hit names its chat by chat_id (ADR-0252), never by the archive's raw scope; a hit
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
  if (code === 'chat_not_joined') return 'Nocheh isn’t in this group any more. Add it in Telegram first.';
  if (code === 'chat_not_group') return 'Only a group has a switch.';
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
