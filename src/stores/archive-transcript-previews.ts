import type pg from 'pg';

/** A short view of the first active transcript, never a replacement for source text. */
export async function archiveTranscriptPreviews(derived:pg.Pool,records:{id:string}[]):Promise<Map<string,string>> {
  if(!records.length)return new Map();
  const rows=(await derived.query(`SELECT DISTINCT ON (s.event_id) s.event_id,
      left(convert_from(d.content,'UTF8'),500) AS text
    FROM derivative_selections s
    JOIN derivative_selection_revisions r ON r.selection_id=s.id AND r.revision=s.active_revision
    JOIN derived_artifacts d ON d.id=r.derived_id
    WHERE s.event_id=ANY($1::text[]) AND s.kind='transcript' AND d.kind='transcript'
    ORDER BY s.event_id,s.artifact_id,d.id`,[records.map(row=>row.id)])).rows;
  return new Map(rows.map(row=>[row.event_id,row.text]));
}
