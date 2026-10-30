/**
 * Settings › Privacy & data › Password: the owner's one Nocheh password for
 * this dashboard and the mini app, and the browsers and phones signed in with
 * it. These save at once with their own buttons, never with Save at the top.
 */
import {useState} from 'react';
import {apiPost, type ApiError} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {Button, Card, CardHeader, Input, LoadError, LoadingRows, SettingRow} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {errorWords, when} from '../memory/shared';

type Session = {kind: 'browser' | 'phone'; created_at: number; last_seen_at: number; current: boolean};
type OwnerLock = {password_set: boolean; changed_at: number | null; paused_until: number | null; sessions: Session[]};

const at = (time: number) => when(new Date(time).toISOString());
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PasswordSettings() {
  const lock = useResource<OwnerLock>('/owner-lock');
  const feedback = useFeedback();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const data = lock.data;
  const others = (data?.sessions ?? []).filter(session => !session.current);
  const browsers = others.filter(session => session.kind === 'browser').length;
  const phones = others.filter(session => session.kind === 'phone').length;

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
      await refreshResources();
    } catch (e) {
      const error = e as ApiError & {tries_left?: number};
      setProblem(
        {
          wrong_password: 'The current password is wrong.',
          sign_in_paused: 'Too many wrong passwords. Try again later.',
          password_empty: 'Enter a new password.',
          password_too_long: 'Use at most 200 characters for the new password.',
        }[error.message] ?? errorWords(e),
      );
    } finally {
      setBusy(null);
    }
  };
  const change = () =>
    run('password', async () => {
      const changed = await apiPost<{csrf: string}>('/owner-lock/password', {current, password: next});
      // This browser stays signed in under a new session, with its own CSRF value.
      window.__NOCHEH_CSRF__ = changed.csrf;
      setCurrent('');
      setNext('');
      feedback.toast('Password changed. Every other browser and phone signs in again with the new one.');
    });
  const signOutOthers = async () => {
    const ok = await feedback.confirm({
      title: 'Sign out everywhere else?',
      body: 'Every other browser and phone asks for the password again. This browser stays signed in.',
      confirm: 'Sign out everywhere else',
      danger: true,
    });
    if (ok)
      await run('sign-out', async () => {
        await apiPost('/owner-lock/sign-out-others', {});
        feedback.toast('Every other browser and phone is signed out.');
      });
  };

  if (lock.error && !data) return <LoadError what="the password" onRetry={() => void refreshResources()} />;
  if (!data)
    return (
      <Card>
        <LoadingRows rows={2} />
      </Card>
    );
  return (
    <Card>
      <CardHeader
        title="Password"
        description="One password for this dashboard and the Telegram mini app. Each browser and phone asks for it once, then stays signed in for 30 days of use."
        className="pb-3"
      />
      <div className="border-t border-line">
        <SettingRow
          title="Change password"
          description={
            problem ? (
              <span className="text-bad" role="alert">
                {problem}
              </span>
            ) : (
              `${data.changed_at ? 'Changed ' + at(data.changed_at) + '. ' : ''}A new password signs every other browser and phone out.`
            )
          }
          htmlFor="password-current"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={e => {
              e.preventDefault();
              if (current && next && !busy) void change();
            }}
          >
            <Input
              id="password-current"
              type="password"
              autoComplete="current-password"
              value={current}
              placeholder="Current password"
              disabled={!!busy}
              onChange={e => setCurrent(e.target.value)}
            />
            <Input
              type="password"
              aria-label="New password"
              autoComplete="new-password"
              value={next}
              placeholder="New password"
              disabled={!!busy}
              onChange={e => setNext(e.target.value)}
            />
            <Button type="submit" busy={busy === 'password'} disabled={!current || !next || !!busy}>
              Change password
            </Button>
          </form>
        </SettingRow>
        <SettingRow
          title="Signed in elsewhere"
          description={
            data.paused_until
              ? `Sign-in is paused after too many wrong passwords, until ${at(data.paused_until)}.`
              : others.length
                ? `${count(browsers, 'other browser', 'other browsers')} and ${count(phones, 'phone', 'phones')}. Last used ${at(others[0]!.last_seen_at)}.`
                : 'Only this browser is signed in.'
          }
        >
          <div className="flex sm:justify-end">
            <Button
              variant="danger"
              busy={busy === 'sign-out'}
              disabled={!others.length || !!busy}
              onClick={() => void signOutOthers()}
            >
              Sign out everywhere else
            </Button>
          </div>
        </SettingRow>
      </div>
    </Card>
  );
}
