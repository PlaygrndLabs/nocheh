import type pg from 'pg';

export type ActionReviewSummary={id:string;state:string;count:number};
type ActionRow={id:string;event_id:string;state:string};

const priority:Record<string,number>={proposed:0,approved:1,running:2,ambiguous:3,done:4,rejected:5,cancelled:6};

/** Keep the most actionable request visible when one source proposed several. */
export function summarizeActionReviews(rows:ActionRow[]):Map<string,ActionReviewSummary>{
 const reviews=new Map<string,ActionReviewSummary>();
 for(const row of rows){
  const previous=reviews.get(row.event_id);
  if(!previous){reviews.set(row.event_id,{id:row.id,state:row.state,count:1});continue;}
  const selected=(priority[row.state]??99)<(priority[previous.state]??99)?row:previous;
  reviews.set(row.event_id,{id:selected.id,state:selected.state,count:previous.count+1});
 }
 return reviews;
}

export async function actionReviews(pool:pg.Pool,eventIds:string[],layout:'legacy'|'separated'){
 if(!eventIds.length)return new Map<string,ActionReviewSummary>();
 const sql=layout==='legacy'
  ?'SELECT id,event_id,state FROM action_requests WHERE event_id=ANY($1::text[]) ORDER BY created_at DESC,id DESC'
  :"SELECT id,source_reference->>'id' AS event_id,state FROM telegram_action_requests WHERE source_reference->>'id'=ANY($1::text[]) ORDER BY created_at DESC,id DESC";
 const rows=(await pool.query<ActionRow>(sql,[eventIds])).rows;
 return summarizeActionReviews(rows);
}
