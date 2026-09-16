import {lazy,Suspense,useState} from 'react';
import {useResource} from '../lib/resource';
import {Alert,Skeleton} from './ui/primitives';
import type {Metrics} from './workflow-charts';
const Charts=lazy(()=>import('./workflow-charts'));
const familyNames:Record<string,string>={preparation:'Source preparation',telegram:'Telegram',imports:'Imports',memory_review:'Memory review',honcho:'Honcho',browser:'Browser turns',schedules:'Schedules',actions:'Approved messages',tools:'Controlled tools'};
export function Analytics({compact=false,counts=null}:{compact?:boolean;counts?:{family:string;state:string;count:number}[]|null}){
 const [range,setRange]=useState<'24h'|'7d'>('24h'),[family,setFamily]=useState('');
 const {data,error,loading}=useResource<Metrics>('/workflows/metrics?'+new URLSearchParams({range,family}),60000);
 const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 return <section className="n-panel analytics"><div className="analytics-heading"><div><h2>{compact?'Activity over time':'Workflow trends'}</h2><p className="n-muted">{compact?'Last 24 hours':'Persisted workflow evidence'} · {zone}</p></div>{!compact&&<div className="chart-filters"><label>Period<select aria-label="Chart period" value={range} onChange={e=>setRange(e.target.value as '24h'|'7d')}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></label><label>Chart family<select aria-label="Chart family" value={family} onChange={e=>setFamily(e.target.value)}><option value="">All families</option>{Object.entries(familyNames).map(([id,name])=><option value={id} key={id}>{name}</option>)}</select></label></div>}</div>
 {error&&<Alert>{data?'Historical charts show the last successful observation and may be stale.':'Historical metrics are unavailable. No counts or durations can be inferred.'}</Alert>}
 {!data&&!error&&<div role="status" aria-label="Loading historical charts"><Skeleton className="chart-skeleton"/></div>}
 {data&&<Suspense fallback={<Skeleton className="chart-skeleton"/>}><Charts metrics={data} compact={compact} counts={counts}/></Suspense>}
 {data&&<p className="chart-note">Observed {new Date(data.observed_at).toLocaleString()} · {loading?'Refreshing…':'Refreshes every 60 seconds'}{!compact&&' · Late reconciliation can update confirmed outcomes.'}</p>}
 </section>;
}
