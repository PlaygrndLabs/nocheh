import {Worker} from 'node:worker_threads';

/** Extracted text is bounded like a UTF-8 file: whole pages up to this many bytes. */
export const pdfTextBytes=200000;
export const pdfPages=500;

export type PdfText={text:string;pages:number;read:number};

export function isPdf(bytes:Buffer):boolean {return bytes.subarray(0,1024).includes('%PDF-');}

/**
 * Reads a PDF's text layer in a worker thread. The file is untrusted input, so
 * the parser gets its own heap limit and a deadline, and any failure is
 * reported as unreadable instead of affecting the service.
 */
export function pdfText(bytes:Buffer,timeoutMs=30000):Promise<PdfText|null> {
  return new Promise(resolve=>{
    let settled=false;
    const worker=new Worker(new URL('./pdf-text-worker.js',import.meta.url),{workerData:{bytes,limit:pdfTextBytes,pages:pdfPages},
      resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32},stdout:true,stderr:true});
    worker.stdout.resume();worker.stderr.resume();
    const finish=(value:PdfText|null)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();resolve(value);};
    const timer=setTimeout(()=>finish(null),timeoutMs);
    worker.once('message',value=>finish(value&&typeof value.text==='string'?value as PdfText:null));
    worker.once('error',()=>finish(null));
    worker.once('exit',()=>finish(null));
  });
}
