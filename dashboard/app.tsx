import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {
  Activity,
  ArrowUpRight,
  BrainCircuit,
  ChevronDown,
  Gauge,
  Home,
  Inbox,
  ListChecks,
  LockKeyhole,
  LogOut,
  Menu,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Sun,
  Users,
  X,
} from 'lucide-react';
import {resolveRoute, type PageId} from './lib/routes';
import {useHash, useParam} from './lib/navigation';
import {tabLinks} from './lib/page-tabs';
import {useResource} from './lib/resource';
import {useInboxCount} from './lib/inbox';
import {cn} from './lib/utils';
import {apiPost} from './lib/api';
import {Button, Dot, Field, Input, Spinner, type Tone} from './ui/core';
import {FeedbackProvider} from './ui/overlay';
import {SaveWatcher} from './ui/save-bar';
import {LogoMark, Wordmark} from './ui/logo';

type NavItem = {id: PageId; title: string; Icon: React.ComponentType<{className?: string}>};
const nav: NavItem[] = [
  {id: 'home', title: 'Home', Icon: Home},
  {id: 'inbox', title: 'Inbox', Icon: Inbox},
  {id: 'tasks', title: 'Tasks', Icon: ListChecks},
  {id: 'chats', title: 'Chats', Icon: Users},
  {id: 'messages', title: 'Messages', Icon: MessagesSquare},
  {id: 'memory', title: 'Memory', Icon: BrainCircuit},
  {id: 'usage', title: 'Usage', Icon: Gauge},
  {id: 'system', title: 'System', Icon: Server},
  {id: 'settings', title: 'Settings', Icon: Settings},
];

const pages: Record<PageId, React.LazyExoticComponent<React.ComponentType>> = {
  home: React.lazy(() => import('./pages/home')),
  inbox: React.lazy(() => import('./pages/inbox')),
  tasks: React.lazy(() => import('./pages/tasks')),
  chats: React.lazy(() => import('./pages/chats')),
  messages: React.lazy(() => import('./pages/messages')),
  memory: React.lazy(() => import('./pages/memory')),
  usage: React.lazy(() => import('./pages/usage')),
  system: React.lazy(() => import('./pages/system')),
  settings: React.lazy(() => import('./pages/settings')),
};

/** Rewrites an old page name in the address before any page reads it. */
function canonicalPage(): PageId {
  const {page, hash} = resolveRoute(location.hash);
  if (hash) history.replaceState(null, '', hash);
  return page;
}
// Notion's sign-in returns to `/?connect=notion…`; Settings › Connections finishes it.
if (new URLSearchParams(location.search).get('connect') === 'notion')
  history.replaceState(null, '', location.pathname + location.search + '#settings?view=connections');
canonicalPage();
addEventListener('hashchange', canonicalPage);

type Theme = 'system' | 'light' | 'dark';
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = React.useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('nocheh.theme.v1');
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  React.useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
    apply();
    media.addEventListener('change', apply);
    try {
      localStorage.setItem('nocheh.theme.v1', theme);
    } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, () => setTheme(current => (current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'))];
}

/** Whether Nocheh's services answer, shown at the foot of the navigation. */
function HealthLink({onNavigate, collapsed}: {onNavigate?: () => void; collapsed?: boolean}) {
  const {data, error} = useResource<any>('/monitoring', 15000);
  // The container list reads {unavailable: true} when Docker cannot be asked; never let that break every page.
  const listed = data?.containers ?? data?.services;
  const services: any[] = Array.isArray(listed) ? listed : [];
  const unhealthy = services.filter(
    row => row.expected_state === 'running' && !['running', 'healthy'].includes(String(row.state)),
  ).length;
  let tone: Tone = 'neutral';
  let text = 'Checking…';
  if (error || (listed && !Array.isArray(listed))) [tone, text] = ['warn', 'Status unavailable'];
  else if (data?.application?.ok === false) [tone, text] = ['bad', 'Nocheh is down'];
  else if (unhealthy)
    [tone, text] = ['warn', unhealthy === 1 ? '1 service needs a look' : `${unhealthy} services need a look`];
  else if (data) [tone, text] = ['good', 'Everything is running'];
  return (
    <a
      href="#system"
      onClick={onNavigate}
      title={collapsed ? text : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg py-2 text-[13px] text-muted hover:bg-subtle hover:text-fg',
        collapsed ? 'justify-center px-0' : 'px-3',
      )}
    >
      {data || error ? <Dot tone={tone} /> : <Spinner className="size-3" />}
      <span className={collapsed ? 'sr-only' : 'truncate'}>{text}</span>
    </a>
  );
}

/** Which pages show their tabs in the sidebar; the open page does unless the owner folded it. */
function useOpenGroups(page: PageId): [(id: PageId) => boolean, (id: PageId) => void] {
  const [chosen, setChosen] = React.useState<Partial<Record<PageId, boolean>>>(() => {
    try {
      return JSON.parse(localStorage.getItem('nocheh.sidebar-groups.v1') || '{}');
    } catch {
      return {};
    }
  });
  const isOpen = (id: PageId) => chosen[id] ?? id === page;
  const toggle = (id: PageId) =>
    setChosen(current => {
      const next = {...current, [id]: !(current[id] ?? id === page)};
      try {
        localStorage.setItem('nocheh.sidebar-groups.v1', JSON.stringify(next));
      } catch {}
      return next;
    });
  return [isOpen, toggle];
}

function Navigation({
  page,
  onNavigate,
  collapsed = false,
  onToggle,
}: {
  page: PageId;
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const inbox = useInboxCount();
  const view = useParam('view');
  const [isOpen, toggleGroup] = useOpenGroups(page);
  const [theme, cycleTheme] = useTheme();
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const themeName = theme === 'system' ? 'Match device' : theme === 'dark' ? 'Dark' : 'Light';
  const label = (text: string) => <span className={collapsed ? 'sr-only' : 'flex-1 truncate'}>{text}</span>;
  const footerItem = cn(
    'flex items-center gap-2.5 rounded-lg py-2 text-[13px] text-muted hover:bg-subtle hover:text-fg',
    collapsed ? 'justify-center px-0' : 'px-3',
  );
  const toggle = onToggle && (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
      title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
    >
      {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
    </Button>
  );
  return (
    <div className="flex h-full flex-col">
      <div className={cn('mb-5 flex items-center gap-2 pt-1', collapsed ? 'flex-col' : 'justify-between pr-1')}>
        <a href="#home" onClick={onNavigate} className={cn('flex items-center gap-2.5', !collapsed && 'px-3')}>
          <LogoMark className="w-8 shrink-0" />
          {!collapsed && <Wordmark className="w-[92px]" />}
          <span className="sr-only">Nocheh</span>
        </a>
        {toggle}
      </div>
      <nav aria-label="Main" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-3">
        {nav.map(({id, title, Icon}) => {
          const tabs = collapsed ? [] : tabLinks(id);
          const open = tabs.length > 0 && isOpen(id);
          const activeTab = page === id ? (tabs.find(tab => tab.id === view) ?? tabs[0])?.id : undefined;
          return (
            <div key={id}>
              <div className="relative">
                <a
                  href={'#' + id}
                  onClick={onNavigate}
                  title={collapsed ? title : undefined}
                  aria-current={page === id ? 'page' : undefined}
                  className={cn(
                    'relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-3',
                    tabs.length && 'pr-9',
                    page === id ? 'bg-accent-soft text-accent-text' : 'text-fg/80 hover:bg-subtle hover:text-fg',
                  )}
                >
                  <Icon className="size-[18px] shrink-0" />
                  {label(title)}
                  {id === 'inbox' &&
                    !!inbox &&
                    (collapsed ? (
                      <span className="absolute top-1.5 right-2.5 size-2 rounded-full bg-accent">
                        <span className="sr-only">, {inbox} waiting</span>
                      </span>
                    ) : (
                      <span className="tabular rounded-full bg-accent px-1.5 text-[11px] leading-5 font-semibold text-on-accent">
                        {inbox > 99 ? '99+' : inbox}
                      </span>
                    ))}
                </a>
                {tabs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(id)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} ${title} tabs`}
                    className={cn(
                      'absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md hover:bg-subtle',
                      page === id ? 'text-accent-text' : 'text-muted hover:text-fg',
                    )}
                  >
                    <ChevronDown aria-hidden className={cn('size-4 transition-transform', !open && '-rotate-90')} />
                  </button>
                )}
              </div>
              {open && (
                <ul
                  aria-label={`${title} tabs`}
                  className="mt-0.5 mb-1 ml-[21px] flex flex-col gap-0.5 border-l border-line pl-2"
                >
                  {tabs.map(tab => (
                    <li key={tab.id}>
                      <a
                        href={tab.href}
                        onClick={onNavigate}
                        aria-current={activeTab === tab.id ? 'true' : undefined}
                        className={cn(
                          'block truncate rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                          activeTab === tab.id
                            ? 'bg-subtle font-medium text-fg'
                            : 'text-muted hover:bg-subtle hover:text-fg',
                        )}
                      >
                        {tab.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-line pt-3">
        <HealthLink onNavigate={onNavigate} collapsed={collapsed} />
        <a href="/hermes/nocheh" className={footerItem} title={collapsed ? 'Assistant console' : undefined}>
          <Activity className="size-4 shrink-0" />
          {label('Assistant console')}
          {!collapsed && <ArrowUpRight className="size-3.5" />}
        </a>
        <button
          type="button"
          onClick={() => void apiPost('/logout', {}).finally(() => location.reload())}
          className={cn(footerItem, 'text-left')}
          title={collapsed ? 'Sign out' : undefined}
        >
          <LogOut className="size-4 shrink-0" />
          {label('Sign out')}
        </button>
        <button
          type="button"
          onClick={cycleTheme}
          className={cn(footerItem, 'text-left')}
          title={collapsed ? themeName : undefined}
          aria-label={`Appearance: ${themeName}. Change appearance`}
        >
          <ThemeIcon className="size-4 shrink-0" />
          {!collapsed && <span>{themeName}</span>}
        </button>
      </div>
    </div>
  );
}

function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem('nocheh.sidebar.v1') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed(current => {
      try {
        localStorage.setItem('nocheh.sidebar.v1', current ? 'expanded' : 'collapsed');
      } catch {}
      return !current;
    });
  return [collapsed, toggle];
}

function App() {
  useHash();
  const page = resolveRoute(location.hash).page;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const main = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    main.current?.scrollTo({top: 0});
  }, [page]);
  const Current = pages[page];
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={cn(
          'hidden shrink-0 border-r border-line bg-surface p-3 lg:block',
          collapsed ? 'w-[68px] px-2' : 'w-60',
        )}
      >
        <Navigation page={page} collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>
      <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay lg:hidden" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-line bg-surface p-3 shadow-xl focus:outline-none lg:hidden"
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close navigation" className="absolute top-3 right-3">
                <X aria-hidden />
              </Button>
            </DialogPrimitive.Close>
            <Navigation page={page} onNavigate={() => setMenuOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 lg:hidden">
          <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
            <Menu aria-hidden />
          </Button>
          <a href="#home" className="flex items-center gap-2">
            <LogoMark className="w-8" />
            <Wordmark className="w-[92px]" />
            <span className="sr-only">Nocheh</span>
          </a>
        </header>
        <main ref={main} id="main" className="min-h-0 flex-1 overflow-y-auto">
          <React.Suspense
            fallback={
              <div className="grid h-64 place-items-center">
                <Spinner className="size-5" />
              </div>
            }
          >
            <Current key={page} />
          </React.Suspense>
          <SaveWatcher />
        </main>
      </div>
    </div>
  );
}

function minutes(until: number): string {
  const left = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return left >= 120 ? `${Math.round(left / 60)} hours` : `${left} ${left === 1 ? 'minute' : 'minutes'}`;
}

/**
 * The dashboard's sign-in. On the first visit it creates the owner's Nocheh
 * password, which the mini app uses too; after that it asks for it.
 */
function Login({mode}: {mode: 'create' | 'sign_in'}) {
  const [password, setPassword] = React.useState('');
  const [repeat, setRepeat] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const create = mode === 'create';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (create && password !== repeat) return setProblem('The two passwords are different.');
    setBusy(true);
    setProblem(null);
    const response = await fetch('/api/nocheh/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({password}),
    }).catch(() => null);
    const value = await response?.json().catch(() => ({}));
    if (response?.ok) return location.reload();
    setBusy(false);
    if (!create) setPassword('');
    setProblem(
      value?.error === 'wrong_password'
        ? value.tries_left > 0 && value.tries_left <= 2
          ? `Wrong password. ${value.tries_left} ${value.tries_left === 1 ? 'try' : 'tries'} left before a pause.`
          : 'Wrong password.'
        : value?.error === 'sign_in_paused'
          ? `Too many wrong passwords. Try again in ${minutes(Number(value.until))}.`
          : value?.error === 'password_too_short'
            ? 'Use at least 8 characters.'
            : value?.error === 'password_too_long'
              ? 'Use at most 200 characters.'
              : value?.error === 'owner_password_already_set'
                ? 'A password was just created. Reload the page and sign in.'
                : 'Nocheh could not be reached. Try again in a minute.',
    );
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-2.5">
        <LogoMark className="w-9" />
        <Wordmark className="w-[100px]" />
      </div>
      <div>
        <h1 className="text-lg font-semibold">{create ? 'Create your password' : 'Sign in'}</h1>
        <p className="mt-1 text-[13px] text-muted">
          {create
            ? 'One password for this dashboard and the Telegram mini app. Use at least 8 characters.'
            : 'Your Nocheh password. This browser stays signed in for 30 days of use.'}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Password" htmlFor="login-password" error={create ? undefined : problem}>
          <Input
            id="login-password"
            type="password"
            autoComplete={create ? 'new-password' : 'current-password'}
            autoFocus
            value={password}
            disabled={busy}
            onChange={e => setPassword(e.target.value)}
          />
        </Field>
        {create && (
          <Field label="Repeat the password" htmlFor="login-repeat" error={problem}>
            <Input
              id="login-repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              disabled={busy}
              onChange={e => setRepeat(e.target.value)}
            />
          </Field>
        )}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          busy={busy}
          disabled={!password || (create && !repeat)}
        >
          <LockKeyhole aria-hidden /> {create ? 'Create password' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  window.__NOCHEH_LOGIN__ ? (
    <Login mode={window.__NOCHEH_LOGIN__} />
  ) : (
    <FeedbackProvider>
      <App />
    </FeedbackProvider>
  ),
);
