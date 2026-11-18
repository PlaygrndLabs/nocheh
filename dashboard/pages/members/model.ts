/**
 * Pure helpers for the Members page and a group's "Members here" card (step 3): names, group counts, what a member may do
 * in one group, and the groups an add sends. Nothing here reads a chat's or a person's id for its meaning.
 */
import type {
  MemberGroup,
  MemberItem,
  MemberList,
  MemberPerson,
  MemberPresence,
  MemberRemoved,
  MemberResult,
  MemberSettingsResult,
} from '../../../src/member-wire';
import {chatError, type IdentityGroup, type Person} from '../../lib/chats-model';

type Named = {name: string | null; username: string | null; telegram_id: string | null};
type Tone = 'neutral' | 'good' | 'warn' | 'info';

/** '@name' for a Telegram username kept with or without its @; null for none. */
export function handle(username: string | null | undefined): string | null {
  const name = username?.trim().replace(/^@/, '');
  return name ? '@' + name : null;
}

/**
 * Who Telegram showed in Nocheh's groups, by Telegram user ID, from /telegram/identities. It lists members too, those
 * Nocheh never saw write included (one carried from the lists before step 3, or added by Telegram user ID), named by
 * Telegram, so a member whose account has no name yet still shows by name. A named entry wins over a nameless one.
 */
export function knownPeople(groups: readonly IdentityGroup[]): Map<string, Person> {
  const known = new Map<string, Person>();
  for (const user of groups.flatMap(group => group.users ?? [])) {
    const had = known.get(user.id);
    known.set(user.id, {
      ...user,
      name: had?.name || user.name || null,
      username: had?.username || user.username || null,
    });
  }
  return known;
}

/** A member's or a person's name: their own, else the one Telegram showed, else their @username, else their ID. */
export function personName(person: Named, known?: ReadonlyMap<string, Person>): string {
  const found = person.telegram_id ? known?.get(person.telegram_id) : undefined;
  return (
    person.name?.trim() ||
    found?.name?.trim() ||
    handle(person.username) ||
    handle(found?.username) ||
    (person.telegram_id ? 'Telegram ID ' + person.telegram_id : 'Unknown person')
  );
}

/** "@mira · ID 73": the @username when the name isn't already it, and the Telegram user ID. */
export function personMeta(person: Named, known?: ReadonlyMap<string, Person>): string {
  const found = person.telegram_id ? known?.get(person.telegram_id) : undefined;
  const name = handle(person.username) ?? handle(found?.username);
  return [
    name && name !== personName(person, known) ? name : null,
    person.telegram_id ? 'ID ' + person.telegram_id : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Members and people by name, then by id, so the list keeps its order between loads. */
export function byName<T extends Named & {account_id: string}>(known?: ReadonlyMap<string, Person>) {
  return (a: T, b: T) =>
    personName(a, known).localeCompare(personName(b, known)) || (a.account_id < b.account_id ? -1 : 1);
}

/** What Telegram last said of a member in a group, as the Members page shows it. */
export function presenceLabel(telegram: MemberPresence | null): [string, Tone] {
  if (telegram === 'in') return ['Seen here', 'good'];
  if (telegram === 'left') return ['Left the group (Telegram says)', 'warn'];
  return ['Nothing from Telegram yet', 'neutral'];
}

/** How many of a member's groups are on, of how many listed, and how many are new (Telegram shows them, no switch yet). */
export function groupCounts(member: Pick<MemberItem, 'groups'>): {on: number; total: number; fresh: number} {
  return {
    on: member.groups.filter(group => group.on).length,
    total: member.groups.length,
    fresh: member.groups.filter(group => group.new).length,
  };
}

/** "2 of 3 groups on · 1 new here", for the list. */
export function groupSummary(member: Pick<MemberItem, 'groups'>): string {
  const {on, total, fresh} = groupCounts(member);
  return [`${on} of ${total} ${total === 1 ? 'group' : 'groups'} on`, fresh ? `${fresh} new here` : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What a member may do in one group, as its "Members here" card says it: gone from the group by Telegram's word, paused
 * everywhere, talk switched off for every group, or this group's switch. A group with no switch yet is on (a member is
 * allowed by default in the groups they are in), so "New here" is information only. Null when the member has no switch
 * there and Telegram never showed them there.
 */
export function memberHere(member: MemberItem, chat: string): {label: string; tone: Tone; group: MemberGroup} | null {
  const group = member.groups.find(item => item.chat_id === chat);
  if (!group) return null;
  if (group.telegram === 'left') return {label: 'Left the group', tone: 'neutral', group};
  if (member.state === 'paused') return {label: 'Paused', tone: 'warn', group};
  if (!member.permissions.talk) return {label: 'Talk switched off', tone: 'neutral', group};
  return group.on ? {label: 'Can talk here', tone: 'good', group} : {label: 'Off here', tone: 'neutral', group};
}

/**
 * The members and the people who are not members that a group's card lists. A member is there when Telegram shows them in
 * the group, or when their switch there is on and Telegram never said they left: a switched-off group Telegram never
 * showed them in (one the lists before step 3 carried, or one left unticked on an add) is not theirs to list.
 */
export function inGroup(
  list: MemberList | null | undefined,
  chat: string,
): {members: MemberItem[]; people: MemberPerson[]} {
  const here = (group: MemberGroup) =>
    group.chat_id === chat && (group.telegram === 'in' || (group.on && group.telegram !== 'left'));
  return {
    members: (list?.members ?? []).filter(member => member.groups.some(here)),
    people: (list?.people ?? []).filter(person => person.groups.some(group => group.chat_id === chat)),
  };
}

/** What the Members routes answer a change with: the member after an add or a change, a removal, or the daily cap. */
export type MemberAnswer = MemberResult | MemberRemoved | MemberSettingsResult;

/**
 * The member list with the answers to the owner's changes that it does not show yet. An answer with a newer member
 * revision than the list's is laid over it, oldest first, so a member just added, a switch just saved or a new daily cap
 * shows at once, not the list from before the change while it reloads, or until the next poll when the reload fails.
 */
export function withAnswers(list: MemberList | null, answers: readonly MemberAnswer[]): MemberList | null {
  if (!list) return list;
  const newer = answers.filter(answer => answer.revision > list.revision).sort((a, b) => a.revision - b.revision);
  return newer.reduce<MemberList>((next, answer) => {
    if ('member' in answer) {
      const {member} = answer;
      return {
        ...next,
        members: next.members.some(item => item.id === member.id)
          ? next.members.map(item => (item.id === member.id ? member : item))
          : [...next.members, member],
        people: next.people.filter(person => person.account_id !== member.account_id),
      };
    }
    if ('removed' in answer) return {...next, members: next.members.filter(item => item.id !== answer.removed)};
    return {...next, daily_messages: answer.daily_messages};
  }, list);
}

/**
 * The groups an add sends: every group the owner saw, ticked on and unticked off. A member's group with no switch counts
 * as on, so a group the owner left unticked has to be sent as off to stay off.
 */
export function addGroups(shown: readonly string[], ticked: ReadonlySet<string>): Record<string, boolean> {
  return Object.fromEntries(shown.map(chat => [chat, ticked.has(chat)]));
}

const memberErrors: Record<string, string> = {
  member_not_found: 'This member was removed somewhere else. Reload to see the latest.',
  member_account_not_found:
    'Nocheh hasn’t seen this person in your groups. Add them by their Telegram user ID instead.',
  member_account_invalid:
    'That account can’t be a member: it is you, a bot, or Telegram’s stand-in for a channel or an anonymous admin.',
  member_exists: 'This person is already a member.',
  member_group_invalid: 'Nocheh isn’t in one of those groups any more. Reload and choose again.',
  member_group_not_seen:
    'Telegram hasn’t shown this person in that group yet. You can switch it on once they write there.',
  member_group_required: 'Tick at least one group.',
  invalid_daily_messages: 'Choose a whole number from 1 to 10,000.',
  not_implemented: 'Members aren’t available on this installation yet.',
};

/** Plain words for a refusal from the Members routes; anything else as the Chats page says it. */
export function memberError(error: unknown): string {
  const code = (error as Error)?.message || '';
  return memberErrors[code] ?? chatError(error);
}
