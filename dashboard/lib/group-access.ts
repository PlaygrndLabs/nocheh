export type ParticipantRule = {granted?: string[]; denied?: string[]} | null | undefined;

/** Effective group access is binary even though saved policy keeps an explicit deny. */
export function participantAllowed(rule: ParticipantRule, id: string): boolean {
  return !!rule?.granted?.includes(id) && !rule?.denied?.includes(id);
}

/** Restore the saved decision when a switch returns to its original value. */
export function switchDecision(
  savedRule: ParticipantRule,
  currentRule: ParticipantRule,
  id: string,
  allow: boolean,
): 'grant' | 'deny' | 'default' | null {
  if (participantAllowed(currentRule, id) === allow) return null;
  if (allow) return 'grant';
  return savedRule?.granted?.includes(id) || savedRule?.denied?.includes(id) ? 'deny' : 'default';
}
