/** The Members routes as the dashboard reads them, shared by the Members page and a group's "Members here" card. */
import {useMemo} from 'react';
import type {MemberList} from '../../../src/member-wire';
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import type {IdentityGroup, Person} from '../../lib/chats-model';
import {knownPeople, localLawsLine, type PromptTexts} from './model';

/** Every member, the people seen in Nocheh's groups who are not members, the groups Nocheh is in and the daily cap. */
export const useMembers = () => useResource<MemberList>('/members', 30000);

/** Telegram's names for people by Telegram user ID, for a member or person whose account has no name yet. */
export function useKnownPeople(): ReadonlyMap<string, Person> {
  const identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities', 60000);
  return useMemo(() => knownPeople(identities.data?.groups ?? []), [identities.data]);
}

/** A member's page, and the add flow, started with a person Nocheh has seen when one is given. */
export const memberHref = (id: string) => href('members', {member: id});
export const addMemberHref = (account: string | null = null) => href('members', {add: account ?? 'new'});

/** The owner-only line about local laws on reading members' private chats, from the editable texts (Settings › Assistant). */
export function useLocalLaws(): string | null {
  const prompts = useResource<PromptTexts>('/prompts', 300000);
  return localLawsLine(prompts.data);
}
