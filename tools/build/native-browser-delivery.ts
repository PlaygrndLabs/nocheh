// Copied into the pinned native dashboard by patch-native-dashboard.py.
// Only opaque receipt IDs and hashes persist in the browser, never message text.
type Receipt = {receipt: string; sha256: string};
const key = 'nocheh.browser.receipts.v1';
const pending = new Map<string, Receipt>();
let draining = false;
const valid = (value: unknown): value is Receipt => {
  const row = value as Receipt | null;
  return !!row && typeof row.receipt === 'string' && typeof row.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(row.receipt) && /^[a-f0-9]{64}$/.test(row.sha256);
};
function load() {
  try { for (const item of JSON.parse(localStorage.getItem(key) || '[]')) if (valid(item)) pending.set(item.receipt, item); }
  catch { /* Restricted storage still permits in-memory retry. */ }
}
function save() {
  try { localStorage.setItem(key, JSON.stringify([...pending.values()])); } catch { /* Retain the in-memory receipt. */ }
}
type Send = (receipt: Receipt) => Promise<unknown>;
export async function flushBrowserDeliveries(send: Send) {
  if (draining) return;
  draining = true; load();
  try {
    for (const item of [...pending.values()]) {
      try { await send(item); pending.delete(item.receipt); save(); }
      catch { break; } // Keep uncertain acknowledgments for retry/reconnect.
    }
  } finally { draining = false; }
}
export async function receiveBrowserDelivery(payload: unknown, send: Send) {
  const value = payload as {status?: string; text?: string; nocheh_delivery?: Receipt} | null;
  if (value?.status !== 'complete' || typeof value.text !== 'string' || !valid(value.nocheh_delivery)) return;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.text));
  const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== value.nocheh_delivery.sha256) return;
  load(); pending.set(value.nocheh_delivery.receipt, {...value.nocheh_delivery}); save();
  await flushBrowserDeliveries(send);
}
export function resumeBrowserDeliveries(send: Send) {
  const flush = () => { void flushBrowserDeliveries(send); };
  flush(); const timer = setInterval(flush, 15000);
  window.addEventListener('online', flush);
  return () => { clearInterval(timer); window.removeEventListener('online', flush); };
}
