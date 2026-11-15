// Chat shapes shared by storage, the Python services and the dashboard (ADR-0252). No imports: the dashboard reads
// these as types, and the values here are the only spelling of each chat word.

/** The chat apps Nocheh can be added to. Telegram is the only front door in step 2b; Slack is designed for. */
export const chatApps=['telegram','slack'] as const;
export type ChatApp=typeof chatApps[number];
/** A private chat (one person and Nocheh), a group (a Telegram group or channel, a Slack channel), or a topic of
 * either (a Telegram forum topic or private-chat topic). A Slack thread, like a Telegram reply chain, is never a chat:
 * it stays with its channel's messages. */
export const chatKinds=['private','group','topic'] as const;
export type ChatKind=typeof chatKinds[number];
/**
 * Where Nocheh stands in a chat. 'active' is served. 'off' means Nocheh is there but the owner turned it off (it stays
 * silent and keeps archiving). 'pending' is seen but not decided. 'left' means Nocheh left, 'removed' that it was
 * removed or is not a member. 'could_not_leave' and 'archived' are for Slack. A topic's own state is not read: a
 * topic follows its parent.
 */
export const chatStates=['active','off','pending','left','removed','could_not_leave','archived'] as const;
export type ChatState=typeof chatStates[number];
/** A chat keeps every app id it ever had: the one in use now, and older ones (a group Telegram upgraded). */
export const chatIdStates=['current','old'] as const;
export type ChatIdState=typeof chatIdStates[number];

/** One app id of a chat, shown as a label (never a Nocheh id) and matched against archive originals. */
export interface ChatAppLabel {app:ChatApp;external:string;state:ChatIdState}

/**
 * The app a turn pass is bound to (ADR-0252): the chat's current id in that app, and the topic key there (a Telegram
 * forum topic's thread id as text), or null. Signed in a turn pass beside the Nocheh scope and space; the front door
 * that receives the turn checks it against its own update.
 */
export interface AppBinding {app:ChatApp;chat:string;topic:string|null}

/** One chat in GET /internal/chats. A topic carries no app ids of its own: it is its parent's ids plus topic_key. */
export interface ServedChat {id:string;app:ChatApp;kind:ChatKind;parent_id:string|null;topic_key:string|null;state:ChatState;
  app_ids:{external:string;state:ChatIdState}[]}
/**
 * GET /internal/chats, behind the service token: what the Python services may act for. The owner's private chat and
 * the owner's account are separate: owner_chat is a Nocheh chat id, owner_account the owner's id in the app (the
 * Telegram user id; one app's only, until a second app's front door needs its own). `chats` holds every served chat with its topics and the owner's private chat. `epoch` is the
 * guard epoch the list was read at; a pass that carries a newer one means the list is stale.
 */
export interface ServedChats {epoch:number;owner_chat:string|null;owner_account:{app:ChatApp;external:string}|null;chats:ServedChat[]}

/**
 * The fields of a /v1/conversations item that come from the chat directory. The dashboard reads kind, parent, topic,
 * owner and state from here and never works them out from an id. `kind` is 'unknown' for a value with no chat row;
 * `app_ids` are labels such as "Telegram ID", current first; a topic's are its parent's.
 */
export interface ConversationChatFields {
  kind:ChatKind|'unknown';parent_space:string|null;topic_key:string|null;
  app_ids:ChatAppLabel[];is_forum:boolean|null;state:ChatState|null;
  /** The owner's private chat, or one of its topics. */
  owner:boolean;
}

/** A /search hit's chat: the Nocheh chat of the hit's archive original (its raw scope and topic, through chat_ids),
 * or null when no chat row names it. Compare chats with this, never with the hit's raw `scope`. */
export interface ChatHitFields {chat_id:string|null}
