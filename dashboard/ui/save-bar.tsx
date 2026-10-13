/**
 * Save and Discard for every unsaved edit, shown at the top right of the page
 * header while there is something to save. Saving also applies the settings.
 */
import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, Loader2} from 'lucide-react';
import {useDraftSources} from '../lib/drafts';
import {discardSettings, saveSettings, useSettings} from '../lib/settings';
import {settingLabel} from '../lib/setting-labels';
import {cn} from '../lib/utils';
import {Button} from './core';
import {useFeedback} from './overlay';

type SaveState = {
  visible: boolean;
  busy: boolean;
  failed: boolean;
  count: number;
  names: string[];
  text: string;
  detail: string;
  save: () => Promise<void>;
  discard: () => void;
};

const otherState = {busy: false, error: ''};
const otherListeners = new Set<() => void>();
function setOther(next: typeof otherState) {
  Object.assign(otherState, next);
  otherListeners.forEach(listener => listener());
}

/** What is unsaved, saving or failed, and the actions for it. */
export function useSaveState(): SaveState {
  const settings = useSettings();
  const sources = useDraftSources();
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender(n => n + 1);
    otherListeners.add(listener);
    return () => void otherListeners.delete(listener);
  }, []);
  const {dirty, phase, message, data} = settings;
  const pendingApply = data?.apply_state === 'pending';
  const names = [
    ...new Set([...Object.keys(settings.changes).map(settingLabel), ...sources.flatMap(source => source.labels)]),
  ];
  const count = dirty + sources.reduce((n, source) => n + source.labels.length, 0);
  const busy = settings.busy || otherState.busy;
  const failed = !busy && (phase === 'failed' || !!otherState.error);

  const save = async () => {
    setOther({busy: true, error: ''});
    for (const source of sources) {
      try {
        await source.save();
      } catch (error) {
        setOther({busy: false, error: (error as Error).message || 'Saving failed. Try again.'});
        return;
      }
    }
    setOther({busy: false, error: ''});
    if (dirty || phase === 'failed' || pendingApply) await saveSettings();
  };
  const discard = () => {
    sources.forEach(source => source.discard());
    discardSettings();
    setOther({busy: false, error: ''});
  };

  let text = '';
  let detail = '';
  if (phase === 'saving' || otherState.busy) text = 'Saving…';
  else if (phase === 'applying') {
    text = 'Applying…';
    detail = 'Nocheh’s services are restarting. Replies can pause for a moment.';
  } else if (failed) {
    text = 'Couldn’t save';
    detail = otherState.error || message;
  } else if (count) {
    text = count === 1 ? '1 unsaved change' : `${count} unsaved changes`;
    detail = names.join(', ');
  } else if (pendingApply) {
    text = 'Saved, not in use yet';
    detail = 'Apply restarts Nocheh’s services with the saved settings.';
  }
  return {visible: !!text, busy, failed, count, names, text, detail, save, discard};
}

/** Always mounted: reports the outcome of a save and guards development reloads. */
export function SaveWatcher() {
  const state = useSaveState();
  const {toast} = useFeedback();
  const {busy, failed, count, detail} = state;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      if (failed) toast(detail ? `Couldn’t save: ${detail}` : 'Couldn’t save.', 'bad');
      else toast('Saved and applied.');
    }
    wasBusy.current = busy;
  }, [busy, failed]);
  useEffect(() => {
    // Development reloads the page when its code changes; it waits while edits are unsaved or saving.
    (window as any).__nochehUnsaved = count > 0 || busy;
  }, [count, busy]);
  return null;
}

/**
 * The controls themselves; the page header places them. On a page with
 * settings they always show, with Save turned off until there is something to
 * save, so the layout never moves.
 */
export function SaveControls({state, persistent}: {state: SaveState; persistent?: boolean}) {
  const {busy, failed, count, detail} = state;
  if (!state.visible && !persistent) return null;
  const text = state.text || 'No unsaved changes';
  const idle = !state.visible;

  return (
    <div role="region" aria-label="Save changes" className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span
        aria-live="polite"
        title={detail || undefined}
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-[13px]',
          failed ? 'text-bad' : busy || idle ? 'text-muted' : 'text-fg/80',
        )}
      >
        {busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden />
        ) : failed ? (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        ) : (
          !idle && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
        )}
        <span className="truncate">{text}</span>
        {detail && <span className="sr-only">: {detail}</span>}
      </span>
      <Button size="sm" disabled={busy || count === 0} onClick={state.discard}>
        Discard
      </Button>
      <Button size="sm" variant="primary" disabled={busy || idle} onClick={() => void state.save()}>
        {failed ? 'Try again' : count || idle || busy ? 'Save' : 'Apply now'}
      </Button>
    </div>
  );
}
