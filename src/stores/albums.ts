import type pg from 'pg';

/** Album parts arrive in one poll; a part younger than this may still have siblings on the way. */
export const albumSettleMs=2000;

export type AlbumMember={id:string;age_ms:number};

/**
 * Telegram sends an album as separate messages that share a media group. The
 * live parts captured in the same chat within ten minutes of this one, in
 * Telegram update order; empty when the message is not part of an album.
 */
export async function albumMembers(archive:pg.Pool,eventId:string):Promise<AlbumMember[]> {
  const own=(await archive.query(`SELECT scope,received_at,convert_from(payload,'UTF8')::jsonb->'message'->>'media_group_id' AS album FROM events
    WHERE id=$1 AND channel='telegram' AND kind='telegram_update' AND origin='live'`,[eventId])).rows[0];
  if(typeof own?.album!=='string'||!own.album)return [];
  return (await archive.query(`SELECT id,(extract(epoch FROM now()-received_at)*1000)::bigint AS age_ms FROM (
      SELECT id,received_at,convert_from(payload,'UTF8')::jsonb AS update FROM events
      WHERE scope=$1 AND channel='telegram' AND kind='telegram_update' AND origin='live'
      AND received_at BETWEEN $2::timestamptz-interval '10 minutes' AND $2::timestamptz+interval '10 minutes') nearby
    WHERE update->'message'->>'media_group_id'=$3
    ORDER BY CASE WHEN update->>'update_id' ~ '^[0-9]{1,19}$' THEN (update->>'update_id')::numeric END NULLS LAST,received_at,id LIMIT 20`,
    [own.scope,own.received_at,own.album])).rows.map(row=>({id:row.id as string,age_ms:Number(row.age_ms)}));
}
