import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';

/** One kind of report: which rule, what it would block, and on which page. */
export type ScriptReportKind={directive:string;blocked:string;page:string;count:number;first_at:string;last_at:string};
/** What the browser reported about the Hermes page's script rules: how many, since when, and of which kinds. */
export type ScriptReports={total:number;first_at:string|null;last_at:string|null;kinds:ScriptReportKind[]};
/** Kinds kept with their details; reports of further kinds still count in the total. */
export const MAX_KINDS=50;
/** A report body larger than this is refused. */
export const MAX_REPORT_BYTES=8*1024;

const clean=(value:unknown,pattern:RegExp,fallback:string)=>typeof value==='string'&&pattern.test(value)?value:fallback;
/** Only a scheme and host, or a keyword such as inline or eval: never a path, query or page text. */
function blockedSource(value:unknown):string {
  if(typeof value!=='string'||!value)return 'unknown';
  if(/^[a-z-]{1,20}$/.test(value))return value;
  try {
    const url=new URL(value);
    return ['http:','https:','ws:','wss:'].includes(url.protocol)?url.origin:url.protocol.replace(/:$/,'');
  } catch {return 'other';}
}
/** The page's path, without its query, where tokens or tickets may be. */
function pagePath(value:unknown):string {
  try {return new URL(String(value)).pathname.replace(/[^\x21-\x7e]/g,'').slice(0,120)||'/';} catch {return 'unknown';}
}

/**
 * Counts the browser's reports about the Hermes page's script rules while they are only reported (ADR-0251).
 * It keeps the rule, the blocked address's site and the page's path, never page content or a script sample, and
 * saves them in the dashboard's state, where `./bin/nocheh diagnose` reads them.
 */
export class ScriptReportLog {
  private state:ScriptReports={total:0,first_at:null,last_at:null,kinds:[]};
  private loaded:Promise<void>;
  private saving:Promise<void>=Promise.resolve();
  private timer:NodeJS.Timeout|undefined;
  constructor(private path:string,private now=()=>new Date(),private delay=2000) {
    this.loaded=readFile(path,'utf8').then(raw=>{
      const value=JSON.parse(raw) as ScriptReports;
      if(Number.isSafeInteger(value.total)&&Array.isArray(value.kinds))this.state={total:value.total,first_at:value.first_at??null,last_at:value.last_at??null,kinds:value.kinds.slice(0,MAX_KINDS)};
    }).catch(()=>{});
  }
  /** Records one report as the browser sends it: report-uri's {"csp-report": …}, or a list of Reporting API reports. */
  async record(body:unknown):Promise<void> {
    await this.loaded;
    const reports=(Array.isArray(body)?body.map(item=>(item as {body?:unknown})?.body):[(body as {'csp-report'?:unknown})?.['csp-report']])
      .filter((item):item is Record<string,unknown>=>!!item&&typeof item==='object').slice(0,20);
    for(const report of reports) {
      const at=this.now().toISOString();
      const directive=clean(report['effective-directive']??report.effectiveDirective??report['violated-directive'],/^[a-z-]{1,40}$/,'unknown');
      const blocked=blockedSource(report['blocked-uri']??report.blockedURL);
      const page=pagePath(report['document-uri']??report.documentURL);
      this.state.total++;this.state.first_at??=at;this.state.last_at=at;
      const known=this.state.kinds.find(kind=>kind.directive===directive&&kind.blocked===blocked&&kind.page===page);
      if(known){known.count++;known.last_at=at;}
      else if(this.state.kinds.length<MAX_KINDS) {
        this.state.kinds.push({directive,blocked,page,count:1,first_at:at,last_at:at});
        // One quiet log line per new kind, for `./bin/nocheh logs`.
        console.log(JSON.stringify({event:'hermes_page_script_report',directive,blocked,page}));
      }
    }
    if(reports.length&&!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.save();},this.delay);this.timer.unref();}
  }
  summary():ScriptReports {return structuredClone(this.state);}
  /** Writes what is counted so far; also called on shutdown. */
  async save():Promise<void> {
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    const value=JSON.stringify(this.state);
    this.saving=this.saving.then(async()=>{
      await mkdir(dirname(this.path),{recursive:true,mode:0o700});
      const temporary=this.path+'.'+randomBytes(6).toString('hex')+'.tmp';
      const file=await open(temporary,'wx',0o600);
      try {await file.writeFile(value);await file.sync();} finally {await file.close();}
      await rename(temporary,this.path);
    }).catch(()=>{});
    return this.saving;
  }
}
