// Copied into the pinned dashboard. Missed answers are shown before their
// receipt is captured; neither server polling nor a hidden cache is delivery.
import {useEffect, useRef, useState} from 'react';
import {api} from '@/lib/api';
import {receiveBrowserDelivery} from '@/lib/nocheh-browser-delivery';

type Answer = {event_id:string; conversation:string; text:string; status:'complete'; nocheh_delivery:{receipt:string;sha256:string}};
export function BrowserRecovery({profile}:{profile:string}) {
  const [items, setItems] = useState<Answer[]>([]);
  const [after, setAfter] = useState<string|null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const region=useRef<HTMLDivElement>(null),buttons=useRef(new Map<string,HTMLButtonElement>());
  const dismiss=(id:string)=>{
    const index=items.findIndex(item=>item.event_id===id),next=items[index+1]??items[index-1];
    if(next)buttons.current.get(next.event_id)?.focus();else region.current?.focus();
    setItems(rows=>rows.filter(row=>row.event_id!==id));
  };
  useEffect(() => {
    if (items.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.undeliveredBrowserResponses(profile, after);
        if (cancelled) return;
        setUnavailable(false);
        if (result.items.length) { setItems(result.items); setAfter(result.next); return; }
        if (result.next !== after) { setAfter(result.next); return; }
      } catch { if (!cancelled) setUnavailable(true); }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 10000);
    };
    // Yield between pages, and allow the normal completion receipt to arrive.
    timer = setTimeout(() => { void poll(); }, after ? 1000 : 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [profile, after, items.length]);
  useEffect(() => {
    // React has committed the exact visible text before this effect runs.
    for (const item of items) void receiveBrowserDelivery(item, api.acknowledgeBrowserDelivery).catch(() => {});
  }, [items]);
  return <div ref={region} role="region" aria-label="Response recovery" tabIndex={-1}>
    {unavailable && <p role="status" className="text-xs">Checking for missed responses is temporarily unavailable. Retrying…</p>}
    {items.map(item => <section key={item.event_id} className="rounded border border-border p-3 text-sm" aria-label="Recovered response">
      <p className="font-medium">Recovered response</p>
      <p className="whitespace-pre-wrap break-words my-2">{item.text}</p>
      <button ref={element=>{if(element)buttons.current.set(item.event_id,element);else buttons.current.delete(item.event_id);}} type="button" className="rounded px-2 py-1 underline focus-visible:outline focus-visible:outline-2" onClick={() => dismiss(item.event_id)}>Dismiss</button>
    </section>)}
  </div>;
}
