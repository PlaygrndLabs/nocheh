// Key shapes shared by storage and the dashboard (ADR-0307). Type imports only: the dashboard reads these as types.

/** One person's keys: the owner ('owner') or a member (members.id). A paused member's keys are closed and none are made. */
export interface KeyPerson {
  person:string;name:string|null;username:string|null;state:'on'|'paused';
  /** Keys open now: one per reply or run under way. */
  open:number;
  /** When one of their keys last brought a request, or null when none has in the last 30 days. */
  last_use:string|null;
}
/** What "Stop everything now" ended: keys closed, cards and follow-ups cancelled, runs cancelled, jobs stopped and
 * schedule grants ended. */
export interface KeyStopCounts {keys:number;cards:number;follow_ups:number;runs:number;jobs:number;grants:number}
/** GET /v1/keys: the owner first, then each member as the Members page lists them; and the last stop, if any. */
export interface KeyList {people:KeyPerson[];stopped:({at:string}&KeyStopCounts)|null}
/** POST /v1/keys/stop. `again` is the close after the new agent login is in use (ADR-0307): it ends what the old login
 * started during the restart, and its counts add to the last stop's instead of replacing it. */
export interface KeyStopRequest {operation_id:string;again?:boolean}
export interface KeyStopResult extends KeyStopCounts {stopped_at:string}
