/**
 * What storage answers the dashboard about where memory came from (ADR-0261 step 4). Types only; the words are
 * storage's, in the owner's own lines (memory.source_texts), and pages add none of their own beyond their headings.
 */

/**
 * An original message: open it by `id` (`label` is who sent what where, `at` when it was sent, `forward` where a
 * forward came from). A retired message reads only `retired` and is never linked. `unavailable` has no id to open:
 * its label says the source isn't recorded or isn't available right now.
 */
export type Original =
  | {id: string; label: string; at: string | null; forward?: string}
  | {retired: true}
  | {unavailable: true; label: string};

/** GET /events/<id>/thread: the message's Thread section. */
export type MessageThread = {
  /** What it replies to; null for no reply, and for a reply to a topic's opening (that is its topic). */
  reply_to: Original | null;
  /** An old Telegram Desktop import's reply into another chat, which keeps no link. */
  reply_in_other_chat?: true;
  /** The messages replying to it: all counted, the first 20 listed. `topic` when it opens a topic, whose replies are
   *  the whole topic and are not listed. `complete: false` when there were more than could be counted. */
  replies: {count: number; items: Original[]; topic?: true; complete?: false};
  /** The forum topic it is in: its chat in your words, its opening when it replies to it, `opens` when it is the opening. */
  topic: {label: string; opens?: true; opening: Original | null} | null;
  /** Where a forward came from, in your words; null when it is no forward. */
  forwarded_from: string | null;
};

/** Whose words a fact rests on: only `owner` means your own typing alone. */
export type FactBy = 'owner' | 'person' | 'forward' | 'file' | 'mixed' | 'nocheh' | 'shared' | 'unknown';
/**
 * Why a facts answer is empty: no long-term memory to read, a memory that can't list facts, a message it never
 * learned, or a read that failed just now (counted on System › Health).
 */
export type FactsReason = 'no_memory' | 'not_supported' | 'not_learned' | 'unavailable';

/** One fact long-term memory learned. */
export type Fact = {
  id: string;
  text: string;
  /** When long-term memory learned it. */
  learned_at: string;
  /** It cites every message it came from, and each is known: the exact badge. */
  exact: boolean;
  /** Learned with other messages: only the batch it came from is known. */
  batch: boolean;
  by: FactBy;
  /** The original its source names first, in your words, and when it was sent; null when none can be linked. */
  label: string | null;
  at: string | null;
  /** Its originals, that one first (at most 5), and how many more it has. */
  originals: Original[];
  more: number;
};

/** GET /events/<id>/learned: the facts that cite this message. `more` when there are more than one page. */
export type LearnedFromMessage = {facts: Fact[]; reason?: FactsReason; more?: true};
/** GET /memory/facts?chat=&person=&after=: newest first, a page at a time (pass `next` as `after`). */
export type FactsPage = {facts: Fact[]; next: string | null; reason?: FactsReason};
/** GET /memory/longterm/coverage: "412 exact · 96 learned with other messages · 7 none". */
export type FactCoverage = {
  coverage: {total: number; exact: number; with_others: number; none: number} | null;
  reason?: FactsReason;
};
/** GET /memory/originals?id=<id>&id=<id> (at most 50): each in the order asked. */
export type Originals = {originals: Original[]};
/** A note on the Notes page (/memory): where it came from, the day it names and the messages its writer read. */
export type NoteEntry = {
  target: string;
  text: string;
  from: string;
  label: string;
  day?: string | null;
  originals?: Original[];
};
