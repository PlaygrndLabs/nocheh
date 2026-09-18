import type {IncomingMessage,ServerResponse} from 'node:http';
import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object,readJson,json} from '../http.js';
import {manifest,decide,validatePolicy} from './contract.js';
import {configuration,savePolicy,effectLog,policySnapshot} from './store.js';
import {controlledAction} from '../controlled-actions.js';

export async function ownerSecurityRoute(pool:pg.Pool,principal:Reader,req:IncomingMessage,res:ServerResponse,url:URL,options:{separated?:boolean}={}) {
  if(!url.pathname.startsWith('/v1/security/'))return false;
  admin(principal);
  if(url.pathname==='/v1/security/plugin'&&req.method==='GET'){json(res,200,manifest);return true;}
  if(url.pathname==='/v1/security/policy') {
    if(req.method==='GET'){json(res,200,await configuration(pool,principal));return true;}
    if(req.method==='POST'){json(res,200,await savePolicy(pool,principal,await readJson(req)));return true;}
  }
  if(url.pathname==='/v1/security/effects'&&req.method==='GET'){
    json(res,200,await effectLog(pool,principal,url.searchParams.get('after')??'0',url.searchParams.get('effect')??undefined));return true;
  }
  if(url.pathname==='/v1/security/preview'&&req.method==='POST') {
    if(options.separated)throw new HttpError(503,'action_preview_unavailable');
    const body=object(await readJson(req)),row=await controlledAction(pool,principal,body.action_id);
    const snapshot=await policySnapshot(pool),policy=body.policy===undefined?snapshot.policy:validatePolicy(body.policy);
    const effect={id:row.id,kind:row.kind as 'shell'|'browser'|'mcp',scope:row.scope,profile:row.profile,fingerprint:row.fingerprint,...(row.job_id?{job:row.job_id}:{})};
    const grants=(await pool.query(`SELECT id,remaining,expires_at FROM action_permissions WHERE fingerprint=$1 AND remaining>0 AND expires_at>now() AND revoked_at IS NULL
      AND (job_id IS NULL OR job_id=$2) ORDER BY expires_at`,[row.fingerprint,row.job_id])).rows;
    json(res,200,{effect,decision:decide(policy,snapshot.revision,effect,{...(row.state==='approved'?{grant:'exact_owner_approval'}:grants[0]?{grant:grants[0].id}:{})}),grants,
      consumes_permission:false,execution:false,candidate_policy:body.policy!==undefined});return true;
  }
  throw new HttpError(404,'security_route_not_found');
}
