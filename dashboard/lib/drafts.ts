/**
 * Edits that are not `.env` settings (for example assistant preferences) join
 * the same bottom save bar: a form registers its unsaved edits here while it
 * has any, and the bar saves or discards them together with settings.
 */
import {useEffect, useRef, useSyncExternalStore} from 'react';

export type DraftSource = {
  id: string;
  /** Names of what changed, for the save bar. */
  labels: string[];
  /** Saves the edits; throws an Error with a plain message when it fails. */
  save: () => Promise<void>;
  discard: () => void;
};

let sources: DraftSource[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function put(source: DraftSource) {
  sources = [...sources.filter(s => s.id !== source.id), source];
  emit();
}
function drop(id: string) {
  if (!sources.some(s => s.id === id)) return;
  sources = sources.filter(s => s.id !== id);
  emit();
}

/** Registers a form's unsaved edits; pass `labels: []` (or nothing) when it has none. */
export function useDraftSource(source: DraftSource | null) {
  const latest = useRef(source);
  latest.current = source;
  const id = source?.id;
  const active = !!source && source.labels.length > 0;
  const key = active ? source!.labels.join('\u0000') : '';
  useEffect(() => {
    if (!id) return;
    if (!active) {
      drop(id);
      return;
    }
    put({
      id,
      labels: latest.current!.labels,
      save: () => latest.current!.save(),
      discard: () => latest.current!.discard(),
    });
  }, [id, active, key]);
  useEffect(() => () => void (id && drop(id)), [id]);
}

export function useDraftSources(): DraftSource[] {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sources,
  );
}
