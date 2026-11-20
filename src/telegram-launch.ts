import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import {HttpError} from './http.js';

/*
 * Telegram Mini App launch data (ADR-0251, ADR-0265 D2): checked with Telegram's public Ed25519 key and the public bot
 * id only, so no process here needs the bot token. The owner's mini app keeps its 24-hour maximum age and lets only the
 * owner through (verifyLaunch); the members' app takes any Telegram user, for one hour (verifyLaunchUser), and decides
 * who that user is itself.
 */

/** Telegram's published Ed25519 keys for third-party validation of Mini App launch data. */
export const TELEGRAM_KEYS={production:'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  test:'40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec'} as const;
const SPKI=Buffer.from('302a300506032b6570032100','hex');
export const ed25519=(hex:string):KeyObject=>createPublicKey({key:Buffer.concat([SPKI,Buffer.from(hex,'hex')]),format:'der',type:'spki'});

/** The owner's mini app accepts a launch this long (seconds). */
export const OWNER_LAUNCH_MAX_AGE=86400;
/** The members' app accepts a launch this long (seconds): a member reopens it from the menu after an hour. */
export const MEMBER_LAUNCH_MAX_AGE=3600;
/** Launch data longer than this is refused unread. */
export const LAUNCH_MAX_BYTES=8192;

/** Who opened a Mini App, as the signed launch data says. `chat_type` is absent for the menu button and 'sender' for a
 * direct link in the user's own chat with the bot; any other value is refused before this is returned. */
export interface LaunchUser {user_id:string;auth_date:number;language_code?:string;chat_type?:'sender'}
export type LaunchUserCheck={botId:string;key:KeyObject;maxAgeSeconds:number;now?:number};
/** The owner's check: the owner's Telegram user id besides the bot and the key. */
export type LaunchCheck={botId:string;ownerId:string;key:KeyObject;now?:number;maxAgeSeconds?:number};

const TELEGRAM_ID=/^[1-9]\d{0,18}$/;

/** Every check but who the user is: size, one value per field, Telegram's signature for this bot, and the age (at most
 * 60 seconds ahead of this clock). Returns the fields and the user's id as signed, not yet checked. */
function signedLaunch(raw:string,check:{botId:string;key:KeyObject;maxAgeSeconds:number;now?:number}) {
  if(!raw||raw.length>LAUNCH_MAX_BYTES)throw new HttpError(401,'telegram_launch_required');
  const params=new URLSearchParams(raw),keys=[...params.keys()];
  if(new Set(keys).size!==keys.length)throw new HttpError(401,'telegram_launch_invalid');
  const signature=params.get('signature')??'';
  if(!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature))throw new HttpError(401,'telegram_launch_invalid');
  const fields=[...params].filter(([key])=>key!=='hash'&&key!=='signature').sort(([a],[b])=>a<b?-1:a>b?1:0);
  const data=check.botId+':WebAppData\n'+fields.map(([key,value])=>key+'='+value).join('\n');
  if(!verify(null,Buffer.from(data),check.key,Buffer.from(signature,'base64url')))throw new HttpError(401,'telegram_launch_invalid');
  const issued=Number(params.get('auth_date')),now=(check.now??Date.now())/1000;
  if(!Number.isSafeInteger(issued)||issued>now+60||now-issued>check.maxAgeSeconds)throw new HttpError(401,'telegram_launch_expired');
  let user:unknown;try{user=JSON.parse(params.get('user')??'');}catch{throw new HttpError(401,'telegram_launch_invalid');}
  const language=(user as {language_code?:unknown})?.language_code;
  return {params,issued,id:String((user as {id?:unknown})?.id??''),
    language:typeof language==='string'&&/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})?$/.test(language)?language.toLowerCase():undefined};
}

/**
 * Checks launch data for any Telegram user, within `maxAgeSeconds` (MEMBER_LAUNCH_MAX_AGE for the members' app): every
 * check verifyLaunch makes, and a `chat_type` other than absent or 'sender' (a launch from a group or another person's
 * chat) is refused. Throws HttpError 401 telegram_launch_required, telegram_launch_invalid or telegram_launch_expired;
 * it never says whether the user is anyone Nocheh knows.
 */
export function verifyLaunchUser(raw:string,check:LaunchUserCheck):LaunchUser {
  const launch=signedLaunch(raw,check);
  if(!TELEGRAM_ID.test(launch.id))throw new HttpError(401,'telegram_launch_invalid');
  const chatType=launch.params.get('chat_type');
  if(chatType!==null&&chatType!=='sender')throw new HttpError(401,'telegram_launch_invalid');
  return {user_id:launch.id,auth_date:launch.issued,...(launch.language?{language_code:launch.language}:{}),...(chatType==='sender'?{chat_type:'sender' as const}:{})};
}

/**
 * The owner's mini app: launch data within `maxAgeSeconds` (OWNER_LAUNCH_MAX_AGE by default) from the owner only, else
 * 403 owner_required. Its checks are unchanged by the members' app: the chat type is not read here.
 */
export function verifyLaunch(raw:string,check:LaunchCheck):{user_id:string;auth_date:number} {
  const launch=signedLaunch(raw,{...check,maxAgeSeconds:check.maxAgeSeconds??OWNER_LAUNCH_MAX_AGE});
  if(!TELEGRAM_ID.test(launch.id)||launch.id!==check.ownerId)throw new HttpError(403,'owner_required');
  return {user_id:launch.id,auth_date:launch.issued};
}

/** The fake Telegram's bot id in the installation fixture (tools/acceptance/telegram_mock.py). */
export const FIXTURE_BOT_ID='123456';
/** Thrown at start when TELEGRAM_LAUNCH_PUBLIC_KEY is set where it may not be honoured. */
export const FIXTURE_KEY_REFUSED='telegram_launch_fixture_key_refused';

/**
 * The key launch data is checked with in this process. Telegram's own key (TELEGRAM_TEST_ENVIRONMENT=true picks its test
 * key), unless TELEGRAM_LAUNCH_PUBLIC_KEY is set: that fixture key (64 hex characters, an Ed25519 public key) is honoured
 * only with NOCHEH_INSTALLATION_FIXTURE=1 and the fake bot's id FIXTURE_BOT_ID. Set anywhere else, or malformed, it
 * stops the process at start (FIXTURE_KEY_REFUSED) rather than being ignored, so a real installation never runs with a
 * key someone else holds. Neither variable is ever written into docker-compose.yml; the tester injects both.
 */
export function launchKey(env:Readonly<Record<string,string|undefined>>,botId:string):KeyObject {
  const fixture=env.TELEGRAM_LAUNCH_PUBLIC_KEY;
  if(fixture!==undefined&&fixture!=='') {
    if(env.NOCHEH_INSTALLATION_FIXTURE!=='1'||botId!==FIXTURE_BOT_ID||!/^[a-f0-9]{64}$/.test(fixture))throw Error(FIXTURE_KEY_REFUSED);
    return ed25519(fixture);
  }
  return ed25519(env.TELEGRAM_TEST_ENVIRONMENT==='true'?TELEGRAM_KEYS.test:TELEGRAM_KEYS.production);
}
