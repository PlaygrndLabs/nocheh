/*
 * When a schedule's clock fire may land (ADR-0290): an exact 5-field cron matcher in the schedule's own time zone. Hermes
 * still decides when a schedule is due; Nocheh only checks that the minute it fires on is one the expression names. It
 * reads the subset of croniter 6.2.4 that Hermes's phrases ("every weekday at 8am" is `0 8 * * 1-5`) and ordinary
 * 5-field strings use, and reads what it accepts as croniter does; anything else (6 or 7 fields, @aliases, L, W, #, H,
 * wrap-around ranges, a field's last value with a step such as `23/2`) is unsupported: refused when set by asking, and
 * an older schedule's clock fires with it are refused.
 */

/** A parsed expression: the values each field allows, and whether day-of-month or day-of-week counts as `*` (croniter's
 *  day_or rule). */
export interface Cron {minute:ReadonlySet<number>;hour:ReadonlySet<number>;dom:ReadonlySet<number>;month:ReadonlySet<number>;dow:ReadonlySet<number>;
  domStar:boolean;dowStar:boolean}

const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const DAYS=['sun','mon','tue','wed','thu','fri','sat'];
/** [min, max of a value, max a `*` or `a/s` runs to]; day-of-week takes 7 as Sunday, but `*` and `a/s` stop at Saturday. */
const BOUNDS:[number,number,number][]=[[0,59,59],[0,23,23],[1,31,31],[1,12,12],[0,7,6]];

function value(text:string,index:number):number|null {
  if(/^\d{1,2}$/.test(text))return Number(text);
  const names=index===3?MONTHS:index===4?DAYS:null,at=names?names.indexOf(text):-1;
  return at<0?null:index===3?at+1:at;
}
function field(raw:string,index:number):Set<number>|null {
  const [min,max,top]=BOUNDS[index]!,found=new Set<number>();
  if(raw==='?')return index===2||index===4?expand(min,top,1,found,index):null;
  for(const item of raw.split(',')) {
    const match=/^([^/]+)(?:\/(\d{1,2}))?$/.exec(item);if(!match)return null;
    const step=match[2]===undefined?1:Number(match[2]),base=match[1]!;
    if(step<1)return null;
    let from:number,to:number;
    if(base==='*'){from=min;to=top;}
    else if(base.includes('-')) {
      const [a,b,...rest]=base.split('-');if(rest.length)return null;
      const start=value(a!,index),end=value(b!,index);
      if(start===null||end===null||start>=end)return null;from=start;to=end;
    }
    else {
      const single=value(base,index);if(single===null)return null;
      // croniter reads `a/s` as `a-top/s`, and a range that starts on its own end as the whole field: `23/2` is every
      // other hour from 0 and `sat/2` every other day from Sunday. Such an item is refused rather than read that way.
      if(match[2]!==undefined&&(single===top||index===4&&single===7))return null;
      from=single;to=match[2]===undefined?single:top;
    }
    if(from<min||to>max||from>to)return null;
    expand(from,to,step,found,index);
  }
  return found;
}
function expand(from:number,to:number,step:number,into:Set<number>,index:number):Set<number> {
  for(let at=from;at<=to;at+=step)into.add(index===4&&at===7?0:at);return into;
}
const all=(values:ReadonlySet<number>,min:number,max:number)=>{for(let at=min;at<=max;at++)if(!values.has(at))return false;return true;};

/** The expression's fields, or null when it is not one this matcher reads exactly. */
export function parseCron(expr:unknown):Cron|null {
  if(typeof expr!=='string'||expr.length>256)return null;
  const raw=expr.trim().toLowerCase().split(/\s+/);if(raw.length!==5)return null;
  const sets=raw.map((text,index)=>field(text,index));if(sets.some(set=>set===null))return null;
  const [minute,hour,dom,month,dow]=sets as Set<number>[];
  // croniter: a day field counts as `*` when written so, or when it names every day and the other one has a `*` in it.
  const domStar=raw[2]==='*'||raw[2]==='?'||all(dom!,1,31)&&raw[4]!.includes('*');
  const dowStar=raw[4]==='*'||raw[4]==='?'||all(dow!,0,6)&&raw[2]!.includes('*');
  return {minute:minute!,hour:hour!,dom:dom!,month:month!,dow:dow!,domStar,dowStar};
}

const formats=new Map<string,Intl.DateTimeFormat>();
/** The wall clock in `zone` at `instant`; null for a zone this runtime does not know. */
export function localFields(instant:number,zone:string):{year:number;month:number;day:number;hour:number;minute:number;weekday:number}|null {
  let format=formats.get(zone);
  if(!format) {
    try{format=new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',weekday:'short'});}
    catch{return null;}
    if(formats.size>256)formats.clear();formats.set(zone,format);
  }
  const parts=Object.fromEntries(format.formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
  const weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(String(parts.weekday));
  if(weekday<0)return null;
  return {year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),hour:Number(parts.hour)%24,minute:Number(parts.minute),weekday};
}

/** Whether the minute of `instant`, on the wall clock of `zone`, is one the expression names. A spring-forward gap's
 *  time is read as the clock the instant lands on, so such a fire does not match (known limit). */
export function cronMatches(cron:Cron|string,instant:number,zone:string):boolean {
  const parsed=typeof cron==='string'?parseCron(cron):cron;
  if(!parsed||!Number.isFinite(instant))return false;
  const local=localFields(instant,zone);if(!local)return false;
  if(!parsed.minute.has(local.minute)||!parsed.hour.has(local.hour)||!parsed.month.has(local.month))return false;
  const dom=parsed.dom.has(local.day),dow=parsed.dow.has(local.weekday);
  return !parsed.domStar&&!parsed.dowStar?dom||dow:dom&&dow;
}

/** Whether `zone` is an IANA name this runtime knows. */
export function knownZone(zone:string):boolean {return localFields(0,zone)!==null;}
