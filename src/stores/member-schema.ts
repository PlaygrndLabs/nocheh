import type pg from 'pg';
import {DAILY_MESSAGES_DEFAULT,DAILY_MESSAGES_MAX,DAILY_MESSAGES_MIN,MEMBER_SCHEDULES_DEFAULT,MEMBER_SCHEDULES_MAX,MEMBER_SCHEDULES_MIN,memberStates,memberTaskModes} from '../member-wire.js';

const list=(values:readonly string[])=>values.map(value=>`'${value}'`).join(',');
const hex=(column:string)=>`${column} ~ '^[a-f0-9]{64}$'`;

/**
 * Members in groups (step 3), in the control store after the chat records. Everything is created only if missing and
 * nothing here rewrites a row, so the control bootstrap runs again as a no-op. Ids: a member's is memberIdFor(its first
 * account) (src/members.ts); a person reaches their member through chat_accounts.member_id, and app user ids live only
 * in chat_accounts.
 *
 * - members: one per member, with Talk to Nocheh in groups they joined (group_talk) and its three sub-permissions, which
 *   keep their values while group_talk is off, Tasks (read and write, or read only), and Private chat with Nocheh
 *   (private_chat, step 4: on by default and independent of group_talk), Reminders to themselves (reminders, step 5: on
 *   by default), Personal assistant (assistant: off by default; on, they set their own schedules) and app_since (step 5: when the member was added or last un-paused; a members' app launch from before
 *   it is refused). 'paused' stops everything.
 *   Remove deletes the row: its member_chats and member_turns go with it, and its accounts are unlinked.
 * - member_chats: a member's switch for one group; a topic follows its group, so only group chats have rows. A group
 *   with no row counts as on.
 * - member_directory_state: the member revision, moved by every commit that changes what the member directory holds
 *   (bumpMemberRevision); carried_at, set once the lists in force before step 3 were carried; the daily message cap; and
 *   member_schedules, how many schedules each member with Personal assistant may keep.
 * - member_turns: the daily cap's count, one row per member turn, so a retry of the same event counts once. On a
 *   member's private turn, left_out holds the joined groups that turn leaves out (re-checks past the cap, step 4): every
 *   read bound to that turn leaves them out too, and one with no list written reads nothing.
 * - member_app_prefs (step 5): the auth_date of the launch that last signed out of the members' app; every launch no newer than it is refused, on Telegram's clock on both sides.
 * - member_app_limits (step 5): the members' app write counts, per 10-minute window and per UTC day.
 */
export const memberSchema=`
CREATE TABLE IF NOT EXISTS members (
 id text PRIMARY KEY CHECK(${hex('id')}),
 state text NOT NULL DEFAULT 'active' CHECK(state IN (${list(memberStates)})),
 group_talk boolean NOT NULL DEFAULT true,
 group_jobs boolean NOT NULL DEFAULT true,
 group_post_other boolean NOT NULL DEFAULT true,
 group_tools boolean NOT NULL DEFAULT true,
 tasks text NOT NULL DEFAULT 'write' CHECK(tasks IN (${list(memberTaskModes)})),
 private_chat boolean NOT NULL DEFAULT true,
 reminders boolean NOT NULL DEFAULT true,
 app_since timestamptz NOT NULL DEFAULT now(),
 added_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1)
);
-- Step 4 (member private chat): every member, the ones added before it too, has private chat on.
ALTER TABLE members ADD COLUMN IF NOT EXISTS private_chat boolean NOT NULL DEFAULT true;
-- Step 5 (members' app): "Reminders to themselves", on by default; and when the member was added or last un-paused,
-- so a launch of the members' app from before then is refused (ADR-0265 D4).
ALTER TABLE members ADD COLUMN IF NOT EXISTS reminders boolean NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN IF NOT EXISTS app_since timestamptz NOT NULL DEFAULT now();
-- Members' schedules: "Personal assistant", off by default (the member sets their own schedules in their private chat).
ALTER TABLE members ADD COLUMN IF NOT EXISTS assistant boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS member_chats (
 member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(member_id,chat_id)
);
CREATE INDEX IF NOT EXISTS member_chats_chat ON member_chats(chat_id);
-- What a chat is comes from its chats row (ADR-0252): a member's switch is for a group, never a topic or a private chat.
CREATE OR REPLACE FUNCTION member_chats_group_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM chats WHERE id=NEW.chat_id AND kind='group') THEN
  RAISE EXCEPTION 'member_chats: a member''s switch is for a group chat' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_chats_group_only ON member_chats;
CREATE TRIGGER member_chats_group_only BEFORE INSERT OR UPDATE OF chat_id ON member_chats FOR EACH ROW EXECUTE FUNCTION member_chats_group_only();
CREATE TABLE IF NOT EXISTS member_directory_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 carried_at timestamptz,
 daily_messages integer NOT NULL DEFAULT ${DAILY_MESSAGES_DEFAULT} CHECK(daily_messages BETWEEN ${DAILY_MESSAGES_MIN} AND ${DAILY_MESSAGES_MAX})
);
INSERT INTO member_directory_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
-- How many schedules each member with Personal assistant may keep.
ALTER TABLE member_directory_state ADD COLUMN IF NOT EXISTS member_schedules integer NOT NULL DEFAULT ${MEMBER_SCHEDULES_DEFAULT}
 CHECK(member_schedules BETWEEN ${MEMBER_SCHEDULES_MIN} AND ${MEMBER_SCHEDULES_MAX});
CREATE TABLE IF NOT EXISTS member_turns (
 member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 event_id text NOT NULL CHECK(${hex('event_id')}),
 day date NOT NULL,
 PRIMARY KEY(member_id,event_id)
);
CREATE INDEX IF NOT EXISTS member_turns_day ON member_turns(member_id,day);
ALTER TABLE member_turns ADD COLUMN IF NOT EXISTS left_out text[];
-- chat_accounts.member_id (chat-schema.ts) links a person to their member. Added once, so a later bootstrap neither
-- locks chat_accounts nor checks its rows again.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='chat_accounts'::regclass AND conname='chat_accounts_member_id_fkey') THEN
  ALTER TABLE chat_accounts ADD CONSTRAINT chat_accounts_member_id_fkey FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE SET NULL;
 END IF;
END$$;
CREATE INDEX IF NOT EXISTS chat_accounts_member ON chat_accounts(member_id) WHERE member_id IS NOT NULL;
-- The members' app (step 5, ADR-0265). Both go with their member (a removal cascades) and stay out of the reset
-- snapshot and the owner's record: a restored member opens the app again from the menu.
CREATE TABLE IF NOT EXISTS member_app_prefs (
 member_id text PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
 signed_out_auth_date timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_app_limits (
 member_id text PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL DEFAULT now(),window_writes integer NOT NULL DEFAULT 0 CHECK(window_writes>=0),
 day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,day_writes integer NOT NULL DEFAULT 0 CHECK(day_writes>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
`;

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;
/** Moves the member revision, in the transaction that changed what the member directory holds: a member command, a
 * member account's membership created or switched between 'in' and 'left', a group upgrade moving member rows, and the
 * carry. The loader in every process reloads when it sees it move. */
export const bumpMemberRevision=(db:Db)=>db.query('UPDATE member_directory_state SET revision=revision+1 WHERE singleton');
