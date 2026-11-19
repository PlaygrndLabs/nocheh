// The Notes page's list of chat profiles, kept apart from the page so it can be tested on its own.

export type Profile = {
  scope: string;
  profile: string;
  owner?: boolean;
  revision?: number;
  private_answer?: boolean;
  /** Where a private answer was asked, as its first line names it, and when it ran (ADR-0249). */
  answer_group?: string;
  answer_at?: string;
  /** A member's own private chat with Nocheh (step 4): its scope is that chat. Never the owner's. */
  member?: boolean;
  /** Your question about a member, answered from their private chat in your chat (step 4b): its own profile, never
   * carried into your conversation. */
  member_read?: boolean;
  /** Whether the profile is on disk, its setup (guard epoch), and whether it is the newest setup of its chat, the one its
   * turns use now; a chat keeps one profile per setup, so after a reinstall it is listed more than once. */
  exists?: boolean;
  guard_epoch?: number;
  latest?: boolean;
};

/**
 * The Notes page's chats in the order shown: your own chats and groups first, then your questions about a member, then
 * members' chats. A chat listed more than once (one per setup) shows its current notes first, its earlier ones after,
 * oldest first, then the rest of that chat (private answers) as listed; one that was never written (not on disk) is left
 * out when the chat has notes from another setup. The page opens on your private chat's current notes.
 */
export function notesProfiles(listed: Profile[]): {list: Profile[]; first: Profile | null} {
  const usable = listed.filter(
    p => p.exists !== false || !listed.some(q => q !== p && q.scope === p.scope && q.latest),
  );
  const seen = new Map<string, number>();
  usable.forEach((p, i) => seen.has(p.scope) || seen.set(p.scope, i));
  const order = (p: Profile) => (p.member ? 2 : p.member_read ? 1 : 0);
  const list = usable
    .map((p, i) => ({p, i}))
    .sort(
      (a, b) =>
        order(a.p) - order(b.p) ||
        seen.get(a.p.scope)! - seen.get(b.p.scope)! ||
        Number(b.p.latest === true) - Number(a.p.latest === true) ||
        Number(a.p.latest !== false) - Number(b.p.latest !== false) ||
        (a.p.latest === false ? (a.p.guard_epoch ?? 0) - (b.p.guard_epoch ?? 0) : 0) ||
        a.i - b.i,
    )
    .map(({p}) => p);
  return {list, first: list.find(p => p.owner && p.latest) ?? list[0] ?? null};
}

/** An earlier setup's notes for a chat listed more than once, numbered oldest first: " · earlier notes 1". */
export function earlierSuffix(p: Profile, list: Profile[]): string {
  if (p.latest !== false || p.private_answer || p.member_read) return '';
  const earlier = list.filter(q => q.scope === p.scope && q.latest === false && !q.private_answer && !q.member_read);
  return earlier.length > 1 ? ' · earlier notes ' + (earlier.indexOf(p) + 1) : ' · earlier notes';
}
