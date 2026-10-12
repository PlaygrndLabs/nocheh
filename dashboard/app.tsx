import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {
  Activity as ActivityIcon,
  Archive as ArchiveIcon,
  ArrowUpRight,
  BrainCircuit,
  FolderKanban,
  Home,
  Inbox,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Share2,
  X,
} from 'lucide-react';
import {Status} from './pages/overview';
import {Settings} from './pages/settings';
import {ArchiveWorkspace} from './pages/archive-workspace';
import {Activity} from './pages/activity';
import {MemoryWorkspace} from './pages/memory-workspace';
import {Projects} from './pages/projects';
import {Sharing} from './pages/sharing';
import {Source} from './pages/source';
import {System} from './pages/system';
import {call} from './lib/api';
import {resolveRoute, type PageId} from './lib/routes';
import {Button, Sheet, Tooltip} from './components/ui/primitives';
import {ThemeSelect} from './lib/theme';
import {StatusBadge} from './components/status';
import {useResource, refreshResources} from './lib/resource';

type PageProps = {
  notify: (text: string, error?: boolean) => void;
  call: typeof call;
  renderSource: (record: any) => React.ReactNode;
};
type Route = {id: PageId; title: string; Icon: typeof Home; description: string; Page: React.ComponentType<PageProps>};

/** Sidebar order. Old page names are redirected by `resolveRoute`. */
const routes: Route[] = [
  {id: 'home', title: 'Home', Icon: Home, description: 'What needs you, and how Nocheh is doing.', Page: Status},
  {
    id: 'inbox',
    title: 'Inbox',
    Icon: Inbox,
    description: 'Decisions waiting for you, and what Nocheh did.',
    Page: Activity,
  },
  {
    id: 'sharing',
    title: 'Sharing',
    Icon: Share2,
    description: 'Which chats may use knowledge from other chats.',
    Page: Sharing,
  },
  {
    id: 'memory',
    title: 'Memory',
    Icon: BrainCircuit,
    description: 'What Nocheh knows: notes, learned facts, people, projects and long-term memory.',
    Page: MemoryWorkspace,
  },
  {
    id: 'archive',
    title: 'Archive',
    Icon: ArchiveIcon,
    description: 'Every original message, and the copy agents may use.',
    Page: ArchiveWorkspace,
  },
  {
    id: 'projects',
    title: 'Projects',
    Icon: FolderKanban,
    description: 'Projects, the chats in them, and project memory.',
    Page: Projects,
  },
  {
    id: 'system',
    title: 'System',
    Icon: Server,
    description: 'Health, connections, databases, backups and maintenance.',
    Page: System,
  },
  {
    id: 'settings',
    title: 'Settings',
    Icon: SettingsIcon,
    description: 'Telegram, models, speed and assistant preferences.',
    Page: Settings,
  },
];

/** Rewrite an old page name in the address before any page reads it. */
function canonicalRoute(): PageId {
  const {page, hash} = resolveRoute(location.hash);
  if (hash) history.replaceState(null, '', hash);
  return page;
}
canonicalRoute();
// Registered before any page mounts, so pages listening for hash changes see the new name.
addEventListener('hashchange', canonicalRoute);

function PersistentStatus() {
  const {data, error} = useResource<any>('/monitoring', 10000);
  return (
    <a className="persistent-status" href="#system?view=health" aria-label="Inspect system status">
      <StatusBadge
        state={
          error ? 'stale' : data?.application?.ok ? 'ready' : data?.application?.ok === false ? 'failed' : 'unknown'
        }
        label={
          error
            ? 'Status stale'
            : data?.application?.ok
              ? 'API ready'
              : data?.application?.ok === false
                ? 'API unavailable'
                : 'Status unobserved'
        }
      />
    </a>
  );
}
function App() {
  const [page, setPage] = React.useState(canonicalRoute),
    [mobile, setMobile] = React.useState(false),
    [collapsed, setCollapsed] = React.useState(() => {
      try {
        return localStorage.getItem('nocheh.sidebar.v1') === 'collapsed';
      } catch {
        return false;
      }
    }),
    [notice, setNotice] = React.useState<{text: string; error: boolean} | null>(null),
    [refreshing, setRefreshing] = React.useState(false);
  const heading = React.useRef<HTMLHeadingElement>(null),
    menu = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    const change = () => {
      setPage(resolveRoute(location.hash).page);
      setNotice(null);
      setMobile(false);
    };
    addEventListener('hashchange', change);
    return () => removeEventListener('hashchange', change);
  }, []);
  React.useEffect(() => {
    heading.current?.focus({preventScroll: true});
  }, [page]);
  const toggle = () =>
    setCollapsed(value => {
      try {
        localStorage.setItem('nocheh.sidebar.v1', !value ? 'collapsed' : 'expanded');
      } catch {}
      return !value;
    });
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshResources();
    } finally {
      setRefreshing(false);
    }
  };
  const notify = React.useCallback((text: string, error = false) => setNotice({text, error}), []);
  const route = routes.find(r => r.id === page)!;
  const Current = route.Page;
  const renderSource = (record: any) => <Source record={record} notify={notify} />;
  const navigation = (compact = false, showToggle = false) => (
    <>
      <div className="n-sidebar-head">
        <a href="#home" className="n-brand">
          <span className="n-mark" aria-hidden="true">
            ن
          </span>
          <span className={compact ? 'sr-only' : ''}>
            Nocheh<small>Your personal brain</small>
          </span>
        </a>
        {showToggle && (
          <Button
            className="sidebar-toggle"
            size="icon"
            onClick={toggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
      <nav aria-label="Main navigation">
        <div className="n-nav-group">
          {routes.map(({id, title, Icon}) => {
            const link = (
              <a
                href={'#' + id}
                aria-current={page === id ? 'page' : undefined}
                aria-label={compact ? title : undefined}
                onClick={() => setMobile(false)}
              >
                <Icon size={18} aria-hidden="true" />
                <span className={compact ? 'sr-only' : ''}>{title}</span>
              </a>
            );
            return compact ? (
              <Tooltip label={title} key={id}>
                {link}
              </Tooltip>
            ) : (
              <React.Fragment key={id}>{link}</React.Fragment>
            );
          })}
        </div>
      </nav>
      <div className="n-sidebar-foot">
        <a href="/hermes/nocheh" aria-label="Open Hermes dashboard" title="Open Hermes dashboard">
          <Plug size={18} aria-hidden="true" />
          <span className={compact ? 'sr-only' : ''}>Hermes</span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
        <a href="/providers/management.html" aria-label="Open CPA dashboard" title="Open CPA dashboard">
          <ActivityIcon size={18} aria-hidden="true" />
          <span className={compact ? 'sr-only' : ''}>CPA dashboard</span>
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
    </>
  );
  return (
    <div
      className={'nocheh-app' + (collapsed ? ' sidebar-collapsed' : '') + (page === 'memory' ? ' n-graph-active' : '')}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={e => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="n-sidebar">{navigation(collapsed, true)}</aside>
      <Sheet open={mobile} onOpenChange={setMobile} title="Navigation" side="left" returnFocus={menu.current}>
        <div className="mobile-navigation">{navigation()}</div>
      </Sheet>
      <main className="n-main" id="main-content" tabIndex={-1}>
        <header className="n-header">
          <div className="page-title">
            <Button
              className="mobile-menu"
              size="icon"
              onClick={() => setMobile(true)}
              ref={menu}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </Button>
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {route.title}
              </h1>
              <p className="n-page-description">{route.description}</p>
            </div>
          </div>
          <div className="header-actions">
            <PersistentStatus />
            <ThemeSelect />
            <Button onClick={refresh} disabled={refreshing} aria-label="Refresh page data">
              <RefreshCw size={15} className={refreshing ? 'refreshing' : ''} />
              <span>Refresh</span>
            </Button>
          </div>
        </header>
        {notice && (
          <div className={'n-notice ' + (notice.error ? 'n-error' : '')} role={notice.error ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            <Button size="icon" variant="ghost" onClick={() => setNotice(null)} aria-label="Dismiss notification">
              <X size={16} />
            </Button>
          </div>
        )}
        <div className="page-content" key={page}>
          <Current notify={notify} call={call} renderSource={renderSource} />
        </div>
        <footer>Owned sources. Useful memory. Clear operations.</footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
