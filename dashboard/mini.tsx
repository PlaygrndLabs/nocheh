/**
 * The Telegram Mini App: Home, Inbox, Tasks and Health on the owner's phone,
 * inside Telegram. It uses the same owner API and pages as the dashboard;
 * Settings and the rest of System stay on the dashboard at home.
 */
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {Activity, CalendarClock, Home, Inbox as InboxIcon, ListChecks, Monitor} from 'lucide-react';
import {useHash, useParam} from './lib/navigation';
import {useInboxCount} from './lib/inbox';
import {apiPost} from './lib/api';
import {refreshResources, useResource} from './lib/resource';
import {issues, workCounts} from './lib/system-health';
import {setParams} from './lib/routes';
import {decisionLabels, type DecisionKind} from './lib/supervision';
import {cn} from './lib/utils';
import {Button, Card, CardBody, Dot, LoadError, Notice, Skeleton} from './ui/core';
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
  );
}

const launch = launchData();
window.__NOCHEH_TELEGRAM__ = launch;
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
