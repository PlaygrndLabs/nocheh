/**
 * The Settings tab: where the member's reminders go and the ones waiting, each removable with write even while new
 * ones can't reach the member, their own schedules while Personal assistant is on (members' schedules), and Sign out, which ends every launch opened before it on every phone (ADR-0265 D13).
 */
import * as React from 'react';
import {Bell, LogOut} from 'lucide-react';
import {type MemberMe, type MemberReminder} from '../../src/member-app-wire';
import {cn} from '../lib/utils';
import {Button, Card, Skeleton} from '../ui/core';
import {memberApi, MemberApiError, operationId} from './api';
import {type WordKey} from './i18n';
import {useToast, useWords} from './shared';
import {MemberScheduleList} from './schedules';

const offWords: Record<string, WordKey> = {
  private_chat_off: 'off_private_chat',
  reminders_off: 'off_owner',
  read_only: 'off_read_only',
};

export function MemberSettings({me, onSignedOut}: {me: MemberMe; onSignedOut: () => void}) {
  const {t, moment} = useWords();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reminders, setReminders] = React.useState<MemberReminder[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      setReminders(await memberApi.reminders());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  React.useEffect(() => void load(), [load]);

  /** Drops one of the member's own reminders: the task's list of theirs, without it. */
  const remove = async (reminder: MemberReminder) => {
    setBusy(reminder.id);
    try {
      const task = await memberApi.task(reminder.task.id);
      await memberApi.update(task.id, {
        operation_id: operationId(),
        expected_version: task.version,
        patch: {reminders: task.reminders.mine.filter(item => item.id !== reminder.id).map(item => item.at)},
      });
      toast(t('reminder_removed'));
    } catch (error) {
      if (!(error instanceof MemberApiError) || error.status !== 401) toast(t('failed'), true);
    } finally {
      setBusy(null);
      void load();
    }
  };
  const signOut = async () => {
    setBusy('sign-out');
    try {
      await memberApi.signOut();
      onSignedOut();
    } catch (error) {
      setBusy(null);
      if (!(error instanceof MemberApiError) || error.status !== 401) toast(t('failed'), true);
    }
  };

  return (
    <section className="mx-auto max-w-2xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">{t('tab_settings')}</h1>
        <p className="text-[13px] text-muted" dir="auto">
          {t('signed_in_as', {name: me.name})}
        </p>
      </div>
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t('reminders_title')}</h2>
        <div>
          <p className="text-[13px] text-muted">{t('where_they_go')}</p>
          {me.reminders.available ? (
            <p className="text-sm">{t('go_private_chat')}</p>
          ) : (
            <p className="text-sm">
              {t('reminders_are_off')}: {t(offWords[me.reminders.reason] ?? 'off_owner')}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">{t('times_line')}</p>
        </div>
        <div>
          <h3 className="mb-1 text-[13px] font-medium">{t('my_reminders')}</h3>
          {!reminders && !failed && <Skeleton className="h-10 w-full" />}
          {failed && <p className="text-[13px] text-bad">{t('failed')}</p>}
          {reminders && !reminders.length && <p className="text-[13px] text-muted">{t('my_reminders_none')}</p>}
          {!!reminders?.length && (
            <ul className="divide-y divide-line" aria-label={t('my_reminders')}>
              {reminders.map(reminder => (
                <li key={reminder.id} className="flex items-center gap-3 py-2">
                  <Bell className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" dir="auto">
                      {reminder.task.title}
                    </span>
                    <span className="block text-xs text-muted">{moment(reminder.at)}</span>
                  </span>
                  {me.mode === 'write' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === reminder.id}
                      disabled={!!busy}
                      onClick={() => void remove(reminder)}
                    >
                      {t('remove')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {me.assistant && <MemberScheduleList />}
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">{t('sign_out')}</h2>
        <p className="text-[13px] text-muted">{t('sign_out_line')}</p>
        <Button variant="danger" busy={busy === 'sign-out'} disabled={!!busy} onClick={() => void signOut()}>
          <LogOut aria-hidden /> {t('sign_out')}
        </Button>
      </Card>
    </section>
  );
}
