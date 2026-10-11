import {parentPort,workerData} from 'node:worker_threads';
import {getDocumentProxy} from 'unpdf';

// Runs only inside the bounded worker started by pdf-text.ts.
const {bytes,limit,pages}=workerData as {bytes:Uint8Array;limit:number;pages:number};
const pdf=await getDocumentProxy(new Uint8Array(bytes),{stopAtErrors:false});
const parts:string[]=[];let size=0,read=0;
try {
  for(let number=1;number<=Math.min(pdf.numPages,pages);number++) {
    const content=await (await pdf.getPage(number)).getTextContent();
    const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':''):'').join('').trim();
    const length=Buffer.byteLength(text)+2;
    if(size+length>limit)break;
    if(text)parts.push(text);size+=length;read=number;
  }
} finally {await pdf.loadingTask.destroy();}
parentPort!.postMessage({text:parts.join('\n\n'),pages:pdf.numPages,read});
