import {HttpError} from '../http.js';

/**
 * The agent socket (ADR-0234). An agent is the AI that answers: it reads a turn, works with its own built-in tools
 * and Nocheh's data tools over MCP (ADR-0233), and returns what it found. Nocheh keeps the messages, people and chats,
 * sharing rules, approvals, long-term memory (ADR-0232) and the platform bots; the agent keeps only its own working state,
 * such as its sessions, its own notes and its settings. One agent runs at a time. Nocheh reaches it only through this type.
 *
 * Words used here:
 * - turn: one run of the agent for one message, follow-up, dashboard chat message, scheduled task or background job.
 * - ref: a turn's identity: its channel, the event it answers and the attempt. A follow-up's attempt is a string.
 * - pass: the turn's short-lived key for Nocheh's data tools (`archive_credential`), naming this agent.
 * - receipt: what the agent reports about a turn. The agent keeps it, so a lost answer can be asked for again.
 * - reply: the text a turn answers with. Nocheh delivers it; the agent sends nothing to any platform.
 */

export const turnChannels=['telegram','browser','scheduler','background'] as const;
/** Where a turn comes from: a Telegram message or follow-up, the dashboard chat, a scheduled task or a background job. */
export type TurnChannel=typeof turnChannels[number];
export type TurnRef={readonly channel:TurnChannel;readonly event_id:string;readonly attempt:number|string};
/** `not_found` means the agent never received the turn, so the same ref may be started. `waiting` means a scheduled
 * turn is not due yet. `suppressed` means the agent chose not to run or answer it. */
export type TurnState='queued'|'waiting'|'running'|'done'|'failed'|'cancelled'|'suppressed'|'ambiguous'|'not_found';
export const closedTurnStates:ReadonlySet<TurnState>=new Set(['done','failed','cancelled','suppressed','ambiguous']);
/** The answer of a done turn, when the agent returns it rather than sending it. An agent that chooses silence ends the
 * turn `suppressed` with `intentional_silence` instead. */
export type TurnReply={readonly text:string;readonly session_id:string};
/** Besides these fields a receipt may carry bounded details Nocheh records, such as `timings`, `window`, `error_type`,
 * `error_stage` and `unexpected_tool_names`. It never carries message content other than `reply`. */
export type TurnReceipt={readonly state:TurnState;readonly stage?:string;readonly reply?:TurnReply;readonly error_code?:string;readonly [detail:string]:unknown};
/** A turn's progress journal: content-free state changes in order. */
export type TurnEvents={readonly events:readonly {readonly sequence:number;readonly state:string;readonly stage:string;readonly at:number}[];readonly [detail:string]:unknown};
/**
 * What a turn starts with.
 * - telegram: the message and what Nocheh prepared for it: `source_key`, `scope`, `payload`, `text`, `transcripts`,
 *   `files`, `control_reply`, `guard_mode`, the pass `archive_credential`, and when they apply `speaker`, `forwarded`, `recent_group`,
 *   `group_addressing`, `untranscribed_voice`, `files_too_large`, `album_events`, or `continuation` for a follow-up.
 * - browser, scheduler, background: `owner_epoch`. The agent asks Nocheh for the rest through the run routes
 *   `/v1/<channel>/workflow-context`, `claim`, `prepare`, `heartbeat` and `finish`.
 * Nocheh adds the owner's replacements for the agent's built-in instructions as `prompts`.
 */
export type TurnInput=Readonly<Record<string,unknown>>;
type Call=(input:Readonly<Record<string,unknown>>)=>Promise<Record<string,unknown>>;

export type Agent={
  /** Stable agent id, such as `hermes`. Turn passes and security records name it. */
  readonly id:string;
  /** The name the owner sees. */
  readonly name:string;
  /** Channels whose turns this agent runs. */
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

  // The agent's own state. Each is absent when the agent has no such thing; callers then answer `agent_capability_unavailable`.
  /** Per-chat limits, such as reasoning effort or step limits: `{scope}` reads, `{scope,changes,revision}` writes.
   * The answer describes its own keys in `schema`. */
  readSettings?:Call;
  writeSettings?:Call;
  /** A chat's, project's or the default role text and skills: `{scope}` reads, `{scope,role,skills,revision}` writes. */
  readPersona?:Call;
  writePersona?:Call;
  /** The agent's built-in instruction texts by key, which the owner can replace. */
  promptDefaults?():Promise<Record<string,string>>;
  /** The agent's own per-chat state, for the owner to browse: `profiles` lists it, `notes` reads one chat's notes and sessions. */
  listProfiles?:Call;
  readNotes?:Call;
  /** Search the agent's own notes and past sessions. The owner audience only. */
  recallNotes?:Call;
  /** Learn the agent's own notes from a finished conversation, as one idempotent job; `observe_only` only reports it.
   * The agent records a start durably before the job runs, so an observed `not_found` means no run began that could
   * have changed anything, and Nocheh may start the same job again (ADR-0258). */
  reviewNotes?:Call;
  /** Bring the agent's own scheduled tasks forward, so Nocheh runs those that are due. */
  advanceSchedules?:Call;
  /** The owner's Schedules pages (ADR-0266): `{operation:'list'}` lists every chat's schedules; `{operation, profile, job_id,
   *  request_id}` pauses, resumes, runs now (`run`) or deletes one. */
  manageSchedules?:Call;
};

/** Error codes every agent uses, so Nocheh can act on them without knowing the agent. */
export const agentErrors={
  /** The agent could not be reached or did not answer; a started turn may or may not exist. */
  unavailable:'agent_unavailable',
  /** The agent answered with an error, so nothing was started or changed. */
  rejected:'agent_rejected',
  /** The agent's answer was not what this socket expects. */
  invalid:'agent_invalid_response',
  /** The agent does not offer this operation or channel. */
  unsupported:'agent_capability_unavailable',
} as const;
export const agentUnavailable=()=>new HttpError(503,agentErrors.unavailable);
export const agentRejected=()=>new HttpError(503,agentErrors.rejected);
export const agentInvalid=()=>new HttpError(502,agentErrors.invalid);
export const agentUnsupported=()=>new HttpError(409,agentErrors.unsupported);
/** The agent's optional operations that take and answer plain records. */
export type AgentOperation='readSettings'|'writeSettings'|'readPersona'|'writePersona'|'listProfiles'|'readNotes'|'recallNotes'|'reviewNotes'|'advanceSchedules'|'manageSchedules';
/** An optional operation of the plugged-in agent, or `agent_capability_unavailable`. */
export function agentOperation(agent:Agent,name:AgentOperation):Call {
  const operation=agent[name];if(!operation)throw agentUnsupported();
  return input=>operation.call(agent,input);
}
/** A turn's channel this agent runs, or `agent_capability_unavailable`. */
export function turnChannel(agent:Agent,channel:unknown):TurnChannel {
  if(!(agent.channels as readonly unknown[]).includes(channel))throw agentUnsupported();
  return channel as TurnChannel;
}
/** What the dashboard and API show about the plugged-in agent. */
export const agentSummary=(agent:Agent)=>({id:agent.id,name:agent.name,
  capabilities:{...Object.fromEntries(turnChannels.map(channel=>[channel,agent.channels.includes(channel)])),
    settings:!!agent.readSettings,persona:!!agent.readPersona,prompts:!!agent.promptDefaults,notes:!!agent.readNotes,
    recall:!!agent.recallNotes,review:!!agent.reviewNotes,schedules:!!agent.advanceSchedules,schedule_list:!!agent.manageSchedules}});
