import type {KeyKind,Reader} from '../access.js';
import {HttpError} from '../http.js';
import {relayRoutes} from '../security/relay-routes.js';
import {assertPrivateAnswerRoute,memberReadRoutes} from './private-answers.js';
import {assertMachineRunRoute} from './machine-reads.js';

/**
 * The routes a reply's or run's key reaches (ADR-0301): every data route the broker relays for a turn, and the turn's own
 * binding, files, box copy, data tools, guard preparation, model calls and conversation report. Everything else storage
 * serves is the owner's dashboard API, which only the owner's admin bearer reaches.
 */
const turnRoutes:readonly [string,RegExp][]=[
  ...relayRoutes,
  ['GET',/^\/v1\/(?:security\/binding|turn-files\/[a-f0-9]{64}|box\/chat)$/],
  ['POST',/^\/(?:mcp|v1\/(?:guard|chat\/completions|turn\/conversation-reads)|anthropic\/v1\/messages)$/],
];
/**
 * A memory review's key: the delivery check, its binding, context preparation (its notes go through prepared context),
 * guard preparation and model calls. No data tool and no read route, whatever the review's own checks would allow.
 */
const reviewRoutes:readonly [string,RegExp][]=[
  ['GET',/^\/v1\/(?:memory\/check|security\/binding)$/],
  ['POST',/^\/(?:v1\/(?:context\/prepare|guard|chat\/completions)|anthropic\/v1\/messages)$/],
];
/** A sharing filter's key: its binding, guard preparation and model calls only. */
const filterRoutes:readonly [string,RegExp][]=[
  ['GET',/^\/v1\/security\/binding$/],
  ['POST',/^\/(?:v1\/(?:guard|chat\/completions)|anthropic\/v1\/messages)$/],
];
/** Each key kind's routes. The owner's ask about a member keeps its own read list (private-answers.ts). */
export const keyRoutes:Readonly<Record<KeyKind,readonly [string,RegExp][]>>={turn:turnRoutes,follow_up:turnRoutes,scheduled:turnRoutes,
  background:turnRoutes,member_ask:memberReadRoutes,review:reviewRoutes,filter:filterRoutes};
/** Whether a key of `kind` may call a route. */
export function keyRoute(kind:KeyKind,method:string,path:string):boolean {return keyRoutes[kind].some(([verb,route])=>verb===method&&route.test(path));}
/**
 * Refuses a pass anything its key does not reach (ADR-0301): a bound reader keeps its read-only codes (ADR-0249, step 4),
 * a machine job's run its card-only code, and then every key is held to its kind's routes (403 one_time_key_route_denied).
 * The owner's admin bearer has no key and is not held here.
 */
export function assertKeyRoute(principal:Reader,method:string|undefined,path:string):void {
  if(principal.admin)return;
  assertPrivateAnswerRoute(principal,method,path);
  assertMachineRunRoute(principal,method,path);
  if(!principal.keyKind||!keyRoute(principal.keyKind,method??'',path))throw new HttpError(403,'one_time_key_route_denied');
}
