import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError} from '../http.js';
import {sourceLines} from '../prompts.js';
import {countMemoryStep,type NoteSourceRepository} from './note-sources.js';
import type {SourceRetirementRepository} from './source-retirement.js';

/**
 * An original message as the owner's dashboard links it (ADR-0261 step 4): its id, a short label in the owner's own
 * words and when it was sent. A retired message is never shown as an original: it reads only `retired`. When the label
 * or the retirement check can't be made, it reads "Source not available right now" with no id to open (it fails
 * closed, ADR-0257), and the failure is counted as a `source_tags` problem; a message the archive does not hold reads
 * "Source not recorded", also without an id.
 */
export type Original={id:string;label:string;at:string|null;forward?:string}|{retired:true}|{unavailable:true;label:string};

/** The most originals one dashboard request labels. */
export const ORIGINALS_LIMIT=200;

export class OwnerOriginals {
  constructor(readonly control:Pick<pg.Pool,'query'>,readonly notes:Pick<NoteSourceRepository,'ownerEventLabels'|'ownerWords'>,
    readonly retirements:Pick<SourceRetirementRepository,'retiredEvents'>){}

  /** Each of these messages (full ids only, at most ORIGINALS_LIMIT), by id, in one batch of reads. */
  async originals(ids:readonly string[]):Promise<Map<string,Original>> {
    const wanted=[...new Set(ids.filter(id=>/^[a-f0-9]{64}$/.test(id)))].slice(0,ORIGINALS_LIMIT),found=new Map<string,Original>();
    if(!wanted.length)return found;
    try {
      const retired=await this.retirements.retiredEvents(wanted),live=wanted.filter(id=>!retired.has(id));
      const labels=await this.notes.ownerEventLabels(live);
      for(const id of wanted) {
        if(retired.has(id)){found.set(id,{retired:true});continue;}
        const label=labels.get(id);
        if(!label)throw new Error('original_label_missing');
        found.set(id,label.missing?{unavailable:true,label:label.label}:{id,label:label.label,at:label.at,...label.forward?{forward:label.forward}:{}});
      }
      await countMemoryStep(this.control,'source_tags',true);
      return found;
    } catch {
      await countMemoryStep(this.control,'source_tags',false);
      // The owner's own line when it can still be read, else the built-in one.
      const label=await this.notes.ownerWords().then(words=>words.lines.unavailable,()=>sourceLines(undefined).unavailable);
      return new Map(wanted.map(id=>[id,{unavailable:true,label}]));
    }
  }
  /** The owner's lookup (GET /v1/memory/originals): up to 50 full ids, each answered in the order given. */
  async lookup(principal:Reader,ids:readonly string[]):Promise<{originals:Original[]}> {
    admin(principal);
    if(!ids.length||ids.length>50||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(400,'invalid_originals_request');
    const found=await this.originals(ids);
    return {originals:ids.map(id=>found.get(id)!)};
  }
}
