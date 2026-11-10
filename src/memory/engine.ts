import {HttpError} from '../http.js';

/**
 * The memory socket (ADR-0229). Nocheh keeps the receipts, sessions, guarding, sharing rules, corrections and
 * deletion bookkeeping; a memory engine only stores what Nocheh feeds it, learns from it and answers reads.
 * Brains never see this socket: they ask Nocheh for memory, and Nocheh asks the engine.
 *
 * Words used here:
 * - space: the installation's memory store in the engine (a Honcho workspace).
 * - session: one conversation or evidence stream Nocheh writes to.
 * - participant: a person, project or the assistant a write is from or about (a Honcho peer).
 * - fact: something the engine learned and can name, such as a Honcho conclusion.
 * - receipt: Nocheh's id for one write. The engine keeps it with the write, so a lost answer can be checked.
 */

/** How a participant takes part in a session: its own words are learned, it is learned about, or it is never learned. */
export type ParticipantRole='writer'|'subject'|'silent';
/** A write the engine holds, as the engine reports it. */
export type EngineWrite={id:unknown;content:unknown;receipt:unknown};
export type EngineWriteInput={author:string;content:string;occurredAt?:string|undefined;receipt:string;sourceRevision:unknown;guardedRevision:unknown};
/** One bounded step of a deletion. `done` means the session or space itself is gone. */
export type ForgetStep={done:boolean;removed:number};
/** `exactCitations` per fact: true when it cites the writes it came from, false when only its whole learning batch
 * is known, null when it brings no writes. */
export type EngineTrace={facts:{id:string;parents:string[];deleted:boolean;exactCitations:boolean|null}[];writes:{id:string;receipt:string}[];limitations:string[]};

export type MemoryEngine={
  /** Stable engine id, such as `honcho`. */
  readonly id:string;
  /** The name the owner sees. */
  readonly name:string;
  /** How Nocheh maps people, projects and conversations into this engine. Space and session ids are derived from it,
   * so another engine or mapping starts a new space and never reads an older one. */
  readonly protocol:string;
  /** The longest question `ask` takes, in characters and in UTF-8 bytes. */
  readonly questionLimits:{characters:number;bytes:number};
  /** The owner can browse what the engine stores from the dashboard. */
  readonly inspectable:boolean;

  // Feed in. Each call is idempotent; Nocheh checks the write is still allowed before each one.
  openSpace(space:string):Promise<void>;
  addParticipant(space:string,participant:string,role:ParticipantRole):Promise<void>;
  openSession(space:string,session:string,participants:Record<string,ParticipantRole>):Promise<void>;
  /** Writes in a session that carry a receipt. A deleted session is a rejection. */
  findWrites(space:string,session:string,receipt:string):Promise<EngineWrite[]>;
  /** Write once. The answer lists the write as the engine stored it. */
  write(space:string,session:string,input:EngineWriteInput):Promise<EngineWrite[]>;

  // Progress and health.
  /** The engine still has work queued or running for the space, or for one session of it. */
  busy(space:string,session?:string):Promise<boolean>;
  /** Learning ended in an error for work queued since `since`, or ever. */
  failing(space:string,since?:Date|null):Promise<boolean>;
  /** How many learning tasks ended in an error; absent when the engine cannot tell. */
  failedLearning?(space:string):Promise<number>;
  /** Run failed learning again from what the engine already holds; answers how many it retried. */
  retryFailedLearning?(space:string):Promise<number>;

  // Read. A list of sessions limits a read to them; none means the whole space (the owner).
  /** Start-of-turn context: the session's summary, and what is known about the subject when one is named. */
  context(space:string,session:string,options:{subject:string|null;limitToSession:boolean;tokens:number}):Promise<{summary:string;subject:string}>;
  /** What is known about a participant across the space. The owner audience only. */
  profile(space:string,participant:string):Promise<string>;
  /** Answer a question about a participant. `evidence` lists the facts the engine read while answering.
   * `format` is a JSON schema the answer must follow. */
  ask(space:string,participant:string,question:string,options:{sessions:string[]|null;evidence:boolean;format?:Record<string,unknown>}):Promise<{text:string;evidence:string[]}>;
  /** Writes that match by meaning, best first. */
  search(space:string,query:string,options:{limit:number;sessions:string[]|null}):Promise<{id:string;receipt:string}[]>;

  // Corrections and deletions, one bounded step per call.
  /** Delete facts learned from a session, then the session itself. */
  forgetSession(space:string,session:string):Promise<ForgetStep>;
  /** Delete a space's sessions, then the space itself. */
  forgetSpace(space:string):Promise<ForgetStep>;
  /** Which writes the named facts came from; absent when the engine cannot tell. */
  trace?(space:string,facts:string[]):Promise<EngineTrace>;
};

/** Error codes every engine uses, so Nocheh can act on them without knowing the engine. */
export const engineErrors={
  /** The engine could not be reached or did not answer; a write may or may not have landed. */
  unavailable:'memory_engine_unavailable',
  /** The engine answered with an error, so nothing was written. */
  rejected:'memory_engine_rejected',
  /** The engine's answer was not what this socket expects. */
  invalid:'memory_engine_invalid_response',
  /** The engine does not offer this operation. */
  unsupported:'memory_engine_unsupported',
} as const;
export const engineUnavailable=()=>new HttpError(503,engineErrors.unavailable);
export const engineRejected=()=>new HttpError(503,engineErrors.rejected);
export const engineInvalid=()=>new HttpError(502,engineErrors.invalid);
export const engineUnsupported=()=>new HttpError(409,engineErrors.unsupported);
/** Engine ids Nocheh stores and passes back: short and plain, whatever the engine. */
export const engineId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
/** What the dashboard and API show about the plugged-in engine. */
export const engineSummary=(engine:MemoryEngine)=>({id:engine.id,name:engine.name,
  capabilities:{inspect:engine.inspectable,evidence:!!engine.trace,retry_failed_learning:!!engine.retryFailedLearning}});
