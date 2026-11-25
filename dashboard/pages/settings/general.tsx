/** Settings › General: what every part of Nocheh follows, starting with the owner's time zone. */
import {useMemo, useState} from 'react';
import {apiPost} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {Badge, Button, Card, CardHeader, LoadError, LoadingRows, Select} from '../../ui/core';

function knownZones(): string[] {
  try {
    return (Intl as unknown as {supportedValuesOf(key: string): string[]}).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
}

export const zoneName = (zone: string) => zone.replace(/_/g, ' ');

/**
 * The owner's one time zone (ADR-0311): task dates and reminders, new schedules, quiet hours, the day each chat starts
 * afresh and the daily backup all follow it. It is saved from the bottom save bar like every other setting.
 */
function OwnerTimeZone() {
  const {data, error} = useResource<{time_zone: string}>('/tasks/settings');
  const [choice, setChoice] = useState<string | null>(null);
  const saved = data?.time_zone;
  const selected = choice ?? saved;
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(
    () => [...new Set(['UTC', ...knownZones(), ...(saved ? [saved] : []), ...(device ? [device] : [])])].sort(),
    [saved, device],
  );
  useDraftSource({
    id: 'owner-time-zone',
    labels: saved && selected && selected !== saved ? ['Your time zone'] : [],
    save: async () => {
      if (!selected) return;
      try {
        await apiPost('/tasks/time-zone', {time_zone: selected});
        setChoice(null);
        await refreshResources();
      } catch {
        throw new Error('Couldn’t save your time zone.');
      }
    },
    discard: () => setChoice(null),
  });
  const pick = (zone: string) => setChoice(zone === saved ? null : zone);
  return (
    <Card>
      <CardHeader
        title="Your time zone"
        description="Every part of Nocheh follows it: task dates, Today and Upcoming, and reminders; new schedules; quiet hours; the 4 AM start of each chat’s new day; and the daily backup. Schedules already set keep the time zone they were set in. Members can choose their own for their private chat."
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
        {error && !data ? (
          <LoadError what="your time zone" />
        ) : !saved || !selected ? (
          <LoadingRows rows={1} />
        ) : (
          <>
            <Select
              id="owner-time-zone"
              aria-label="Your time zone"
              value={selected}
              className="w-full sm:w-64"
              onChange={event => pick(event.target.value)}
            >
              {zones.map(zone => (
                <option key={zone} value={zone}>
                  {zoneName(zone)}
                </option>
              ))}
            </Select>
            {device && device !== selected && (
              <Button size="sm" variant="ghost" onClick={() => pick(device)}>
                Use this device’s ({zoneName(device)})
              </Button>
            )}
            {selected !== saved && <Badge>Not saved</Badge>}
            <span className="w-full text-xs text-muted">You can also tell Nocheh in your private chat.</span>
          </>
        )}
      </div>
    </Card>
  );
}

export function GeneralSettings() {
  return (
    <div className="space-y-5">
      <OwnerTimeZone />
    </div>
  );
}
