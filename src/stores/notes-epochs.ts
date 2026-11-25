import type pg from 'pg';

/** Which chats keep their Hermes notes across an epoch (ADR-0292): every chat, or only the owner's private chat, which reads
 *  every chat anyway. An epoch with no record starts every chat's notes fresh, so a change not named here never lets notes
 *  through. */
export type NotesKept='all'|'owner';

/** Record that the epoch just advanced to keeps notes for `keeps`. Call it in the same transaction that advanced it. */
export async function keepNotes(db:Pick<pg.PoolClient,'query'>,epoch:number,keeps:NotesKept):Promise<void> {
  await db.query(`INSERT INTO guard_notes_epochs(generation,epoch,keeps) SELECT generation,$1,$2 FROM installation WHERE singleton
    ON CONFLICT DO NOTHING`,[epoch,keeps]);
}

/** Whether a chat's Hermes notes written up to epoch `from` may carry into its profile for epoch `to` (ADR-0292): both in
 *  the current installation generation, `to` not past the current epoch, and every epoch after `from` up to `to` recorded
 *  as keeping notes for every chat, or for the owner's chat when `owner`. */
export async function notesCarry(db:Pick<pg.Pool,'query'>,generation:string,from:number,to:number,owner:boolean):Promise<boolean> {
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from)return false;
  const current=(await db.query('SELECT i.generation,g.epoch FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton')).rows[0];
  if(!current||current.generation!==generation||to>Number(current.epoch))return false;
  if(to===from)return true;
  const kept=(await db.query(`SELECT count(*)::int AS n FROM guard_notes_epochs WHERE generation=$1 AND epoch>$2 AND epoch<=$3
    AND (keeps='all' OR $4 AND keeps='owner')`,[generation,from,to,owner])).rows[0];
  return kept.n===to-from;
}
