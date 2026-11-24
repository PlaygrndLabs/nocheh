/**
 * The member's own schedules (members' schedules), in Settings while Personal assistant is on: each schedule of their
 * private chat with Nocheh, which they pause, resume, run now or delete. Setting one happens in that chat.
 */
import * as React from 'react';
import {CalendarClock} from 'lucide-react';
import type {MemberSchedule, MemberScheduleRequest, MemberSchedules} from '../../src/member-app-wire';
import {Button, Card, Field, Select, Skeleton} from '../ui/core';
import {memberApi, MemberApiError, operationId} from './api';
import {type WordKey} from './i18n';
import {useToast, useWords} from './shared';

const toasts: Record<MemberScheduleRequest['action'], WordKey> = {
  pause: 'schedule_paused_toast',
  resume: 'schedule_resumed_toast',
  run: 'schedule_started_toast',
  delete: 'schedule_deleted_toast',
};

/** The time zones this phone knows, and the one it is in; a saved zone it does not list is still offered. */
const phoneZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};
const knownZones = (): string[] => {
  try {
    return (Intl as unknown as {supportedValuesOf(key: string): string[]}).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** The member's own time zone for new schedules: one from the list, this phone's, or the owner's (empty). */
function TimeZonePicker({value, onSaved}: {value: string | null; onSaved: (zone: string | null) => void}) {
  const {t} = useWords();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const here = phoneZone();
  const zones = React.useMemo(() => {
    const all = new Set(knownZones());
    for (const zone of [value, here]) if (zone) all.add(zone);
    return [...all].sort();
  }, [value, here]);
  const save = async (zone: string | null) => {
    setBusy(true);
    try {
      const saved = await memberApi.timeZone({operation_id: operationId(), time_zone: zone});
      onSaved(saved.time_zone);
      toast(t('time_zone_saved'));
    } catch (error) {
      if (error instanceof MemberApiError && error.status === 400) toast(t('time_zone_invalid'), true);
      else if (error instanceof MemberApiError && error.status === 429) toast(t('busy'), true);
      else if (!(error instanceof MemberApiError) || error.status !== 401) toast(t('failed'), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Field label={t('time_zone_label')} htmlFor="member-time-zone" hint={t('time_zone_hint')}>
        <Select
          id="member-time-zone"
          value={value ?? ''}
          disabled={busy}
          onChange={event => void save(event.target.value || null)}
        >
          <option value="">{t('time_zone_owner')}</option>
          {zones.map(zone => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </Select>
      </Field>
      {here && here !== value && (
        <Button size="sm" variant="ghost" busy={busy} disabled={busy} onClick={() => void save(here)}>
          {t('time_zone_phone')}
        </Button>
      )}
    </div>
  );
}

export function MemberScheduleList() {
  const {t, moment} = useWords();
  const toast = useToast();
  const [value, setValue] = React.useState<MemberSchedules | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  // Delete asks once more on the same button: the page never opens the browser's own dialogs inside Telegram.
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    try {
      setValue(await memberApi.schedules());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  React.useEffect(() => void load(), [load]);

  const act = async (row: MemberSchedule, action: MemberScheduleRequest['action']) => {
    if (action === 'delete' && confirming !== row.id) {
      setConfirming(row.id);
      return;
    }
    setConfirming(null);
    setBusy(row.id + action);
    try {
      await memberApi.schedule(row.id, {operation_id: operationId(), action});
      toast(t(toasts[action]));
    } catch (error) {
      if (error instanceof MemberApiError && error.status === 404) toast(t('schedule_gone'), true);
      else if (error instanceof MemberApiError && error.status === 429) toast(t('busy'), true);
      else if (!(error instanceof MemberApiError) || error.status !== 401) toast(t('failed'), true);
    } finally {
      setBusy(null);
      void load();
    }
  };

  const line = (row: MemberSchedule) =>
    [
      row.schedule,
      row.state === 'paused'
        ? t('schedule_paused')
        : row.state === 'running'
          ? t('schedule_running')
          : row.state === 'finished'
            ? t('schedule_finished')
            : row.state === 'not_saved'
              ? t('schedule_not_saved')
              : row.next_run_at
                ? t('schedule_next', {when: moment(row.next_run_at)})
                : '',
      row.last_ok === false ? t('schedule_last_failed') : '',
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">{t('schedules_title')}</h2>
        <p className="text-[13px] text-muted">{t('schedules_line')}</p>
        {value && (
          <p className="mt-1 text-xs text-muted">
            {t('schedules_count', {count: value.schedules.length, limit: value.limit})}
          </p>
        )}
      </div>
      {value && (
        <TimeZonePicker
          value={value.time_zone}
          onSaved={zone => setValue(now => (now ? {...now, time_zone: zone} : now))}
        />
      )}
      {!value && !failed && <Skeleton className="h-10 w-full" />}
      {failed && <p className="text-[13px] text-bad">{t('failed')}</p>}
      {value && !value.schedules.length && <p className="text-[13px] text-muted">{t('schedules_none')}</p>}
      {!!value?.schedules.length && (
        <ul className="divide-y divide-line" aria-label={t('schedules_title')}>
          {value.schedules.map(row => (
            <li key={row.id} className="space-y-2 py-2">
              <div className="flex items-center gap-3">
                <CalendarClock className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" dir="auto">
                    {row.name || t('unnamed_schedule')}
                  </span>
                  <span className="block text-xs text-muted" dir="auto">
                    {line(row)}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 ps-7">
                {row.state !== 'finished' && row.state !== 'not_saved' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === row.id + (row.state === 'paused' ? 'resume' : 'pause')}
                    disabled={!!busy}
                    onClick={() => void act(row, row.state === 'paused' ? 'resume' : 'pause')}
                  >
                    {row.state === 'paused' ? t('resume') : t('pause')}
                  </Button>
                )}
                {row.state !== 'running' && row.state !== 'finished' && row.state !== 'not_saved' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === row.id + 'run'}
                    disabled={!!busy}
                    onClick={() => void act(row, 'run')}
                  >
                    {t('run_now')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={confirming === row.id ? 'danger' : 'ghost'}
                  busy={busy === row.id + 'delete'}
                  disabled={!!busy}
                  onClick={() => void act(row, 'delete')}
                >
                  {confirming === row.id ? t('delete_confirm') : t('delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
