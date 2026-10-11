import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pdfTextBytes} from '../src/pdf-text.js';
import {textExtraction} from '../src/stores/reprocessing.js';

/** A minimal synthetic PDF with one Helvetica text page per entry. */
function syntheticPdf(pages:string[][]):Buffer {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const [index,lines] of pages.entries()) {
    const stream=lines.map((line,row)=>`BT /F1 12 Tf 20 ${760-row*14} Td (${line}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5+index*2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out='%PDF-1.4\n';const offsets:number[]=[];
  objects.forEach((object,index)=>{offsets.push(out.length);out+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=out.length;
  out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+
    `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out,'latin1');
}
const file={kind:'file',metadata:{file_name:'synthetic.pdf'}};

test('PDF text is extracted from its text layer, bounded by whole pages',async()=>{
  const engine=textExtraction();
  assert.equal(await engine.run(syntheticPdf([['Synthetic invoice DOCMARK55','Total 420 credits']]),file,{}),'Synthetic invoice DOCMARK55\nTotal 420 credits');
  const line='Synthetic filler line '.repeat(4);
  const page=Array.from({length:50},()=>line),count=Math.ceil(pdfTextBytes/Buffer.byteLength(page.join('\n')))+2;
  const long=await engine.run(syntheticPdf(Array.from({length:count},()=>page)),file,{});
  assert.equal(typeof long,'string');
  assert.ok(Buffer.byteLength(long as string)<=pdfTextBytes+100);
  assert.match(long as string,new RegExp(`\\[Text of pages \\d+ to ${count} is not included\\.\\]$`));
});

test('unreadable or text-less PDFs keep an explicit status instead of text',async()=>{
  const engine=textExtraction();
  const broken=await engine.run(Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic DOCMARK55\n'),Buffer.from(Array.from({length:256},(_,i)=>i))]),file,{});
  assert.deepEqual(broken,{kind:'extraction_status',text:'This PDF could not be read; its original file is kept.'});
  const blank=await engine.run(syntheticPdf([[]]),file,{});
  assert.equal((blank as {kind:string}).kind,'extraction_status');assert.match((blank as {text:string}).text,/no text layer/);
  assert.equal(await engine.run(Buffer.from('plain synthetic note'),{kind:'file',metadata:{}},{}),'plain synthetic note');
  assert.equal((await engine.run(syntheticPdf([['DOCMARK55']]),{kind:'photo',metadata:{}},{}) as {kind:string}).kind,'extraction_status');
});
