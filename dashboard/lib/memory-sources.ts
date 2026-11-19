/**
 * What storage answers the dashboard about where memory came from (ADR-0261 step 4). The words about a message are
 * storage's, in the owner's own lines (memory.source_texts); pages add only their headings and badges (below).
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

/*
 * The few words pages add to storage's own (ADR-0261 step 4): badge and section words, and how the Thread section
 * reads. Pure, so the dashboard tests check them without a browser.
 */

/** The most originals one lookup names (storage's limit), and how many lookups a page makes at most. */
export const ORIGINALS_PER_LOOKUP = 50;
export const ORIGINAL_LOOKUPS = 4;
const fullId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** The ids a page asks names for: whole message ids only, each once, in the order shown, in lookups of 50. */
export function originalLookups(ids: readonly (string | null | undefined)[]): string[] {
  const wanted = [...new Set(ids.filter(fullId))].slice(0, ORIGINALS_PER_LOOKUP * ORIGINAL_LOOKUPS);
  const paths: string[] = [];
  for (let start = 0; start < wanted.length; start += ORIGINALS_PER_LOOKUP)
    paths.push(
      '/memory/originals?' +
        wanted
          .slice(start, start + ORIGINALS_PER_LOOKUP)
          .map(id => 'id=' + id)
          .join('&'),
    );
  return paths;
}
/** Each lookup's answers by the id asked, in the order asked. */
export function originalsById(paths: readonly string[], answers: readonly (Originals | null)[]): Map<string, Original> {
  const found = new Map<string, Original>();
  paths.forEach((path, index) => {
    const asked = new URLSearchParams(path.slice(path.indexOf('?') + 1)).getAll('id');
    const answer = answers[index]?.originals;
    if (Array.isArray(answer) && answer.length === asked.length)
      asked.forEach((id, at) => answer[at] && found.set(id, answer[at]!));
  });
  return found;
}

/** What one original shows: a link to it, a retired message (never linked), or why there is none to open. */
export type OriginalView =
  {link: string; label: string; at: string | null} | {text: 'Retired message'} | {text: string; unavailable: true};
export function originalView(original: Original): OriginalView {
  if ('retired' in original) return {text: 'Retired message'};
  if ('unavailable' in original) return {text: original.label, unavailable: true};
  return {link: original.id, label: original.label, at: original.at};
}

/** The coverage line: "412 exact · 96 learned with other messages · 7 none". */
export function coverageLine(coverage: NonNullable<FactCoverage['coverage']>, locale?: string): string {
  const number = (value: number) => value.toLocaleString(locale);
  return `${number(coverage.exact)} exact · ${number(coverage.with_others)} learned with other messages · ${number(coverage.none)} none`;
}

/** A fact's source badge: exact when it cites every message it came from, else learned with other messages. */
export function factBadge(fact: Pick<Fact, 'exact' | 'batch'>): {label: string; tone: 'good' | 'neutral'} | null {
  if (fact.exact) return {label: 'Exact source', tone: 'good'};
  if (fact.batch) return {label: 'Learned with other messages', tone: 'neutral'};
  return null;
}

/** Why a list of facts is empty, in plain words. */
export function factsReasonText(reason: FactsReason | undefined, where: 'message' | 'list'): string {
  if (reason === 'no_memory') return 'Long-term memory hasn’t learned anything yet.';
  if (reason === 'not_supported') return 'The memory engine in use can’t list what it learned.';
  if (reason === 'not_learned') return 'Long-term memory hasn’t learned from this message.';
  if (reason === 'unavailable') return 'Long-term memory can’t be reached right now. Try again in a minute.';
  return where === 'message' ? 'No fact in long-term memory comes from this message now.' : 'No facts here yet.';
}

/** One line of a message's Thread section. */
export type ThreadRow =
  | {kind: 'reply_to'; heading: 'Replies to'; original: Original}
  | {kind: 'reply_elsewhere'; heading: 'Replies to'; text: string}
  | {kind: 'topic'; heading: 'Topic'; label: string; opens: boolean; opening: Original | null}
  | {kind: 'forward'; heading: 'Forwarded from'; text: string}
  | {kind: 'replies'; heading: string; items: Original[]; more: number};

/**
 * The Thread section's lines, in order: what it replies to, the topic it is in, where a forward came from, and the
 * messages replying to it. A message replying to its topic's opening shows only its Topic (storage gives no
 * `reply_to` for it), and a topic's opening lists no replies, since they are the whole topic.
 */
export function threadRows(thread: MessageThread): ThreadRow[] {
  const rows: ThreadRow[] = [];
  if (thread.reply_to) rows.push({kind: 'reply_to', heading: 'Replies to', original: thread.reply_to});
  else if (thread.reply_in_other_chat)
    rows.push({
      kind: 'reply_elsewhere',
      heading: 'Replies to',
      text: 'A message in another chat (an old import keeps no link to it)',
    });
  if (thread.topic)
    rows.push({
      kind: 'topic',
      heading: 'Topic',
      label: thread.topic.label,
      opens: !!thread.topic.opens,
      opening: thread.topic.opening,
    });
  if (thread.forwarded_from) rows.push({kind: 'forward', heading: 'Forwarded from', text: thread.forwarded_from});
  const replies = thread.replies;
  if (!replies.topic && replies.count > 0)
    rows.push({
      kind: 'replies',
      heading: `Replies (${replies.count.toLocaleString()}${replies.complete === false ? '+' : ''})`,
      items: replies.items,
      more: Math.max(0, replies.count - replies.items.length),
    });
  return rows;
}

/** A note's day ("2026-11-19", in your time zone) as a short date. */
export function noteDayText(day: string | null | undefined, locale?: string): string | null {
  const match = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
