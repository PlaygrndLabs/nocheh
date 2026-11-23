/**
 * Memory walls (ADR-0283): one per set of chats whose memory is read together. A group's turns read through the wall
 * of the chats its recall reads (its own conversation, its group with every topic, or every group of its project while
 * the project shares its group chats). The engine keeps each read inside the wall: Honcho answers from the wall's own
 * view, with a key that opens nothing else. The owner's private chat and every private chat are never in a wall.
 *
 * A wall is named by its chats, so a change of the chats a reader reads (sharing turned on or off, a group joining or
 * leaving a project, a new topic) names a new wall, built from scratch; a wall never loses a chat while in use. What a
 * session already learned is copied into the wall without a model, in the background, and a read waits for that copy.
 * New sessions of a wall's chats join it before their first write, so what they learn reaches the wall as it is learned.
 */
import type pg from 'pg';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {groupSpace} from '../spaces.js';
import type {MemoryEngine} from '../memory/engine.js';

/** The same chats always make the same wall, and any change of them makes another. */
export const memoryWallName=(workspace:string,chats:readonly string[])=>
  'wall-'+digest(canonical(['nocheh-memory-wall-v1',workspace,[...new Set(chats)].sort()])).slice(0,40);
/** How long a read waits for what a wall's sessions already learned to reach it; the copy takes about a second. */
export const wallWaitMs=20000;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class MemoryWalls {
  constructor(readonly control:Pick<pg.Pool,'query'>,readonly engine:MemoryEngine,readonly waitMs=wallWaitMs){}
  /** Whether the engine keeps reads inside walls; without, Nocheh limits reads by sessions as before. */
  get supported(){return !!this.engine.openWall&&!!this.engine.wallReady;}
  /** The walls a new session of this audience joins: every wall that holds its chat. */
  async of(workspace:string,audience:string):Promise<string[]> {
    if(!this.supported||!groupSpace(audience))return [];
    return (await this.control.query(`SELECT wall FROM memory_walls WHERE workspace=$1 AND chats ? $2 ORDER BY wall`,[workspace,audience])).rows.map(row=>String(row.wall));
  }
  /**
   * The wall of these chats, holding every session of theirs with a completed write, and those sessions. Null when the
   * engine has no walls. Only groups and topics are ever in a wall: any other chat is dropped, and none left refuses.
   * A wall whose copy is not done within the wait is refused (memory_wall_syncing): the read fails closed.
   */
  async open(workspace:string,chats:readonly string[]):Promise<{wall:string;sessions:string[]}|null> {
    if(!this.supported)return null;
    const ids=[...new Set(chats)].filter(chat=>groupSpace(chat)).sort();
    if(!ids.length)throw new HttpError(409,'memory_wall_empty');
    const wall=memoryWallName(workspace,ids);
    const sessions=(await this.control.query(`SELECT s.session_id FROM memory_sessions s WHERE s.workspace=$1 AND s.audience=ANY($2::text[])
      AND EXISTS(SELECT 1 FROM memory_ingestion_receipts r WHERE r.session_id=s.session_id AND r.retired_at IS NULL AND r.state='done')
      ORDER BY s.session_id`,[workspace,ids])).rows.map(row=>String(row.session_id));
    const row=(await this.control.query('SELECT members,ready FROM memory_walls WHERE workspace=$1 AND wall=$2',[workspace,wall])).rows[0];
    const held=new Set<string>(row?.members??[]),missing=sessions.filter(session=>!held.has(session));
    if(!row||missing.length) {
      await this.engine.openWall!(workspace,wall,missing);
      await this.control.query(`INSERT INTO memory_walls(workspace,wall,chats,members,ready) VALUES($1,$2,$3,$4,false)
        ON CONFLICT(workspace,wall) DO UPDATE SET members=ARRAY(SELECT DISTINCT unnest(memory_walls.members||EXCLUDED.members) ORDER BY 1),ready=false,updated_at=now()`,
        [workspace,wall,JSON.stringify(ids),missing]);
    } else if(row.ready)return {wall,sessions};
    const until=Date.now()+this.waitMs;
    for(;;) {
      if(await this.engine.wallReady!(workspace,wall)) {
        await this.control.query('UPDATE memory_walls SET ready=true,updated_at=now() WHERE workspace=$1 AND wall=$2 AND members@>$3::text[]',[workspace,wall,sessions]);
        return {wall,sessions};
      }
      if(Date.now()>=until)throw new HttpError(409,'memory_wall_syncing');
      await pause(Math.min(250,Math.max(0,until-Date.now())));
    }
  }
}
