// Member shapes shared by storage and the dashboard (step 3, members in groups). Type imports only: the dashboard reads
// these as types, and the values here are the only spelling of each member word.
import type {ChatState} from './chat-wire.js';

/** 'paused' stops everything a member does (Pause this member); Remove deletes the member. */
export const memberStates=['active','paused'] as const;
export type MemberState=typeof memberStates[number];
/** Tasks: read and write, or read only. */
export const memberTaskModes=['write','read'] as const;
export type MemberTasks=typeof memberTaskModes[number];
/** The three sub-permissions of "Talk to Nocheh in groups they joined": small jobs, posts to their other groups, and web
 * pages and outside tools. With talk off, every one is off; their own values are kept. */
export const memberPermissions=['jobs','post','tools'] as const;
export type MemberPermission=typeof memberPermissions[number];
/** What Telegram last said of a person in a group (chat_memberships.state): seen in it, or left it. */
export type MemberPresence='in'|'left';
/** The daily message cap: turns per member per UTC day across all groups (member_directory_state.daily_messages). */
export const DAILY_MESSAGES_DEFAULT=200,DAILY_MESSAGES_MIN=1,DAILY_MESSAGES_MAX=10000;
/** How many schedules each member with Personal assistant may keep (member_directory_state.member_schedules). */
export const MEMBER_SCHEDULES_DEFAULT=5,MEMBER_SCHEDULES_MIN=1,MEMBER_SCHEDULES_MAX=50;

/** A member's permissions as stored: the sub-permissions keep their values while talk is off. `private_chat` is "Private
 * chat with Nocheh" (step 4, members.private_chat): on by default, and independent of talk. `reminders` is "Reminders to
 * themselves" (step 5, members.reminders), nested under Tasks read and write: on by default; off, the member sets no
 * reminder in a group or the members' app (403 task_reminders_off). `assistant` is "Personal assistant" (members.assistant):
 * off by default; on, the member sets their own schedules in their private chat with Nocheh, up to the members' cap. */
export interface MemberPermissions {talk:boolean;jobs:boolean;post:boolean;tools:boolean;tasks:MemberTasks;private_chat:boolean;reminders:boolean;assistant:boolean}
/** A group Nocheh is in (a group chat whose state is not left, removed or archived), for the add flows. */
export interface MemberGroupRef {chat_id:string;title:string|null;state:ChatState}
/**
 * One of a member's groups on the Members page: every group with a member_chats row, and every group Nocheh is in where
 * Telegram has a row for one of the member's accounts. `on` is the row's enabled, or true with no row (a group with no
 * row counts as on). `telegram` is the newest chat_memberships state of their accounts there, null with none. `new` marks
 * a group where Telegram shows them 'in' but that has no row ("New here", information only).
 */
export interface MemberGroup {chat_id:string;title:string|null;state:ChatState;on:boolean;telegram:MemberPresence|null;new:boolean}
/** One member. `account_id` is the member's account (chat_accounts id); name, username and telegram_id come from it
 * (null when unknown: the dashboard fills names from /telegram/identities). `owner_linked` warns that the account is
 * the owner's own: the directory never treats it as a member. */
export interface MemberItem {id:string;account_id:string;state:MemberState;name:string|null;username:string|null;telegram_id:string|null;
  owner_linked:boolean;added_at:string;permissions:MemberPermissions;groups:MemberGroup[];
  /** Their own time zone (members.time_zone), or null for the owner's (ADR-0281); the owner sees and sets it here. */
  time_zone:string|null}
/** A person who is not a member, seen 'in' (Telegram's newest row) in groups Nocheh is in: a human account, never the
 * owner, a bot or a proxy account. */
export interface MemberPerson {account_id:string;name:string|null;username:string|null;telegram_id:string|null;groups:MemberGroupRef[]}
/** GET /v1/members. `groups` is every group Nocheh is in (for Add by Telegram user ID). */
export interface MemberList {revision:number;daily_messages:number;member_schedules:number;groups:MemberGroupRef[];members:MemberItem[];people:MemberPerson[]}

/**
 * POST /v1/members: add a member. Exactly one of account_id (a person Nocheh has seen) or telegram_id (Add by Telegram
 * user ID, whose account is created if missing). `groups` maps group chat ids to the owner's ticks: true writes an
 * enabled row, false a switched-off row; groups it leaves out get no row (on by default). At least one is true.
 */
export interface MemberAddRequest {operation_id:string;account_id:string|null;telegram_id:string|null;groups:Record<string,boolean>}
/** The changes POST /v1/members/:id may carry; at least one. `groups` switches groups on (true) or off (false). */
export interface MemberChanges {state?:MemberState;talk?:boolean;jobs?:boolean;post?:boolean;tools?:boolean;tasks?:MemberTasks;private_chat?:boolean;
  reminders?:boolean;assistant?:boolean;groups?:Record<string,boolean>;
  /** A time zone such as Europe/Berlin, or null for the owner's. */
  time_zone?:string|null}
/** POST /v1/members/:id: change a member. */
export interface MemberChangeRequest {operation_id:string;changes:MemberChanges}
/** POST /v1/members/:id/remove. */
export interface MemberRemoveRequest {operation_id:string}
/** POST /v1/members/settings: the daily message cap and how many schedules each member may keep; at least one. */
export interface MemberSettingsRequest {operation_id:string;daily_messages?:number;member_schedules?:number}
/** The answer to an add or a change: the member as GET /v1/members shows it, and the member revision after it. */
export interface MemberResult {revision:number;member:MemberItem}
export interface MemberRemoved {revision:number;removed:string}
export interface MemberSettingsResult {revision:number;daily_messages:number;member_schedules:number}

/**
 * The editable texts step 3 adds (src/prompts.ts holds their defaults; Settings › Assistant lists them).
 * - dailyLimit: a prompt key, the reply sent without a model to a member over the daily cap, once per group per UTC day.
 * - groupTools: a prompt key of labeled lines ('name: text'), the result the model gets when the group's tools
 *   permission lets a tool run without a card; its labels are groupToolsTextLabels.
 */
export const memberTextKeys={dailyLimit:'telegram.member_daily_limit',groupTools:'telegram.group_tools_texts'} as const;
/** The lines of telegram.group_tools_texts: with a follow-up reply to come, and without. */
export const groupToolsTextLabels=['allowed_follow_up','allowed'] as const;
/**
 * The editable texts step 4 adds (member private chat, and the owner asking about a member). src/prompts.ts holds the
 * defaults of the texts Nocheh sends itself; reply.member's default is Hermes's (services/hermes/prompts.py), as every
 * reply.* text is. Settings › Assistant lists them.
 * - reply: a prompt key, the reply rules of a member's own private chat with Nocheh (read only, with the truthful rule
 *   that the owner can read the chat).
 * - privateDailyLimit: a prompt key, the reply sent without a model to a member over the daily cap in their private
 *   chat, at most once a UTC day.
 * - notAllowedPrivate: the existing key telegram.not_allowed_private, reworded for "its owner and the people they add".
 * - localLaws: a prompt key, the owner-only line on the Members page about local laws on reading members' chats.
 */
export const memberPrivateTextKeys={reply:'reply.member',privateDailyLimit:'telegram.member_private_daily_limit',
  notAllowedPrivate:'telegram.not_allowed_private',localLaws:'members.local_laws'} as const;
/** The line telegram.approval_texts gains: why a member's approved send or tool run did not happen (the member was
 * paused, removed, or their group or permission switched off). */
export const memberChangedReason='reason_member_changed';
/**
 * The editable texts step 5 adds (the members' app). src/prompts.ts holds their defaults; Settings › Assistant lists them.
 * - reminder: a prompt key, a task reminder sent to the member who set it, in their own private chat with Nocheh.
 * - reminderTexts: a prompt key of labeled lines ('name: text') under it; its labels are memberReminderTextLabels.
 * tasks.reminder_texts gains the line place_app, the place "the members' app" in the owner's reminder lines.
 */
export const memberAppTextKeys={reminder:'members.reminder',reminderTexts:'members.reminder_texts'} as const;
/** The lines of members.reminder_texts: who set it (always the member: "Set by you"), and the mark before each line of
 * the task's notes. No line names a writer, a closer or a place. */
export const memberReminderTextLabels=['set_by','note_line'] as const;
