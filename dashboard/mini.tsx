/**
 * The Telegram Mini App: Home, Inbox, Tasks and Health on the owner's phone,
 * inside Telegram. It uses the same owner API and pages as the dashboard;
 * Settings and the rest of System stay on the dashboard at home. Each phone
 * signs in once with the password the owner sets in the dashboard.
 */
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {
  Activity,
  CalendarClock,
  Home,
  Inbox as InboxIcon,
  ListChecks,
  LockKeyhole,
  LogOut,
  Monitor,
} from 'lucide-react';
import {useHash, useParam} from './lib/navigation';
import {useInboxCount} from './lib/inbox';
import {apiPost, authedFetch} from './lib/api';
import {refreshResources, useResource} from './lib/resource';
import {issues, workCounts} from './lib/system-health';
import {setParams} from './lib/routes';
import {decisionLabels, type DecisionKind} from './lib/supervision';
import {cn} from './lib/utils';
import {Button, Card, CardBody, Dot, Field, Input, LoadError, LoadingRows, Notice, Skeleton} from './ui/core';
import {FeedbackProvider, useFeedback} from './ui/overlay';
import {Page} from './ui/page';
import {ActionDrawer, DecisionDrawer} from './pages/inbox/drawers';
import {Waiting} from './pages/inbox/waiting';
import Tasks, {day, type Task} from './pages/tasks';
import {LogoMark} from './ui/logo';

type MiniPage = 'home' | 'inbox' | 'tasks' | 'problems';
const tabs: {id: MiniPage; title: string; Icon: React.ComponentType<{className?: string}>}[] = [
  {id: 'home', title: 'Home', Icon: Home},
  {id: 'inbox', title: 'Inbox', Icon: InboxIcon},
  {id: 'tasks', title: 'Tasks', Icon: ListChecks},
  {id: 'problems', title: 'Health', Icon: Activity},
];

/**
 * Telegram hands the signed launch data to the page in the address. Keep it
 * for this visit only, then leave the address to the mini app's own pages.
 */
function launchData(): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fresh = params.get('tgWebAppData');
  try {
    if (fresh) sessionStorage.setItem('nocheh.telegram-launch', fresh);
    const theme = JSON.parse(params.get('tgWebAppThemeParams') || 'null');
    if (theme?.bg_color) sessionStorage.setItem('nocheh.telegram-theme', theme.bg_color);
  } catch {}
  // A problem notice's Open button asks for the Health page.
  const start = new URLSearchParams(location.search).get('page') === 'problems' ? '#problems' : '#home';
  if (fresh) history.replaceState(null, '', location.pathname + start);
  try {
    return fresh || sessionStorage.getItem('nocheh.telegram-launch') || '';
  } catch {
    return fresh || '';
  }
}

/** Follows Telegram's light or dark theme when it gives one, else the device's. */
function applyTheme() {
  let background = '';
  try {
    background = sessionStorage.getItem('nocheh.telegram-theme') || '';
  } catch {}
  const match = background.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const dark = match
    ? 0.2126 * parseInt(match[1]!, 16) + 0.7152 * parseInt(match[2]!, 16) + 0.0722 * parseInt(match[3]!, 16) < 128
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}

const telegramWeb = ['https://web.telegram.org', 'https://webk.telegram.org', 'https://webz.telegram.org'];
/** Tells Telegram the page is ready and should take the full height. */
function telegramEvent(type: string) {
  try {
    const proxy = (window as any).TelegramWebviewProxy;
    if (proxy?.postEvent) proxy.postEvent(type, '{}');
    else if (window.parent !== window) {
      const web = telegramWeb.find(origin => document.referrer.startsWith(origin + '/')) ?? 'https://web.telegram.org';
      window.parent.postMessage(JSON.stringify({eventType: type, eventData: {}}), web);
    }
  } catch {}
}

const SESSION_KEY = 'nocheh.mini-session';
type LockState = 'checking' | 'signed_in' | 'signed_out' | 'no_password' | 'unavailable';

/** Keeps this phone's mini app sign-in, so the password is asked once per phone. */
function rememberSession(token: string | null) {
  window.__NOCHEH_MINI_SESSION__ = token ?? undefined;
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

async function miniCall(path: string, body?: unknown): Promise<{status: number; value: any}> {
  const response = await authedFetch(
    '/api/mini/' + path,
    body === undefined
      ? {}
      : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)},
  );
  return {status: response.status, value: await response.json().catch(() => ({}))};
}

function minutes(until: number): string {
  const left = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return left >= 120 ? `${Math.round(left / 60)} hours` : `${left} ${left === 1 ? 'minute' : 'minutes'}`;
}

/** Asks for the mini app password once on this phone. */
function SignIn({onSignedIn}: {onSignedIn: () => void}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const {status, value} = await miniCall('sign-in', {password});
      if (status === 200 && value.token) {
        rememberSession(value.token);
        onSignedIn();
        return;
      }
      setPassword('');
      setProblem(
        value.error === 'wrong_password'
          ? value.tries_left > 0 && value.tries_left <= 2
            ? `Wrong password. ${value.tries_left} ${value.tries_left === 1 ? 'try' : 'tries'} left before a pause.`
            : 'Wrong password.'
          : value.error === 'mini_app_sign_in_paused'
            ? `Too many wrong passwords. Try again in ${minutes(Number(value.until))}.`
            : value.error === 'mini_app_password_not_set'
              ? 'No password is set yet. Set one in the dashboard first.'
              : 'Nocheh could not be reached. Try again in a minute.',
      );
    } catch {
      setProblem('Nocheh could not be reached. Try again in a minute.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-5 p-6 pt-16">
      <div className="flex items-center gap-2.5 text-lg font-semibold">
        <LogoMark className="w-8" /> Nocheh
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Password" htmlFor="mini-password" error={problem}>
          <Input
            id="mini-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            disabled={busy}
            onChange={e => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!password}>
          <LockKeyhole aria-hidden /> Sign in
        </Button>
      </form>
      <p className="text-[13px] text-muted">
        You set and change this password in the dashboard, in Settings › Telegram. This phone stays signed in until you
        sign out or don’t open the mini app for 30 days.
      </p>
    </div>
  );
}

/** Shows the mini app only to a phone signed in with the password. */
function Locked({children}: {children: React.ReactNode}) {
  const [state, setState] = React.useState<LockState>('checking');
  const check = React.useCallback(async () => {
    setState('checking');
    try {
      const {status, value} = await miniCall('session');
      if (status !== 200) throw new Error(value.error);
      if (value.state !== 'signed_in') rememberSession(null);
      setState(value.state === 'signed_in' || value.state === 'no_password' ? value.state : 'signed_out');
    } catch {
      setState('unavailable');
    }
  }, []);
  React.useEffect(() => {
    void check();
    const signedOut = (event: Event) => {
      rememberSession(null);
      setState((event as CustomEvent).detail === 'mini_app_password_not_set' ? 'no_password' : 'signed_out');
    };
    window.addEventListener('nocheh:mini-signed-out', signedOut);
    return () => window.removeEventListener('nocheh:mini-signed-out', signedOut);
  }, [check]);
  if (state === 'signed_in') return <>{children}</>;
  if (state === 'checking')
    return (
      <div className="mx-auto max-w-md p-6">
        <LoadingRows rows={2} />
      </div>
    );
  if (state === 'signed_out') return <SignIn onSignedIn={() => setState('signed_in')} />;
  return (
    <div className="mx-auto max-w-md p-6">
      {state === 'no_password' ? (
        <Notice tone="warn" title="Set a password first">
          The mini app opens only with a password. Set one in the dashboard, in Settings › Telegram, under Mini app.
        </Notice>
      ) : (
        <Notice
          tone="bad"
          title="Nocheh can’t be reached"
          action={<Button onClick={() => void check()}>Try again</Button>}
        >
          Check that Nocheh is running at home.
        </Notice>
      )}
    </div>
  );
}

function SignOut() {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2.5"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        await miniCall('sign-out', {}).catch(() => {});
        rememberSession(null);
        window.dispatchEvent(new CustomEvent('nocheh:mini-signed-out', {detail: 'mini_app_sign_in_required'}));
      }}
    >
      <LogOut aria-hidden /> Sign out of this phone
    </Button>
  );
}

function MiniHome() {
  const waiting = useInboxCount();
  const tasks = useResource<{tasks: Task[]; counts: Record<string, number>}>('/tasks?state=open&limit=3', 30000);
  const open = tasks.data?.counts?.open ?? 0;
  return (
    <Page
      title={
        <span className="flex items-center gap-2.5">
          <LogoMark className="w-8" />
          Nocheh
        </span>
      }
    >
      <a href="#inbox" className="block">
        <Card>
          <CardBody className="flex items-center gap-3">
            <InboxIcon className="size-5 text-accent-text" aria-hidden />
            <div className="flex-1">
              <p className="font-medium">{waiting ? `${waiting} waiting for you` : 'Nothing waiting for you'}</p>
              <p className="text-[13px] text-muted">Approvals and questions from Nocheh.</p>
            </div>
          </CardBody>
        </Card>
      </a>
      <a href="#tasks" className="block">
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <ListChecks className="size-5 text-accent-text" aria-hidden />
              <p className="flex-1 font-medium">
                {open ? `${open} open ${open === 1 ? 'task' : 'tasks'}` : 'No open tasks'}
              </p>
            </div>
            {!!tasks.data?.tasks.length && (
              <ul className="mt-2 space-y-1 pl-8 text-[13px]">
                {tasks.data.tasks.map(task => (
                  <li key={task.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    {task.due_on && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-muted">
                        <CalendarClock className="size-3" aria-hidden /> {day(task.due_on)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </a>
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Monitor className="size-4" aria-hidden /> Settings are on your dashboard at home.
      </p>
      <SignOut />
    </Page>
  );
}

/** What System › Health lists, with Retry failed; fixes such as choosing a model stay on the dashboard. */
function MiniProblems() {
  const monitoring = useResource<any>('/monitoring', 30000);
  const feedback = useFeedback();
  const [busy, setBusy] = React.useState(false);
  const m = monitoring.data;
  const list = issues(m);
  const retryable = workCounts(m?.workflows).retrying;
  const retry = async () => {
    setBusy(true);
    try {
      const {retried} = await apiPost<{retried: number}>('/workflows/retry-failed', {});
      feedback.toast(
        retried
          ? `Retrying ${retried} failed ${retried === 1 ? 'task' : 'tasks'} now.`
          : 'Nothing failed can be retried right now.',
      );
      await refreshResources();
    } catch {
      feedback.toast('Couldn’t retry right now. Try again.', 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Health" description="What needs a look, the same as System › Health on the dashboard.">
      {monitoring.error && !m && <LoadError what="health" />}
      {!m && !monitoring.error && <Skeleton className="h-24 w-full rounded-xl" />}
      {m && (
        <Card>
          {list.length ? (
            <ul>
              {list.map(item => (
                <li key={item.text} className="flex items-start gap-3 border-t border-line px-4 py-3 first:border-t-0">
                  <Dot tone={item.tone} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.text}</p>
                    {item.detail && <p className="text-[13px] text-muted">{item.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <CardBody className="text-sm">Everything is running.</CardBody>
          )}
        </Card>
      )}
      {retryable > 0 && (
        <Button onClick={retry} busy={busy} disabled={busy}>
          Retry {retryable} failed {retryable === 1 ? 'task' : 'tasks'} now
        </Button>
      )}
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Monitor className="size-4" aria-hidden /> Other fixes, such as choosing another model, are on your dashboard.
      </p>
    </Page>
  );
}

function MiniInbox() {
  const kind = useParam('kind');
  const decision = useParam('decision');
  const action = useParam('action');
  const validKind = !!kind && Object.hasOwn(decisionLabels, kind);
  return (
    <Page title="Inbox" description="Things waiting for your yes or no.">
      <Waiting />
      {decision && validKind && (
        <DecisionDrawer
          key={kind + ':' + decision}
          kind={kind as DecisionKind}
          id={decision}
          onClose={() => setParams({kind: null, decision: null}, true)}
        />
      )}
      {action && !decision && <ActionDrawer key={action} id={action} onClose={() => setParams({action: null}, true)} />}
    </Page>
  );
}

function MiniApp({launched}: {launched: boolean}) {
  const hash = useHash();
  const key = hash.replace(/^#/, '').split('?')[0];
  const page: MiniPage = key === 'inbox' || key === 'tasks' || key === 'problems' ? key : 'home';
  const waiting = useInboxCount();
  if (!launched)
    return (
      <div className="mx-auto max-w-md p-6">
        <Notice tone="info" title="Open this from Telegram">
          This page works inside your chat with Nocheh. Tap the Nocheh button next to the message box.
        </Notice>
      </div>
    );
  return (
    <Locked>
      <div className="flex h-dvh flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          {page === 'home' && <MiniHome />}
          {page === 'inbox' && <MiniInbox />}
          {page === 'tasks' && <Tasks />}
          {page === 'problems' && <MiniProblems />}
        </main>
        <nav aria-label="Main" className="flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
          {tabs.map(({id, title, Icon}) => (
            <a
              key={id}
              href={'#' + id}
              aria-current={page === id ? 'page' : undefined}
              className={cn(
                'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
                page === id ? 'text-accent-text' : 'text-muted',
              )}
            >
              <Icon className="size-5" />
              {title}
              {id === 'inbox' && !!waiting && (
                <span className="absolute top-1 left-1/2 ml-2 rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-on-accent">
                  {waiting > 99 ? '99+' : waiting}
                </span>
              )}
            </a>
          ))}
        </nav>
      </div>
    </Locked>
  );
}

const launch = launchData();
window.__NOCHEH_TELEGRAM__ = launch;
try {
  window.__NOCHEH_MINI_SESSION__ = localStorage.getItem(SESSION_KEY) || undefined;
} catch {}
applyTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FeedbackProvider>
      <MiniApp launched={!!launch} />
    </FeedbackProvider>
  </React.StrictMode>,
);
telegramEvent('web_app_ready');
telegramEvent('web_app_expand');
