import {chatApps,chatStates} from '../chat-wire.js';
import {chatIdSql} from '../chats.js';

const list=(values:readonly string[])=>values.map(value=>`'${value}'`).join(',');
const hex=(column:string)=>`${column} ~ '^[a-f0-9]{64}$'`;
/** An app's own id: a Telegram chat or user id, a Slack team, channel or user id. Never a slash, so it is never
 * mistaken for an old topic value. */
const appId=(column:string)=>`${column} ~ '^[A-Za-z0-9._:-]{1,128}$'`;

/**
 * Nocheh's chat records (ADR-0250), in the control store. Every table is created only if missing and nothing here
 * rewrites a row, so the control bootstrap runs again as a no-op. Ids are made by src/chats.ts: chats.id is a chat
 * value stored before step 2b, unchanged, or chatIdFor(); connection and account ids are digests with no bot in them.
 *
 * - chat_connections: one per app (UNIQUE app). The bot or app account it uses can change; the connection stays.
 *   secret_ref names where the credential lives ('env:TELEGRAM_BOT_TOKEN'), never the credential.
 * - chat_accounts: a person or bot in an app (team '' on Telegram). member_id stays null until step 3 adds members and
 *   its foreign key; standing is Slack's member, external, guest or deleted.
 * - chats: private chats, groups and topics. A topic has a parent and a topic_key and is found by them. A private chat
 *   names its person (account_id). The added_by_* columns, add_event and state_seq record who added Nocheh and the
 *   last bot-status update applied; step 2b-2 fills them. title_source says whether the owner named a topic.
 * - chat_ids: each app id a chat has had, current or old (a group Telegram upgraded keeps its old id here). A topic has
 *   none of its own.
 * - chat_memberships: who is in a group (topics share their group's rows). since is when the current state began;
 *   seen_seq is the last update applied, so an older update never undoes a newer one.
 * - chat_directory_state: a revision bumped whenever a chat or chat id is added, so the directory snapshot can tell it
 *   is stale.
 */
export const chatSchema=`
CREATE TABLE IF NOT EXISTS chat_connections (
 id text PRIMARY KEY CHECK(${hex('id')}),
 app text NOT NULL UNIQUE CHECK(app IN (${list(chatApps)})),
 account text CHECK(account IS NULL OR ${appId('account')}),
 bot_user_id text CHECK(bot_user_id IS NULL OR ${appId('bot_user_id')}),
 app_id text CHECK(app_id IS NULL OR ${appId('app_id')}),
 team text NOT NULL DEFAULT '' CHECK(team='' OR ${appId('team')}),
 name text CHECK(name IS NULL OR length(name) BETWEEN 1 AND 256),
 secret_ref text CHECK(secret_ref IS NULL OR secret_ref ~ '^env:[A-Z][A-Z0-9_]{0,63}$'),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','removed')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_accounts (
 id text PRIMARY KEY CHECK(${hex('id')}),
 connection_id text NOT NULL REFERENCES chat_connections(id),
 team text NOT NULL DEFAULT '' CHECK(team='' OR ${appId('team')}),
 external_id text NOT NULL CHECK(${appId('external_id')}),
 kind text NOT NULL DEFAULT 'human' CHECK(kind IN ('human','bot')),
 member_id text,
 display_name text CHECK(display_name IS NULL OR length(display_name)<=256),
 username text CHECK(username IS NULL OR length(username)<=256),
 standing text NOT NULL DEFAULT 'member' CHECK(standing IN ('member','external','guest','deleted')),
 first_seen_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,
 UNIQUE(connection_id,team,external_id)
);
CREATE TABLE IF NOT EXISTS chats (
 id text PRIMARY KEY CHECK(${chatIdSql('id')}),
 connection_id text NOT NULL REFERENCES chat_connections(id),
 kind text NOT NULL CHECK(kind IN ('private','group','topic')),
 parent_id text REFERENCES chats(id),
 topic_key text CHECK(topic_key IS NULL OR topic_key ~ '^[A-Za-z0-9._-]{1,64}$'),
 app_type text CHECK(app_type IS NULL OR app_type ~ '^[a-z_]{1,32}$'),
 account_id text REFERENCES chat_accounts(id),
 title text CHECK(title IS NULL OR length(title)<=256),
 title_source text CHECK(title_source IS NULL OR title_source IN ('observed','refreshed','owner')),
 is_forum boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN (${list(chatStates)})),
 added_by_account_id text REFERENCES chat_accounts(id),
 added_by_role text CHECK(added_by_role IS NULL OR added_by_role IN ('owner','other','anonymous','unknown','seeded')),
 added_at timestamptz,
 add_event text CHECK(add_event IS NULL OR ${hex('add_event')}),
 state_seq numeric CHECK(state_seq IS NULL OR state_seq>=0),
 state_changed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='topic')=(parent_id IS NOT NULL) AND (kind='topic')=(topic_key IS NOT NULL)),
 CHECK(parent_id IS NULL OR parent_id<>id),
 CHECK(account_id IS NULL OR kind='private'),
 UNIQUE(parent_id,topic_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS chats_private_account ON chats(account_id) WHERE kind='private' AND account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chats_state ON chats(state,kind);
CREATE TABLE IF NOT EXISTS chat_ids (
 connection_id text NOT NULL REFERENCES chat_connections(id),
 external_id text NOT NULL CHECK(${appId('external_id')}),
 chat_id text NOT NULL REFERENCES chats(id),
 state text NOT NULL CHECK(state IN ('current','old')),
 reason text CHECK(reason IS NULL OR reason IN ('migrated','id_changed')),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_ids_current ON chat_ids(chat_id) WHERE state='current';
CREATE INDEX IF NOT EXISTS chat_ids_chat ON chat_ids(chat_id);
CREATE TABLE IF NOT EXISTS chat_memberships (
 chat_id text NOT NULL REFERENCES chats(id),
 account_id text NOT NULL REFERENCES chat_accounts(id),
 state text NOT NULL CHECK(state IN ('in','left')),
 source text NOT NULL CHECK(source IN ('listed','event','message','owner')),
 since timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,
 seen_seq numeric CHECK(seen_seq IS NULL OR seen_seq>=0),
 PRIMARY KEY(chat_id,account_id)
);
CREATE INDEX IF NOT EXISTS chat_memberships_account ON chat_memberships(account_id,state);
CREATE TABLE IF NOT EXISTS chat_directory_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1)
);
INSERT INTO chat_directory_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
`;
