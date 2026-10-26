import {HttpError,object,string} from '../http.js';

/**
 * How tasks are described: statuses, priority names, the owner's own columns
 * and the time zone dates and reminders mean. Every name is the owner's to
 * change in Settings › Tasks; only these defaults live in code.
 */
export type StatusCategory='not_started'|'active'|'done'|'cancelled';
export type TaskColor='neutral'|'info'|'warn'|'good'|'bad'|'accent';
export type TaskStatus={id:string;name:string;category:StatusCategory;color:TaskColor};
export type TaskPriority={level:number;name:string;color:TaskColor};
export type PropertyType='text'|'number'|'select'|'multi_select'|'date'|'checkbox'|'url'|'person';
export type PropertyOption={id:string;name:string;color:TaskColor};
export type TaskProperty={id:string;name:string;type:PropertyType;options:PropertyOption[]};
export type TaskSettings={statuses:TaskStatus[];priorities:TaskPriority[];properties:TaskProperty[];time_zone:string};

export const categories:StatusCategory[]=['not_started','active','done','cancelled'];
export const colors:TaskColor[]=['neutral','info','warn','good','bad','accent'];
export const propertyTypes:PropertyType[]=['text','number','select','multi_select','date','checkbox','url','person'];
/** The coarse state the lists, counts and chat use: open work, finished, or dropped. */
export const stateOf=(category:StatusCategory)=>category==='done'?'done':category==='cancelled'?'dropped':'open';

export const defaultTaskSettings:TaskSettings={
  statuses:[
    {id:'todo',name:'To do',category:'not_started',color:'neutral'},
    {id:'doing',name:'In progress',category:'active',color:'info'},
    {id:'waiting',name:'Waiting',category:'active',color:'warn'},
    {id:'done',name:'Done',category:'done',color:'good'},
    {id:'dropped',name:'Dropped',category:'cancelled',color:'bad'},
  ],
  priorities:[
    {level:0,name:'No priority',color:'neutral'},{level:1,name:'Low',color:'neutral'},{level:2,name:'Medium',color:'info'},
    {level:3,name:'High',color:'warn'},{level:4,name:'Urgent',color:'bad'},
  ],
  properties:[],
  time_zone:'UTC',
};

const name=(value:unknown,code:string)=>{const text=string(value,200).trim().replace(/\s+/g,' ');if(!text||text.length>40)throw new HttpError(400,code);return text;};
const key=(value:unknown,code:string)=>{const text=string(value,40);if(!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(text))throw new HttpError(400,code);return text;};
const color=(value:unknown):TaskColor=>value===undefined?'neutral':colors.includes(value as TaskColor)?value as TaskColor:(()=>{throw new HttpError(400,'invalid_task_color');})();
/** An IANA time zone such as Asia/Tehran, as this server's clock knows it. */
export function timeZone(value:unknown):string {
  const text=string(value,64);
  try{if(!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(text)&&text!=='UTC')throw 0;new Intl.DateTimeFormat('en',{timeZone:text});return text;}
  catch{throw new HttpError(400,'invalid_task_time_zone');}
}
const unique=<T>(items:T[],id:(item:T)=>string,code:string)=>{if(new Set(items.map(item=>id(item).toLocaleLowerCase())).size!==items.length)throw new HttpError(400,code);return items;};

/** The owner's settings, checked as a whole; any part left out keeps its default. */
export function readTaskSettings(input:unknown):TaskSettings {
  const body=object(input);
  if(Object.keys(body).some(field=>!['statuses','priorities','properties','time_zone'].includes(field)))throw new HttpError(400,'unknown_task_setting');
  const statuses=body.statuses===undefined?defaultTaskSettings.statuses:(()=>{
    if(!Array.isArray(body.statuses)||!body.statuses.length||body.statuses.length>20)throw new HttpError(400,'invalid_task_statuses');
    const rows=body.statuses.map(item=>{const row=object(item);
      if(!categories.includes(row.category as StatusCategory))throw new HttpError(400,'invalid_task_status');
      return {id:key(row.id,'invalid_task_status'),name:name(row.name,'invalid_task_status'),category:row.category as StatusCategory,color:color(row.color)};});
    unique(rows,row=>row.id,'duplicate_task_status');unique(rows,row=>row.name,'duplicate_task_status');
    // Each kind of state keeps at least one status, so every task always has somewhere to be.
    if(categories.some(category=>!rows.some(row=>row.category===category)))throw new HttpError(400,'task_status_category_required');
    return rows;
  })();
  const priorities=body.priorities===undefined?defaultTaskSettings.priorities:(()=>{
    if(!Array.isArray(body.priorities)||body.priorities.length!==5)throw new HttpError(400,'invalid_task_priorities');
    const rows=body.priorities.map((item,level)=>{const row=object(item);if(row.level!==level)throw new HttpError(400,'invalid_task_priorities');
      return {level,name:name(row.name,'invalid_task_priority'),color:color(row.color)};});
    return unique(rows,row=>row.name,'duplicate_task_priority');
  })();
  const properties=body.properties===undefined?defaultTaskSettings.properties:(()=>{
    if(!Array.isArray(body.properties)||body.properties.length>30)throw new HttpError(400,'invalid_task_properties');
    const rows=body.properties.map(item=>{const row=object(item);
      if(!propertyTypes.includes(row.type as PropertyType))throw new HttpError(400,'invalid_task_property');
      const choices=row.type==='select'||row.type==='multi_select';
      if(!choices&&row.options!==undefined&&!(Array.isArray(row.options)&&!row.options.length))throw new HttpError(400,'invalid_task_property');
      const options=!choices?[]:(()=>{
        if(!Array.isArray(row.options)||row.options.length>50)throw new HttpError(400,'invalid_task_property');
        return unique(row.options.map(option=>{const value=object(option);return {id:key(value.id,'invalid_task_property'),name:name(value.name,'invalid_task_property'),color:color(value.color)};}),
          option=>option.name,'duplicate_task_option');
      })();
      unique(options,option=>option.id,'duplicate_task_option');
      return {id:key(row.id,'invalid_task_property'),name:name(row.name,'invalid_task_property'),type:row.type as PropertyType,options};});
    unique(rows,row=>row.id,'duplicate_task_property');return unique(rows,row=>row.name,'duplicate_task_property');
  })();
  return {statuses,priorities,properties,time_zone:body.time_zone===undefined?defaultTaskSettings.time_zone:timeZone(body.time_zone)};
}

/** Stored settings over the defaults; a stored part that no longer reads keeps the default. */
export function storedTaskSettings(value:unknown):TaskSettings {
  const stored=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const settings={...defaultTaskSettings};
  for(const part of ['statuses','priorities','properties','time_zone'] as const)
    if(stored[part]!==undefined)try{(settings as any)[part]=(readTaskSettings({[part]:stored[part]}) as any)[part];}catch{}
  return settings;
}

export type Repeat={every:number;unit:'day'|'week'|'month'|'year';weekdays?:number[];from:'due'|'done'};
/** How a task repeats: every N days, weeks (optionally on chosen weekdays, 0 is Sunday), months or years. */
export function readRepeat(value:unknown):Repeat|null {
  if(value===null||value===undefined)return null;
  const body=object(value);
  if(Object.keys(body).some(field=>!['every','unit','weekdays','from'].includes(field)))throw new HttpError(400,'invalid_task_repeat');
  const every=body.every===undefined?1:body.every,unit=body.unit,from=body.from??'due';
  if(!Number.isSafeInteger(every)||Number(every)<1||Number(every)>365||!['day','week','month','year'].includes(String(unit))||!['due','done'].includes(String(from)))
    throw new HttpError(400,'invalid_task_repeat');
  const repeat:Repeat={every:Number(every),unit:unit as Repeat['unit'],from:from as Repeat['from']};
  if(body.weekdays!==undefined&&body.weekdays!==null){
    if(unit!=='week'||!Array.isArray(body.weekdays)||!body.weekdays.length||body.weekdays.some(day=>!Number.isSafeInteger(day)||day<0||day>6))throw new HttpError(400,'invalid_task_repeat');
    repeat.weekdays=[...new Set(body.weekdays as number[])].sort();
  }
  return repeat;
}

const DAY=86400000;
const parse=(day:string)=>Date.parse(day+'T00:00:00Z');
const format=(time:number)=>new Date(time).toISOString().slice(0,10);
export const addDays=(day:string,days:number)=>format(parse(day)+days*DAY);
export const daysBetween=(from:string,to:string)=>Math.round((parse(to)-parse(from))/DAY);
/** A month or year later, on the same day of the month or the last day of a shorter month. */
function addMonths(day:string,months:number):string {
  const [year,month,date]=day.split('-').map(Number) as [number,number,number],index=year*12+month-1+months;
  const last=new Date(Date.UTC(Math.floor(index/12),index%12+1,0)).getUTCDate();
  return format(Date.UTC(Math.floor(index/12),index%12,Math.min(date,last)));
}
/** The next day after `day` that a repeat lands on. */
export function nextRepeat(day:string,repeat:Repeat):string {
  if(repeat.unit==='day')return addDays(day,repeat.every);
  if(repeat.unit==='month')return addMonths(day,repeat.every);
  if(repeat.unit==='year')return addMonths(day,12*repeat.every);
  if(!repeat.weekdays)return addDays(day,7*repeat.every);
  // Later chosen days in the same week first, then the chosen days every N weeks on.
  const weekStart=(value:string)=>parse(value)-new Date(parse(value)).getUTCDay()*DAY;
  for(let offset=1;offset<=7*repeat.every+7;offset++){
    const candidate=addDays(day,offset),weeks=Math.round((weekStart(candidate)-weekStart(day))/(7*DAY));
    if(repeat.weekdays.includes(new Date(parse(candidate)).getUTCDay())&&weeks%repeat.every===0)return candidate;
  }
  return addDays(day,7*repeat.every);
}
