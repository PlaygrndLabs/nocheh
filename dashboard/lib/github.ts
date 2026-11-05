/** Rules of the GitHub card (ADR-0209), kept apart from the page so tests need no browser. */

/**
 * Whether the card offers Disconnect. Without a key it still does while copies remain:
 * a Disconnect that forgot the key but could not reach the store is pressed again to
 * remove the fetchers, the copies and their files.
 */
export function offersDisconnect(status: {connected: boolean; reconnect: boolean; copies: unknown[] | null}): boolean {
  return status.connected || status.reconnect || (status.copies?.length ?? 0) > 0;
}
