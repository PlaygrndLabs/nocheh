/**
 * What kind of message Nocheh sent: a neutral class stamped where the send is decided and kept in the delivered
 * message's payload. Replies, follow-ups, private answers, job reports, scheduled results and approved posts are
 * learned like any message; cards, card updates, refusals, notices and reminders are Nocheh's own controls and
 * notices, kept and searchable but never learned. A message with no class is learned, as every one was before.
 */
export const sendClasses=['reply','follow_up','private_answer','job_report','scheduled_run','approved_post',
  'card','card_update','refusal','notice','reminder'] as const;
export type SendClass=typeof sendClasses[number];
/** The classes that are never learned. */
export const unlearnedSendClasses:ReadonlySet<SendClass>=new Set<SendClass>(['card','card_update','refusal','notice','reminder']);
/** The class a stored value names, or null for anything else. */
export const sendClassOf=(value:unknown):SendClass|null=>typeof value==='string'&&(sendClasses as readonly string[]).includes(value)?value as SendClass:null;
/** The archive kinds of messages Nocheh delivered: its words, never a person's. */
export const deliveredKinds:ReadonlySet<string>=new Set(['telegram_delivered_message','browser_delivered_message']);
