import {HttpError} from '../http.js';

/**
 * The brain socket (ADR-0234). A brain is the AI agent that answers: it reads a turn, works with its own built-in tools
 * and Nocheh's data tools over MCP (ADR-0233), and returns what it found. Nocheh keeps the messages, people and chats,
 * sharing rules, approvals, long-term memory (ADR-0232) and the platform bots; the brain keeps only its own working state,
 * such as its sessions, its own notes and its settings. One brain runs at a time. Nocheh reaches it only through this type.
 *
 * Words used here:
 * - turn: one run of the brain for one message, follow-up, dashboard chat message, scheduled task or background job.
 * - ref: a turn's identity: its channel, the event it answers and the attempt. A follow-up's attempt is a string.
 * - pass: the turn's short-lived key for Nocheh's data tools (`archive_credential`), naming this brain.
 * - receipt: what the brain reports about a turn. The brain keeps it, so a lost answer can be asked for again.
 * - reply: the text a turn answers with. Nocheh delivers it; the brain sends nothing to any platform.
 */

export const turnChannels=['telegram','browser','scheduler','background'] as const;
/** Where a turn comes from: a Telegram message or follow-up, the dashboard chat, a scheduled task or a background job. */
export type TurnChannel=typeof turnChannels[number];
export type TurnRef={readonly channel:TurnChannel;readonly event_id:string;readonly attempt:number|string};
/** `not_found` means the brain never received the turn, so the same ref may be started. `waiting` means a scheduled
 * turn is not due yet. `suppressed` means the brain chose not to run or answer it. */
export type TurnState='queued'|'waiting'|'running'|'done'|'failed'|'cancelled'|'suppressed'|'ambiguous'|'not_found';
export const closedTurnStates:ReadonlySet<TurnState>=new Set(['done','failed','cancelled','suppressed','ambiguous']);
/** The answer of a done turn, when the brain returns it rather than sending it. Empty text means the brain stays silent. */
export type TurnReply={readonly text:string;readonly session_id:string};
/** Besides these fields a receipt may carry bounded details Nocheh records, such as `timings`, `window`, `error_type`,
 * `error_stage` and `unexpected_tool_names`. It never carries message content other than `reply`. */
export type TurnReceipt={readonly state:TurnState;readonly stage?:string;readonly reply?:TurnReply;readonly error_code?:string;readonly [detail:string]:unknown};
/** A turn's progress journal: content-free state changes in order. */
export type TurnEvents={readonly events:readonly {readonly sequence:number;readonly state:string;readonly stage:string;readonly at:number}[];readonly [detail:string]:unknown};
/**
 * What a turn starts with.
 * - telegram: the message and what Nocheh prepared for it: `source_key`, `scope`, `payload`, `text`, `transcripts`,
 *   `files`, `control_reply`, `guard_mode`, the pass `archive_credential`, and when they apply `speaker`, `recent_group`,
 *   `group_addressing`, `untranscribed_voice`, `files_too_large`, `album_events`, or `continuation` for a follow-up.
 * - browser, scheduler, background: `owner_epoch`. The brain asks Nocheh for the rest through the run routes
 *   `/v1/<channel>/workflow-context`, `claim`, `prepare`, `heartbeat` and `finish`.
 * Nocheh adds the owner's replacements for the brain's built-in instructions as `prompts`.
 */
export type TurnInput=Readonly<Record<string,unknown>>;
type Call=(input:Readonly<Record<string,unknown>>)=>Promise<Record<string,unknown>>;

export type Brain={
  /** Stable brain id, such as `hermes`. Turn passes and security records name it. */
  readonly id:string;
  /** The name the owner sees. */
  readonly name:string;
  /** Channels whose turns this brain runs. */
  readonly channels:readonly TurnChannel[];

  // Turns. Each call is safe to repeat: one ref runs at most once.
  /** Start a turn, or only report it when that ref was already started. */
  startTurn(ref:TurnRef,input:TurnInput):Promise<TurnReceipt>;
  /** Report a turn without starting anything. */
  observeTurn(ref:TurnRef):Promise<TurnReceipt>;
  /** Stop a turn. A closed turn keeps its receipt. */
  cancelTurn(ref:TurnRef):Promise<TurnReceipt>;
  /** The turn's journal after a sequence number. */
  turnEvents(ref:TurnRef,after:number):Promise<TurnEvents>;
  /** Health and model, for the dashboard. */
  status():Promise<Record<string,unknown>>;

  // The brain's own state. Each is absent when the brain has no such thing; callers then answer `brain_capability_unavailable`.
  /** Per-chat limits, such as reasoning effort or step limits: `{scope}` reads, `{scope,changes,revision}` writes.
   * The answer describes its own keys in `schema`. */
  readSettings?:Call;
  writeSettings?:Call;
  /** A chat's, project's or the default role text and skills: `{scope}` reads, `{scope,role,skills,revision}` writes. */
  readPersona?:Call;
  writePersona?:Call;
  /** The brain's built-in instruction texts by key, which the owner can replace. */
  promptDefaults?():Promise<Record<string,string>>;
  /** The brain's own per-chat state, for the owner to browse: `profiles` lists it, `notes` reads one chat's notes and sessions. */
  listProfiles?:Call;
  readNotes?:Call;
  /** Search the brain's own notes and past sessions. The owner audience only. */
  recallNotes?:Call;
  /** Learn the brain's own notes from a finished conversation, as one idempotent job; `observe_only` only reports it. */
  reviewNotes?:Call;
  /** Bring the brain's own scheduled tasks forward, so Nocheh runs those that are due. */
  advanceSchedules?:Call;
};

/** Error codes every brain uses, so Nocheh can act on them without knowing the brain. */
export const brainErrors={
  /** The brain could not be reached or did not answer; a started turn may or may not exist. */
  unavailable:'brain_unavailable',
  /** The brain answered with an error, so nothing was started or changed. */
  rejected:'brain_rejected',
  /** The brain's answer was not what this socket expects. */
  invalid:'brain_invalid_response',
  /** The brain does not offer this operation or channel. */
  unsupported:'brain_capability_unavailable',
} as const;
export const brainUnavailable=()=>new HttpError(503,brainErrors.unavailable);
export const brainRejected=()=>new HttpError(503,brainErrors.rejected);
export const brainInvalid=()=>new HttpError(502,brainErrors.invalid);
export const brainUnsupported=()=>new HttpError(409,brainErrors.unsupported);
/** An optional operation of the plugged-in brain, or `brain_capability_unavailable`. */
export function brainOperation<K extends 'readSettings'|'writeSettings'|'readPersona'|'writePersona'|'listProfiles'|'readNotes'|'recallNotes'|'reviewNotes'|'advanceSchedules'>(brain:Brain,name:K):Call {
  const operation=brain[name];if(!operation)throw brainUnsupported();
  return input=>operation.call(brain,input);
}
/** A turn's channel this brain runs, or `brain_capability_unavailable`. */
export function turnChannel(brain:Brain,channel:unknown):TurnChannel {
  if(!(brain.channels as readonly unknown[]).includes(channel))throw brainUnsupported();
  return channel as TurnChannel;
}
/** What the dashboard and API show about the plugged-in brain. */
export const brainSummary=(brain:Brain)=>({id:brain.id,name:brain.name,
  capabilities:{...Object.fromEntries(turnChannels.map(channel=>[channel,brain.channels.includes(channel)])),
    settings:!!brain.readSettings,persona:!!brain.readPersona,prompts:!!brain.promptDefaults,notes:!!brain.readNotes,
    recall:!!brain.recallNotes,review:!!brain.reviewNotes,schedules:!!brain.advanceSchedules}});
