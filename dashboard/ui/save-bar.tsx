/** The one place edits are saved, pinned to the bottom of the screen while there is something to save. */
import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, Loader2} from 'lucide-react';
import {useDraftSources} from '../lib/drafts';
import {discardSettings, saveSettings, useSettings} from '../lib/settings';
import {settingLabel} from '../lib/setting-labels';
import {cn} from '../lib/utils';
import {Button} from './core';
import {useFeedback} from './overlay';

export function SaveBar() {
  const settings = useSettings();
  const sources = useDraftSources();
  const {toast} = useFeedback();
  const [other, setOther] = useState<{busy: boolean; error: string}>({busy: false, error: ''});
  const {dirty, phase, message, data} = settings;
  const pendingApply = data?.apply_state === 'pending';
  const names = [
    ...new Set([...Object.keys(settings.changes).map(settingLabel), ...sources.flatMap(source => source.labels)]),
  ];
  const count = dirty + sources.reduce((n, source) => n + source.labels.length, 0);
  const busy = settings.busy || other.busy;
  const failed = phase === 'failed' || !!other.error;
  const visible = count > 0 || busy || failed || pendingApply;

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && !failed) toast('Saved.');
    wasBusy.current = busy;
  }, [busy, failed]);
  useEffect(() => {
    // Development reloads the page when its code changes; it waits while edits are unsaved or saving.
    (window as any).__nochehUnsaved = count > 0 || busy;
  }, [count, busy]);
  if (!visible) return null;

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

  let text: React.ReactNode;
  let detail: React.ReactNode = null;
  if (phase === 'saving' || other.busy) text = 'Saving…';
  else if (phase === 'applying') {
    text = 'Applying…';
    detail = 'Nocheh’s services are restarting. Replies can pause for a moment.';
  } else if (failed) {
    text = 'Couldn’t save';
    detail = other.error || message;
  } else if (count) {
    text = count === 1 ? '1 unsaved change' : `${count} unsaved changes`;
    detail = names.join(', ');
  } else {
    text = 'Saved settings aren’t in use yet';
    detail = 'Apply them to restart Nocheh’s services with the saved settings.';
  }

  return (
    <div className="pb-4">
      <div
        role="region"
        aria-label="Save changes"
        className={cn(
          'pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-surface px-4 py-3 shadow-lg',
          failed && !busy ? 'border-bad/40' : 'border-line-strong',
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {busy ? (
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" aria-hidden />
          ) : failed ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
          ) : (
            <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-warn" />
          )}
          <div className="min-w-0" aria-live="polite">
            <p className="text-sm font-medium">{text}</p>
            {detail && <p className="text-xs text-muted">{detail}</p>}
          </div>
        </div>
        {!busy && (
          <div className="flex w-full gap-2 sm:w-auto">
            {count > 0 && (
              <Button className="flex-1 sm:flex-none" onClick={discard}>
                Discard
              </Button>
            )}
            <Button variant="primary" className="flex-1 sm:flex-none" onClick={() => void save()}>
              {failed ? 'Try again' : count ? 'Save' : 'Apply now'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
