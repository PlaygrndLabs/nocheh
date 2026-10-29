/** Plain-language labels for kept messages, their reply state and import jobs. Pure functions only. */
import {sourceContentLabel, sourceContentTypes} from '../../src/source-content';
import type {Tone} from '../ui/core';

export type ReplyPreview = {id: string; text: string | null; received_at: string; content_types?: string[]};
export type ActionReview = {id: string; state: string; count: number};
export type MessageRow = {
  id?: string;
  event_id?: string;
  derived_id?: string | null;
  channel?: string;
  scope: string;
  kind?: string;
  text?: string | null;
  snippet?: string;
  preview?: string;
  received_at?: string;
  occurred_at?: string;
  content_types?: string[];
  transcript_preview?: string | null;
  reaction_preview?: {change: string; actor: string | null; target: string} | null;
  assistant_state?: string | null;
  assistant_stage?: string | null;
  assistant_error?: string | null;
  assistant_attempts?: number | null;
  retired?: boolean;
  live_copy?: boolean;
  reply_messages?: ReplyPreview[];
  action_review?: ActionReview;
  sender?: {name: string | null; username: string | null; id: string | null} | null;
  agent_copy?: {state: 'none' | 'pending' | 'ready'; revision: number | null};
};

/** The writer's name for a list row, or null for assistant replies and unknown senders. */
export const rowSender = (row: MessageRow): string | null =>
  row.sender?.name || (row.sender?.username ? '@' + row.sender.username : null);
export type MessageList = {records?: MessageRow[]; results?: MessageRow[]; items?: MessageRow[]; next?: string | null};

/** The voice-note note written when transcription is not available; shown as a plain state, not a transcript. */
export const VOICE_ARCHIVED = 'Voice note archived; transcription is not available.';
const SPEECH = ['voice', 'audio', 'video_note'];

export const rowId = (row: MessageRow) => row.event_id || row.id || '';
export const isAssistant = (kind?: string) => !!kind?.endsWith('_delivered_message');
export const isIncoming = (kind?: string) => kind === 'telegram_update' || kind === 'browser_input';
export const hasSpeech = (types: string[] = []) => types.some(type => SPEECH.includes(type));

export function rows(data: MessageList | MessageRow[] | null | undefined): MessageRow[] {
  const list = Array.isArray(data) ? data : data?.records || data?.results || data?.items || [];
  return list.filter(row => !row.derived_id);
}

export function contentText(types: string[] = []): string {
  return types.map(sourceContentLabel).join(' · ');
}

/** What to show for a message in a list: its words, else what it contains. */
export function messageText(row: {
  text?: string | null;
  snippet?: string;
  preview?: string;
  content_types?: string[];
}): string {
  const words = [row.text, row.snippet, row.preview].find(value => value?.trim())?.trim();
  return words || contentText(row.content_types) || 'Message without text';
}

export function reactionText(row: MessageRow): string | null {
  const reaction = row.reaction_preview;
  if (!reaction) return null;
  return [
    reaction.actor ? `${reaction.actor}: ${reaction.change}` : reaction.change,
    `on message #${reaction.target}`,
  ].join(' ');
}

/** Who wrote a message, from the original Telegram payload when it says. */
export function senderName(payload: any, kind?: string): string | null {
  if (isAssistant(kind)) return 'Assistant';
  if (kind === 'browser_input') return 'You, in the browser';
  const message = telegramMessage(payload);
  const from = message?.from ?? payload?.message_reaction?.user;
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || (from.username ? '@' + from.username : null);
}

export function telegramMessage(payload: any): any {
  return payload?.message || payload?.edited_message || payload?.channel_post || payload?.edited_channel_post || null;
}

/** A one-line summary of structured content (contact, place, poll…) that has no text. */
export function structuredSummary(payload: any): string | null {
  const message = telegramMessage(payload) || {};
  if (message.contact)
    return [message.contact.first_name, message.contact.last_name, message.contact.phone_number]
      .filter(Boolean)
      .join(' · ');
  if (message.venue) return [message.venue.title, message.venue.address].filter(Boolean).join(' · ');
  if (message.location)
    return [message.location.latitude, message.location.longitude].filter(value => value !== undefined).join(', ');
  if (message.poll) return message.poll.question ?? null;
  if (message.dice) return [message.dice.emoji, message.dice.value].join(' · ');
  return message.game?.title ?? null;
}

export function originalTypes(record: any): string[] {
  return sourceContentTypes(
    record?.event?.kind ?? '',
    record?.event?.payload,
    (record?.artifacts ?? []).map((file: any) => file.kind),
  );
}

export type Status = {label: string; tone: Tone; note?: string};

/**
 * The reply state of an incoming message, or the delivery of an assistant message.
 * Each closed outcome names its cause: a rejected or unrecognised reply is never
 * described as one that wasn't needed, and nothing here is an approval.
 */
export function replyStatus(row: MessageRow): Status | null {
  if (isAssistant(row.kind)) return {label: 'Delivered', tone: 'good'};
  if (row.kind !== 'telegram_update' || row.reaction_preview) return null;
  const state = row.assistant_state || '';
  if (state === 'suppressed') {
    if (row.assistant_error === 'telegram_rejected')
      return {label: 'Rejected by Telegram', tone: 'bad', note: 'Not retried automatically'};
    if (row.assistant_error === 'invalid_transcription_response')
      return {label: 'Speech not recognized', tone: 'bad', note: 'Original audio is kept'};
    if (hasSpeech(row.content_types) && !row.transcript_preview)
      return {label: 'Archived without transcription', tone: 'neutral', note: 'Original audio is kept'};
    if (row.assistant_error === 'not_addressed') return {label: 'Not addressed to the assistant', tone: 'neutral'};
    if (row.assistant_error === 'not_allowed')
      return {label: 'Not allowed', tone: 'neutral', note: 'Sender may not use Nocheh here'};
    if (row.assistant_error === 'album_member') return {label: 'Answered with its album', tone: 'neutral'};
    if (row.assistant_error === 'approval_button') return {label: 'Approve or Reject button pressed', tone: 'neutral'};
    return {label: 'No reply needed', tone: 'neutral'};
  }
  const states: Record<string, Status> = {
    done: {label: 'Replied', tone: 'good'},
    running: {label: 'Writing a reply', tone: 'info'},
    pending: {label: 'Waiting to reply', tone: 'info'},
    failed: {label: 'Retry scheduled', tone: 'warn', note: 'Will try again automatically'},
    ambiguous: {label: 'Delivery uncertain', tone: 'warn', note: 'Not retried automatically'},
    cancelled: {label: 'Cancelled', tone: 'neutral'},
  };
  return states[state] ?? {label: 'Not queued', tone: 'neutral'};
}

const actionStates: Record<string, Status> = {
  proposed: {label: 'Action waiting for you', tone: 'warn'},
  approved: {label: 'Action approved, sending', tone: 'info'},
  running: {label: 'Action sending', tone: 'info'},
  ambiguous: {label: 'Action result uncertain', tone: 'warn'},
  done: {label: 'Action done', tone: 'good'},
  rejected: {label: 'Action denied', tone: 'neutral'},
  cancelled: {label: 'Action cancelled', tone: 'neutral'},
};
export const actionStatus = (review: ActionReview): Status =>
  actionStates[review.state] ?? {label: 'Action ' + review.state.replaceAll('_', ' '), tone: 'neutral'};

/** Reply-state filter values the server accepts, with owner-facing names. */
export const replyFilters: {value: string; label: string}[] = [
  {value: '', label: 'Any reply state'},
  {value: 'approval_pending', label: 'Action waiting for you'},
  {value: 'pending', label: 'Waiting to reply'},
  {value: 'running', label: 'Writing a reply'},
  {value: 'failed', label: 'Retry scheduled'},
  {value: 'ambiguous', label: 'Delivery uncertain'},
  {value: 'done', label: 'Replied'},
  {value: 'suppressed', label: 'Closed without a reply'},
  {value: 'cancelled', label: 'Cancelled'},
  {value: 'not_started', label: 'Not queued'},
];

/** Telegram send times arrive as Unix seconds; stored times as ISO text. */
export function sourceDate(value?: string | null): Date {
  return new Date(/^\d+$/.test(value ?? '') ? Number(value) * 1000 : (value ?? NaN));
}

export function when(value?: string | null): string {
  if (!value) return '';
  const date = sourceDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(date.getFullYear() !== today.getFullYear() ? {year: 'numeric'} : {}),
      });
}
export function fullTime(value?: string | null): string {
  const date = sourceDate(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
}

export function duration(seconds: unknown): string | null {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
}

export function decode(value?: string | null): string {
  if (!value) return '';
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), character => character.charCodeAt(0)));
  } catch {
    return '';
  }
}

/** Replaces repeated copies of the old text inside the copy's other fields, never touching the original. */
export function replaceRepeated(value: any, previous: string | null, next: string): any {
  if (typeof value === 'string') return previous !== null && value === previous ? next : value;
  if (Array.isArray(value)) return value.map(item => replaceRepeated(item, previous, next));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRepeated(item, previous, next)]));
  return value;
}

/** Owner-facing sentence for an API error code. */
export function problemText(error: unknown): string {
  const code = String((error as Error)?.message ?? error ?? '');
  if (/conflict|changed/.test(code) && !code.startsWith('resume_'))
    return 'This changed somewhere else. Reload to see the latest, your text is kept.';
  const known: Record<string, string> = {
    resume_scope_cannot_change: 'Chat choices can’t change when an import resumes.',
    resume_review_approval_cannot_change: 'The learning choice can’t change when an import resumes.',
    job_not_ready: 'This import can’t start right now. Refresh to see its state.',
    job_not_cancellable: 'This import isn’t running any more.',
    preview_closed: 'This upload was already checked. Start a new import instead.',
    upload_closed: 'This upload is closed. Start a new import instead.',
    upload_size_limit: 'A file is too big. Limits: 256 MB for a ZIP, 50 MB per file, 512 MB in total.',
    duplicate_upload: 'The same file was chosen twice.',
    unsafe_upload_path: 'A file name isn’t allowed. Re-export from Telegram and try again.',
    select_one_telegram_export: 'Choose exactly one Telegram export (one result.json).',
    export_json_exceeds_128_mib: 'The export’s result.json is bigger than 128 MB.',
    expected_telegram_desktop_json: 'This isn’t a Telegram Desktop JSON export.',
    empty_export: 'The export has no chats in it.',
    attachment_exceeds_50_mib: 'A file in the export is bigger than 50 MB.',
    import_admission_unavailable: 'Background work isn’t available right now. Try again in a minute.',
    wait_for_active_jobs: 'Another task is running. Try again when it finishes.',
    telegram_message_not_found: 'This message can’t be hidden: it isn’t a Telegram message.',
    owner_required: 'Only the owner can do this.',
    guard_change_required: 'Change the text before saving.',
    guard_edit_too_large: 'The text is too long to save.',
    file_reference_conflict: 'The file changed. Reload and try again.',
    request_failed: 'The request failed. Try again.',
  };
  if (known[code]) return known[code]!;
  if (/pending|busy/.test(code)) return 'Something is still in progress. Try again in a moment.';
  if (error instanceof SyntaxError || code === 'Failed to fetch') return 'Nocheh couldn’t be reached. Try again.';
  if (/\s/.test(code)) return code;
  return code ? `It didn’t work (${code.replaceAll('_', ' ')}). Try again.` : 'It didn’t work. Try again.';
}

/** A unique id for an owner action, reused when the same request is retried. */
export function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0'));
  return [bytes.slice(0, 4), bytes.slice(4, 6), bytes.slice(6, 8), bytes.slice(8, 10), bytes.slice(10)]
    .map(part => part.join(''))
    .join('-');
}

export type ImportJob = {
  id: string;
  kind: string;
  state: string;
  created_at: string;
  completed: number;
  duplicates: number;
  files?: number;
  preview?: {
    messages: number;
    supplied_files: number;
    missing_files: number;
    chats: {
      id: string;
      name: string;
      messages: number;
      type?: string;
      topics?: number;
      first_at?: string | null;
      last_at?: string | null;
    }[];
    first_at?: string | null;
    last_at?: string | null;
    /** A rough cost of the secret check, which always runs at import; null when it couldn't be worked out. */
    secret_check?: {cost_usd: number | null; calls: number} | null;
    /** Voice notes in the export: transcribed at import when a voice provider has a key. */
    voice?: {configured: boolean; notes: number; minutes: number; cost_usd: number | null; model?: string} | null;
    /** A rough cost to learn these messages; null when it couldn't be worked out. */
    learning?: {
      cost_usd: number | null;
      parts: {part: string; label: string; cost_usd: number | null; measured: boolean}[];
    } | null;
  };
  mapping?: Record<string, string>;
  review_approved?: boolean;
  error?: string;
  /** After the messages are written: how many are read and checked for secrets. */
  prepared?: {total: number; ready: number; failed: number; files: number; checking: number} | null;
  /** When every message was prepared, so the chat can be asked about. */
  prepared_at?: string | null;
};

const desktopChannelTypes = new Set(['private_supergroup', 'public_supergroup', 'private_channel', 'public_channel']);

/**
 * The live group an exported supergroup or channel is, when Nocheh already knows it. Only that
 * mapping lets messages the bot already saved count as duplicates instead of a second copy.
 */
export function matchingGroup(chat: {id: string; type?: string}, groups: string[]): string | null {
  if (!chat.type || !desktopChannelTypes.has(chat.type) || !/^[1-9][0-9]{0,15}$/.test(chat.id)) return null;
  return groups.includes('-100' + chat.id) ? '-100' + chat.id : null;
}

/** “3 Mar 2021 – 9 Oct 2026” for an export's first and last message, or null when undated. */
export function dateSpan(first?: string | null, last?: string | null): string | null {
  if (!first || !last) return null;
  const day = (value: string) => new Date(value).toLocaleDateString(undefined, {dateStyle: 'medium'});
  return day(first) === day(last) ? day(first) : `${day(first)} – ${day(last)}`;
}

export function importStatus(job: ImportJob): Status {
  const states: Record<string, Status> = {
    uploading: {label: 'Upload not finished', tone: 'neutral'},
    preview_failed: {label: 'Couldn’t read the export', tone: 'bad'},
    ready: {label: 'Ready to start', tone: 'warn'},
    running: {label: 'Importing', tone: 'info'},
    complete: {label: 'Done', tone: 'good'},
    failed: {label: 'Failed', tone: 'bad'},
    cancelled: {label: 'Stopped', tone: 'neutral'},
    interrupted: {label: 'Interrupted', tone: 'warn'},
  };
  if (job.state === 'complete' && !job.prepared_at && job.prepared) return {label: 'Preparing', tone: 'info'};
  return states[job.state] ?? {label: job.state.replaceAll('_', ' '), tone: 'neutral'};
}
const dollars = (value: number) => '$' + (value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString('en-US'));
/** The secret check's cost line; it runs at every import. */
export function secretCheckCostLabel(check: NonNullable<ImportJob['preview']>['secret_check']): string {
  if (!check || check.cost_usd === null) return 'No cost estimate for the secret check right now.';
  return `Estimated secret check cost: about ${dollars(check.cost_usd)}.`;
}
/** The voice notes line: what transcribing them costs, or that they are archived only. */
export function voiceCostLabel(voice: NonNullable<ImportJob['preview']>['voice']): string {
  if (!voice || !voice.notes) return '';
  const notes = `${voice.notes.toLocaleString()} voice notes (${voice.minutes.toLocaleString()} minutes)`;
  if (!voice.configured)
    return `${notes} are archived without text, because Voice notes in Settings › Models has no key.`;
  return voice.cost_usd === null
    ? `${notes} are transcribed.`
    : `${notes} are transcribed, about ${dollars(voice.cost_usd)}.`;
}
/** The learning cost line under the learning choice. */
export function learningCostLabel(learning: NonNullable<ImportJob['preview']>['learning']): string {
  if (!learning || learning.cost_usd === null) return 'No cost estimate right now.';
  const parts = learning.parts.map(part => `${part.label.toLowerCase()} ${dollars(part.cost_usd ?? 0)}`).join(', ');
  const basis = learning.parts.every(part => part.measured)
    ? 'from what learning cost here in the last 30 days'
    : 'from typical use, so treat it as rough';
  return `Estimated cost to learn: about ${dollars(learning.cost_usd)} (${parts}), ${basis}.`;
}
/** The progress line while imported messages are read and checked for secrets. */
export function preparationLabel(prepared: NonNullable<ImportJob['prepared']>): string {
  const done = prepared.ready + prepared.failed;
  return [
    `Preparing for questions: ${done.toLocaleString()} of ${prepared.total.toLocaleString()} messages`,
    prepared.files ? `${prepared.files.toLocaleString()} with files to read` : '',
    prepared.checking ? `${prepared.checking.toLocaleString()} to check for secrets` : '',
    prepared.failed ? `${prepared.failed.toLocaleString()} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
export const canStart = (job: ImportJob) =>
  !!job.preview && ['ready', 'failed', 'cancelled', 'interrupted'].includes(job.state);
/** A resumed import keeps the chat choices and learning choice it started with. */
export const isResume = (job: ImportJob) => job.mapping !== undefined || job.review_approved !== undefined;
