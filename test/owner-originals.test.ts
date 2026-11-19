import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ORIGINALS_LIMIT,OwnerOriginals} from '../src/stores/owner-originals.js';

/*
 * The owner's dashboard names original messages (ADR-0261 step 4): every one asked, batch by batch; one retired, or a
 * reaction to one, only as retired; and only a failure is counted, so the dashboard's own lookups never mark a turn's
 * failure as fixed.
 */
const id=(n:number)=>n.toString(16).padStart(64,'0');
const words=async()=>({lines:{unavailable:'Source not available right now'}}) as any;

function originals(options:{retired?:Set<string>;fail?:boolean}={}) {
  const counted:unknown[][]=[],batches:number[]=[],retiredAsked:string[][]=[];
  const control={query:async(_sql:string,values:unknown[])=>{counted.push(values);return {rows:[],rowCount:0};}} as any;
  const notes={ownerWords:words,ownerEventLabels:async(ids:readonly string[])=>{
    batches.push(ids.length);
    if(options.fail)throw Error('down');
    return new Map(ids.map(item=>[item,{label:'you in your private chat',at:'2026-11-19T10:00:00.000Z'}]));
  }};
  const retirements={retiredAmong:async(ids:readonly string[])=>{retiredAsked.push([...ids]);return new Set(ids.filter(item=>options.retired?.has(item)));}};
  return {named:new OwnerOriginals(control,notes as any,retirements),counted,batches,retiredAsked};
}

test('every original asked is named, a batch of reads at a time', async () => {
  const {named,batches}=originals();
  const ids=Array.from({length:ORIGINALS_LIMIT+50},(_,index)=>id(index+1));
  const found=await named.originals([...ids,ids[0]!,'not-an-id']);
  assert.equal(found.size,ids.length,'none past the first batch is dropped');
  assert.deepEqual(found.get(ids.at(-1)!),{id:ids.at(-1),label:'you in your private chat',at:'2026-11-19T10:00:00.000Z'});
  assert.deepEqual(batches,[ORIGINALS_LIMIT,50]);
});

test('a retired message and a reaction to one read only retired, as canRead treats them', async () => {
  const reaction=id(2),{named,retiredAsked}=originals({retired:new Set([reaction])});
  const found=await named.originals([id(1),reaction]);
  assert.deepEqual(found.get(reaction),{retired:true});
  assert.equal((found.get(id(1)) as any).id,id(1));
  assert.deepEqual(retiredAsked,[[id(1),reaction]],'retiredAmong is asked, which counts a reaction to a retired message');
});

test('only a failure is counted: a lookup that works never clears a turn\'s counted failure', async () => {
  const working=originals();
  await working.named.originals([id(1)]);
  assert.deepEqual(working.counted,[],'a working lookup counts nothing');
  const broken=originals({fail:true});
  const found=await broken.named.originals([id(1)]);
  assert.deepEqual([...found.values()],[{unavailable:true,label:'Source not available right now'}]);
  assert.deepEqual(broken.counted,[['source_tags']],'the failure is counted once');
});
