/** Rules of the GitHub card (ADR-0209), kept apart from the page so tests need no browser. */

/**
 * Whether the card offers Disconnect. Without a key it still does while copies remain:
 * a Disconnect that forgot the key but could not reach the store is pressed again to
 * remove the fetchers, the copies and their files.
 */
export function offersDisconnect(status: {connected: boolean; reconnect: boolean; copies: unknown[] | null}): boolean {
  return status.connected || status.reconnect || (status.copies?.length ?? 0) > 0;
}

/**
 * The row a running Copy shows its progress in: the row of that name in any case, since
 * the owner may type a listed name in another case. Null while the copy has no row yet,
 * as for a name the key does not list; the field it was typed in then shows the progress.
 */
export function copyingRow(copying: string | null, names: string[]): string | null {
  if (copying === null) return null;
  const wanted = copying.toLowerCase();
  return names.find(name => name.toLowerCase() === wanted) ?? null;
}
