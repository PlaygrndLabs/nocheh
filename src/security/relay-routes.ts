/**
 * The data routes the broker relays to storage for a turn's pass: archive and memory reads, the owner's views for the
 * owner's own live turn, task lists, jobs, machine commands, proposals, message requests, member asks and schedules set by
 * asking. Each route keeps its own checks in storage; this list is also every data route a turn's one-time key reaches
 * (key-routes.ts, ADR-0305).
 */
export const relayRoutes:readonly [string,RegExp][]=[
  ['GET',/^\/v1\/(search|archive\/page|imports\/pending|events\/[a-f0-9]{64}|artifacts\/[a-f0-9]{64}\/bytes|memory\/check|memory\/context|memory\/(shared|filtered|grants)\/[a-f0-9]{64}|memory\/learned\/[a-f0-9]{64}\/[1-9][0-9]{0,8}|memory\/notes\/[a-f0-9]{12}|memory\/facts\/[a-f0-9]{64}(?:\/[1-9][0-9]{0,2})?|knowledge\/(context|proposals\/[a-f0-9]{64})|owner\/(conversations|conversation-context|projects|project-assignments|people|telegram-identities|memory-map|tasks(?:\/[a-f0-9]{64})?)|tools\/actions(?:\/[a-f0-9]{64})?|telegram\/destinations|notion\/connections|github\/repos)$/],
  ['POST',/^\/v1\/(context\/prepare|memory\/(recall|longterm\/(recall|context|search))|jobs\/(start|status|stop)|machines\/exec|tools\/propose|knowledge\/proposals|action-requests|member-asks|schedules\/(turn(?:\/definition)?|time-zone)|owner\/tasks(?:\/[a-f0-9]{64}(?:\/comments)?)?)$/],
];
