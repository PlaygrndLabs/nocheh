import type pg from 'pg';
import {DAILY_MESSAGES_DEFAULT,DAILY_MESSAGES_MAX,DAILY_MESSAGES_MIN,memberStates,memberTaskModes} from '../member-wire.js';

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
 *   (private_chat, step 4: on by default and independent of group_talk). 'paused' stops everything.
 *   Remove deletes the row: its member_chats and member_turns go with it, and its accounts are unlinked.
 * - member_chats: a member's switch for one group; a topic follows its group, so only group chats have rows. A group
 *   with no row counts as on.
 * - member_directory_state: the member revision, moved by every commit that changes what the member directory holds
 *   (bumpMemberRevision); carried_at, set once the lists in force before step 3 were carried; and the daily message cap.
 * - member_turns: the daily cap's count, one row per member turn, so a retry of the same event counts once.
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
 added_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1)
);
-- Step 4 (member private chat): every member, the ones added before it too, has private chat on.
ALTER TABLE members ADD COLUMN IF NOT EXISTS private_chat boolean NOT NULL DEFAULT true;
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
CREATE TABLE IF NOT EXISTS member_turns (
 member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 event_id text NOT NULL CHECK(${hex('event_id')}),
 day date NOT NULL,
 PRIMARY KEY(member_id,event_id)
);
CREATE INDEX IF NOT EXISTS member_turns_day ON member_turns(member_id,day);
-- chat_accounts.member_id (chat-schema.ts) links a person to their member. Added once, so a later bootstrap neither
-- locks chat_accounts nor checks its rows again.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='chat_accounts'::regclass AND conname='chat_accounts_member_id_fkey') THEN
  ALTER TABLE chat_accounts ADD CONSTRAINT chat_accounts_member_id_fkey FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE SET NULL;
 END IF;
END$$;
CREATE INDEX IF NOT EXISTS chat_accounts_member ON chat_accounts(member_id) WHERE member_id IS NOT NULL;
`;

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;
/** Moves the member revision, in the transaction that changed what the member directory holds: a member command, a
 * member account's membership created or switched between 'in' and 'left', a group upgrade moving member rows, and the
 * carry. The loader in every process reloads when it sees it move. */
export const bumpMemberRevision=(db:Db)=>db.query('UPDATE member_directory_state SET revision=revision+1 WHERE singleton');
