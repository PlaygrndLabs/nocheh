/**
 * The members' app (step 5, ADR-0265): what a member opens from the menu button in their own private chat with Nocheh,
 * at /m/. Tasks, Groups, Chat (later) and Settings, only from the groups they joined, through `/api/member` only.
 *
 * It imports nothing from the owner's pages, lib/api.ts or mini.tsx, never reads the owner page's storage keys, strips
 * the launch from the address at once, renders no raw HTML and follows only http(s) links.
 */
import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {ListChecks, MessagesSquare, Settings as SettingsIcon, UsersRound} from 'lucide-react';
import type {MemberMe} from '../src/member-app-wire';
import {cn} from './lib/utils';
import {Button, LoadingRows, Notice} from './ui/core';
import {LogoMark} from './ui/logo';
import {memberApi, MemberApiError, SCREEN_EVENT, screenFor, useLaunch, type Screen} from './member/api';
import type {WordKey} from './member/i18n';
import {
  applyTheme,
  dropLaunch,
  forgetAll,
  keepLaunch,
  takeLaunch,
  telegramEvent,
  writeUi,
  type Launch,
} from './member/launch';
import {makeWords, Toasts, WordsContext, useWords} from './member/shared';
import {MemberTasks, type TasksFocus} from './member/tasks';
import {MemberGroups} from './member/groups';
import {MemberSettings} from './member/settings';

type Tab = 'tasks' | 'groups' | 'chat' | 'settings';
const tabs: {id: Tab; word: WordKey; Icon: React.ComponentType<{className?: string}>}[] = [
  {id: 'tasks', word: 'tab_tasks', Icon: ListChecks},
  {id: 'groups', word: 'tab_groups', Icon: UsersRound},
  {id: 'chat', word: 'tab_chat', Icon: MessagesSquare},
  {id: 'settings', word: 'tab_settings', Icon: SettingsIcon},
];
type State = 'loading' | 'ready' | 'unreachable' | 'no_launch' | 'signed_out' | Screen;

/** A whole-page message instead of the app: no data, and Close where Telegram can close it. */
function Message({
  title,
  body,
  close,
  action,
}: {
  title: WordKey;
  body: WordKey;
  close?: boolean;
  action?: React.ReactNode;
}) {
  const {t} = useWords();
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-5 p-6 pt-16" data-screen={title}>
      <div className="flex items-center gap-2.5 text-lg font-semibold">
        <LogoMark className="w-8" /> Nocheh
      </div>
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">{t(title)}</h1>
        <p className="text-sm text-muted">{t(body)}</p>
      </div>
      {action}
      {close && <Button onClick={() => telegramEvent('web_app_close')}>{t('close')}</Button>}
    </div>
  );
}

function MemberApp({launch}: {launch: Launch}) {
  const words = React.useMemo(() => makeWords(), []);
  const [state, setState] = React.useState<State>(launch.data ? 'loading' : 'no_launch');
  const [me, setMe] = React.useState<MemberMe | null>(null);
  const [tab, setTab] = React.useState<Tab>('tasks');
  const [focus, setFocus] = React.useState<TasksFocus>({});

  const load = React.useCallback(async () => {
    try {
      const value = await memberApi.me();
      // Kept only now that the member listener took it: an owner's or a closed launch is never stored.
      keepLaunch(launch.data);
      setMe(value);
      setState('ready');
    } catch (error) {
      // A screen answer ends the visit through SCREEN_EVENT; anything else leaves Nocheh unreachable for now.
      if (!(error instanceof MemberApiError) || !screenFor(error.status, error.code))
        setState(current => (current === 'loading' ? 'unreachable' : current));
    }
  }, [launch.data]);

  React.useEffect(() => {
    const ended = (event: Event) => {
      const screen = (event as CustomEvent<Screen>).detail;
      if (screen === 'reopen') dropLaunch();
      else forgetAll();
      setMe(null);
      setState(screen);
    };
    window.addEventListener(SCREEN_EVENT, ended);
    if (launch.data) void load();
    return () => window.removeEventListener(SCREEN_EVENT, ended);
  }, [launch.data, load]);

  const signedOut = React.useCallback(() => {
    forgetAll();
    setMe(null);
    setState('signed_out');
    telegramEvent('web_app_close');
  }, []);

  let body: React.ReactNode;
  if (state === 'no_launch') body = <Message title="launch_missing_title" body="launch_missing_body" />;
  else if (state === 'reopen') body = <Message title="reopen_title" body="reopen_body" close />;
  else if (state === 'closed') body = <Message title="closed_title" body="closed_body" close />;
  else if (state === 'owner') body = <Message title="owner_title" body="owner_body" close />;
  else if (state === 'signed_out') body = <Message title="signed_out_title" body="signed_out_body" close />;
  else if (state === 'unreachable')
    body = (
      <Message
        title="unreachable_title"
        body="unreachable_body"
        action={
          <Button
            onClick={() => {
              setState('loading');
              void load();
            }}
          >
            {words.t('try_again')}
          </Button>
        }
      />
    );
  else if (state === 'loading' || !me)
    body = (
      <div className="mx-auto max-w-md p-6" aria-label={words.t('loading')}>
        <LoadingRows rows={3} />
      </div>
    );
  else
    body = (
      <div className="flex h-dvh flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'tasks' && <MemberTasks me={me} focus={focus} onMe={load} />}
          {tab === 'groups' && (
            <MemberGroups
              me={me}
              onOpen={(project, group) => {
                writeUi({project});
                setFocus({project, group, at: Date.now()});
                setTab('tasks');
              }}
            />
          )}
          {tab === 'chat' && (
            <section className="mx-auto max-w-2xl space-y-3 p-4">
              <h1 className="text-xl font-semibold">{words.t('tab_chat')}</h1>
              <Notice tone="info">{words.t('chat_later')}</Notice>
            </section>
          )}
          {tab === 'settings' && <MemberSettings me={me} onSignedOut={signedOut} />}
        </main>
        <nav
          aria-label={words.t('main_nav')}
          className="flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
        >
          {tabs.map(({id, word, Icon}) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              aria-disabled={id === 'chat' ? true : undefined}
              onClick={() => {
                // The Tasks tab from here opens on the remembered project, not on a group tapped earlier.
                if (id === 'tasks' && tab !== 'tasks') setFocus({});
                setTab(id);
              }}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
                tab === id ? 'text-accent-text' : 'text-muted',
                id === 'chat' && 'opacity-50',
              )}
            >
              <Icon className="size-5" />
              {words.t(word)}
            </button>
          ))}
        </nav>
      </div>
    );
  return (
    <WordsContext.Provider value={words}>
      <Toasts>{body}</Toasts>
    </WordsContext.Provider>
  );
}

const launch = takeLaunch();
useLaunch(launch.data);
applyTheme(launch.theme);
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <MemberApp launch={launch} />
    </React.StrictMode>,
  );
telegramEvent('web_app_ready');
telegramEvent('web_app_expand');
