import {fillLine} from './chat-labels.js';
import {escapeSourceLines,type TagBy} from './source-tags.js';

/*
 * A per-turn block of what Honcho learned (ADR-0261, B3.1): each fact on its own numbered line with the time of the
 * message it came from, under a source line code builds from the archive. Only model-written text (the summary and the
 * fact lines) is guarded; code-built lines are set between the guarded lines afterwards, so the guard check below must
 * find every fact line where it left it, or the block falls back to the engine's prose.
 */

/** The block's fixed words, as the model reads them. */
export const factBlockWords={
  through:', through {day}]',
  open:'[To open a fact\'s original: archive_read id={id} fact=<n>. Times are when the source message was sent.]',
  older:'[{count} older facts left out]',older_one:'[1 older fact left out]',
  source:'Source [by={by}]: {tag}',source_inexact:'Source [by={by}] ({why}): {tag}',
  batch:'not exact; learned with other messages',partial:'not exact; some of its messages are not available here',
  unavailable:'not available here',more_one:' (+1 source)',more:' (+{count} sources)',no_time:'--:--',
} as const;
/** The longest block a turn reads, in characters, as before (native-memory.ts contextCharacters). */
export const FACT_BLOCK_LIMIT=20000;

/** One fact as the block shows it. `tag` is its source line's tag at day precision, null when the reader may read none
 *  of its messages; `time` is that message's time of day in the reader's zone; `order` sorts it (the message's moment,
 *  else when the engine stored the fact). `batch` marks a fact known only with its learning batch. */
export interface BlockFact {conclusion:string;content:string;by:TagBy;exact:boolean;batch:boolean;cited:boolean;tag:string|null;time:string|null;order:number;more:number}
export interface PlannedFact extends BlockFact {n:number}
export interface FactBlockPlan {title:string;summaryTitle:string;summary:string;through:string|null;facts:PlannedFact[];left:number;text:string}

const chars=(text:string)=>Array.from(text).length;
/** A fact on one line: the engine may write newlines into it. */
const oneLine=(text:string)=>text.replace(/\s*[\r\n\u2028\u2029\u0085]+\s*/g,' ').trim();
const lineHead=(fact:PlannedFact)=>`${fact.n}. ${fact.time??factBlockWords.no_time}`;
const groupKey=(fact:BlockFact)=>`${fact.by}\u0000${fact.exact?1:0}\u0000${fact.batch?1:0}\u0000${fact.tag??''}`;
function sourceLine(fact:BlockFact):string {
  const tag=fact.tag??factBlockWords.unavailable;
  if(fact.exact||!fact.cited&&fact.tag===null)return fillLine(factBlockWords.source,{by:fact.by,tag});
  return fillLine(factBlockWords.source_inexact,{by:fact.by,why:fact.batch?factBlockWords.batch:factBlockWords.partial,tag});
}
const moreWords=(count:number)=>count<1?'':count===1?factBlockWords.more_one:fillLine(factBlockWords.more,{count:String(count)});

/** Facts grouped by their source line (its message's tag, by and exactness): groups oldest first by their first fact,
 *  lines oldest first inside a group, numbered in the order they read. */
function arranged(facts:readonly BlockFact[]):PlannedFact[] {
  const sorted=[...facts].sort((a,b)=>a.order-b.order||(a.conclusion<b.conclusion?-1:a.conclusion>b.conclusion?1:0));
  const groups=new Map<string,BlockFact[]>();
  for(const fact of sorted){const key=groupKey(fact);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(fact);}
  let n=0;return [...groups.values()].flat().map(fact=>({...fact,content:oneLine(fact.content),n:++n}));
}
/** The text the guard reads: the summary, a blank line, then one `n. HH:MM fact` line per fact. */
const modelText=(summary:string,facts:readonly PlannedFact[])=>
  [summary,facts.map(fact=>`${lineHead(fact)} ${fact.content}`).join('\n')].filter(Boolean).join('\n\n');

/** The block as the model reads it, from the guarded summary and fact lines (each line as guarded). */
function rendered(plan:Pick<FactBlockPlan,'title'|'summaryTitle'|'through'|'left'>,summary:string,facts:readonly PlannedFact[],lines:readonly string[],id:string):string {
  const parts:string[]=[];
  // The summary's header names the day of the last message it covers: `[conversation summary, through 2026-11-05]`.
  const head=plan.through&&plan.summaryTitle.endsWith(']')?plan.summaryTitle.slice(0,-1)+fillLine(factBlockWords.through,{day:plan.through}):plan.summaryTitle;
  if(summary.trim())parts.push(head+'\n'+escapeSourceLines(summary));
  if(facts.length) {
    const out=[plan.title,fillLine(factBlockWords.open,{id})];
    if(plan.left)out.push(plan.left===1?factBlockWords.older_one:fillLine(factBlockWords.older,{count:String(plan.left)}));
    facts.forEach((fact,index)=>{
      if(index===0||groupKey(fact)!==groupKey(facts[index-1]!))out.push(sourceLine(fact));
      out.push('  '+lines[index]+moreWords(fact.more));
    });
    parts.push(out.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * Plans a block: facts grouped and numbered, and the oldest left out until the whole block, its code-built lines
 * included, fits FACT_BLOCK_LIMIT. A summary alone too long is cut. `text` is what the guard reads.
 */
export function planFactBlock(input:{title:string;summaryTitle:string;summary:string;through:string|null;facts:readonly BlockFact[]},limit=FACT_BLOCK_LIMIT):FactBlockPlan {
  const summary=Array.from(input.summary.trim()).slice(0,limit).join('');
  // The block's own id is a 64-hex record id; its length is all the plan needs.
  const id='nocheh:memory:'+'0'.repeat(64);
  let kept=[...input.facts].sort((a,b)=>a.order-b.order||(a.conclusion<b.conclusion?-1:a.conclusion>b.conclusion?1:0)),left=0;
  for(;;) {
    const facts=arranged(kept),plan={title:input.title,summaryTitle:input.summaryTitle,through:input.through,left};
    const text=rendered(plan,summary,facts,facts.map(fact=>`${lineHead(fact)} ${fact.content}`),id);
    if(chars(text)<=limit||!kept.length)return {...plan,summary,facts,text:modelText(summary,facts)};
    // The oldest go first, a few at a time when far over.
    const over=chars(text)-limit,drop=Math.max(1,Math.min(kept.length,Math.floor(over/400)));
    kept=kept.slice(drop);left+=drop;
  }
}

/**
 * The block from its guarded text, or null when the guard changed the fact lines: each must still start with its own
 * `n. HH:MM ` and there must be as many as planned, after the summary and a blank line. Code-built lines go between them.
 */
export function renderFactBlock(plan:FactBlockPlan,guarded:string,id:string):string|null {
  const all=guarded.split('\n'),count=plan.facts.length;
  if(all.length<count)return null;
  const lines=all.slice(all.length-count),rest=all.slice(0,all.length-count);
  if(!lines.every((line,index)=>{const head=lineHead(plan.facts[index]!);return line===head||line.startsWith(head+' ');}))return null;
  if(count&&rest.length&&!(rest.at(-1)===''&&plan.summary))return null;
  if(count&&!rest.length&&plan.summary)return null;
  const summary=count?rest.slice(0,-1).join('\n'):rest.join('\n');
  if(!summary.trim()&&!count)return '';
  // A guard that lengthened a line can push the block past its limit; it is cut there, as every block was before.
  return Array.from(rendered(plan,summary,plan.facts,lines,id)).slice(0,FACT_BLOCK_LIMIT).join('');
}
