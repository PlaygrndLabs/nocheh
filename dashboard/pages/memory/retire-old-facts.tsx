/**
 * Memory › Long-term › Status and limits: "Retire old facts", Honcho's dreams. Off by default; Save applies it and
 * restarts long-term memory with it (ADR-0298).
 */
import {useSettings} from '../../lib/settings';
import {Card, CardHeader, Switch} from '../../ui/core';
import {Unsaved} from '../settings/telegram';

export const retireKey = 'NOCHEH_MEMORY_RETIRE_OLD_FACTS';

export function RetireOldFactsCard() {
  const s = useSettings();
  if (!s.field(retireKey)) return null;
  return (
    <Card>
      <CardHeader
        title="Clean up"
        description="Long-term memory can go over what it learned and retire facts that newer ones replaced."
        className="pb-3"
      />
      {/* Its own row: the card sits in the narrow column, where a setting row's wide control would crush the text. */}
      <div className="flex items-start justify-between gap-4 border-t border-line px-5 py-4">
        <div className="min-w-0">
          <label htmlFor="memory-retire-old-facts" className="block text-sm font-medium">
            Retire old facts
            <Unsaved show={s.changed(retireKey)} />
          </label>
          <p className="mt-0.5 text-[13px] text-muted">
            Runs on its own after about 50 new facts, at most every 8 hours, once a chat has been quiet for an hour.
            Your whole memory and each group’s memory are cleaned up separately. A retired fact is hidden, not deleted:
            replies stop using it, and you can bring it back under Facts it learned.
          </p>
          <p className="mt-1 text-[13px] text-muted">
            Extra cost: each clean-up is up to about 22 calls to the memory model, and it counts toward the memory
            thinking limit.
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <Switch
            id="memory-retire-old-facts"
            label="Retire old facts"
            checked={s.value(retireKey) === 'true'}
            disabled={s.busy}
            onChange={on => s.set(retireKey, on ? 'true' : 'false')}
          />
        </div>
      </div>
    </Card>
  );
}
