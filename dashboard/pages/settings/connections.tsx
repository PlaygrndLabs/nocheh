/**
 * Connections › Yours: the owner's own Notion, used only in the owner's private chat (ADR-0271).
 * The owner signs in to Notion here, then turns it on and
 * chooses which Notion calls ask first. The sign-in stays with the other keys
 * and is never shown again. On/off and approvals save from the top of the page.
 * A project's own Notion uses the same card in Memory › Projects (ADR-0268).
 */
import {useEffect, useRef, useState} from 'react';
import {ExternalLink, Unplug} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Details,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  SettingRow,
  Switch,
} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {errorWords, when} from '../memory/shared';

type Approval = 'changes' | 'everything' | 'nothing';
type NotionSettings = {enabled: boolean; approval: Approval; revision: number};
type NotionSignIn = {
  connected: boolean;
  method: 'oauth' | 'token' | null;
  workspace: string | null;
  /** The Notion account signed in, as Notion's own notion-get-self tool names it; null until Notion says. */
  account_name: string | null;
  account_email: string | null;
  connected_at: number | null;
  reconnect: boolean;
};

const approvals: {value: Approval; label: string}[] = [
  {value: 'changes', label: 'Reads run, changes ask me'},
  {value: 'everything', label: 'Everything asks me'},
  {value: 'nothing', label: 'Nothing asks me'},
];
/** Shown only while Nothing asks me is picked: under it, Notion's page tools run in your private chat without a card (ADR-0251, ADR-0263). */
const nothingAsksWarning =
  'With this on, text Nocheh reads, like a forwarded message, a file or a Notion page, can also make it save, change or delete your Notion pages without asking. It still asks before it reads a page outside your Notion that you didn’t send it, adds an image, embed or file from outside, or uses calendar, Notion AI agents, uploads or a tool Notion adds later.';
const signInErrors: Record<string, string> = {
  notion_sign_in_expired: 'That Notion sign-in took too long or was started elsewhere. Press Connect Notion again.',
  notion_sign_in_refused: 'Notion did not accept the sign-in. Press Connect Notion again.',
  notion_token_refused: 'Notion refused that token. Check it in Notion’s developer portal and paste it again.',
  invalid_notion_token: 'That doesn’t look like a Notion token.',
  notion_unavailable: 'Notion could not be reached. Try again in a minute.',
  notion_registration_failed: 'Notion did not register Nocheh. Try again in a minute.',
};
const signInWords = (e: unknown) => signInErrors[(e as ApiError)?.message ?? ''] ?? errorWords(e);
/** Which Notion account a sign-in belongs to: `Name (email)`, either one alone, or empty when Notion has not said. */
export const notionAccount = (status: Pick<NotionSignIn, 'account_name' | 'account_email'>) =>
  status.account_name && status.account_email
    ? `${status.account_name} (${status.account_email})`
    : (status.account_name ?? status.account_email ?? '');

/** Which Notion a sign-in started for: a project's id, or empty for your own. Notion's return address is the same for
 * every sign-in, so the dashboard remembers it in this tab until the sign-in comes back. */
const signInKey = 'nocheh.notion-sign-in-project';
const projectQuery = (project?: string) => (project ? '?project=' + encodeURIComponent(project) : '');

/** Notion sends the browser back to `/?connect=notion&code=…&state=…`; finish the sign-in and clean the address. */
function useNotionReturn(onDone: (message: string, failed?: boolean) => void) {
  const handled = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (handled.current || params.get('connect') !== 'notion') return;
    handled.current = true;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const code = params.get('code'),
      state = params.get('state');
    if (!code || !state) {
      onDone(
        params.get('error') === 'access_denied' ? 'Notion sign-in was cancelled.' : 'Notion sign-in did not finish.',
        true,
      );
      return;
    }
    let project = '';
    try {
      project = sessionStorage.getItem(signInKey) ?? '';
      sessionStorage.removeItem(signInKey);
    } catch {
      /* without storage the sign-in finishes as your own; a project's then fails as expired */
    }
    apiPost('/connections/notion/finish', {code, state, ...(project ? {project} : {})}).then(
      () => {
        onDone(
          project
            ? 'The project’s Notion is connected. Turn it on in the project’s Notion card in Memory › Projects and save.'
            : 'Notion is connected. Turn it on below and save.',
        );
        void refreshResources();
      },
      e => onDone(signInWords(e), true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function ConnectionSettings() {
  const feedback = useFeedback();
  const [problem, setProblem] = useState<string | null>(null);
  useNotionReturn((message, failed) => (failed ? setProblem(message) : feedback.toast(message)));
  return <NotionConnection returned={problem} />;
}

/** One Notion connection: your own, or a project's (ADR-0268). `returned` is a sign-in that came back and failed. */
export function NotionConnection({
  project,
  returned,
}: {
  project?: {id: string; name: string};
  returned?: string | null;
}) {
  const query = projectQuery(project?.id);
  const signIn = useResource<NotionSignIn>('/connections/notion' + query);
  const saved = useResource<NotionSettings>('/notion' + query);
  const feedback = useFeedback();
  const [draft, setDraft] = useState<Pick<NotionSettings, 'enabled' | 'approval'> | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shownProblem = problem ?? returned ?? null;
  const target = project ? {project: project.id} : {};

  const data = saved.data;
  const value = draft ?? data ?? null;
  const dirty = !!draft && !!data && (draft.enabled !== data.enabled || draft.approval !== data.approval);
  const edit = (next: Partial<Pick<NotionSettings, 'enabled' | 'approval'>>) => {
    if (!value) return;
    // A project's card sits in a drawer, over the page's Save: each change there saves at once.
    if (project) {
      void run('setting', async () => {
        await apiPost('/notion', {...target, expected_revision: data?.revision, ...next});
        await refreshResources();
      });
      return;
    }
    setRevision(current => current ?? data?.revision ?? null);
    setDraft({enabled: value.enabled, approval: value.approval, ...next});
  };
  const reset = () => {
    setDraft(null);
    setRevision(null);
  };
  useDraftSource({
    id: 'notion-settings' + (project ? ':' + project.id : ''),
    labels: dirty ? [project ? project.name + ': Notion' : 'Your Notion'] : [],
    save: async () => {
      if (!draft) return;
      try {
        await apiPost('/notion', {
          ...target,
          expected_revision: revision ?? data?.revision,
          enabled: draft.enabled,
          approval: draft.approval,
        });
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /changed/.test((e as ApiError)?.message ?? '')
            ? 'Notion settings were changed somewhere else. Your edits are kept; check them and save again.'
            : errorWords(e),
        );
      }
    },
    discard: reset,
  });

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(signInWords(e));
    } finally {
      setBusy(null);
    }
  };
  const connect = () =>
    run('connect', async () => {
      const {url} = await apiPost<{url: string}>('/connections/notion/start', {
        ...target,
        redirect: window.location.origin + '/?connect=notion',
      });
      try {
        sessionStorage.setItem(signInKey, project?.id ?? '');
      } catch {
        /* a project's sign-in then comes back as expired, and says so */
      }
      window.location.assign(url);
    });
  const saveToken = () =>
    run('token', async () => {
      await apiPost('/connections/notion/token', {...target, token});
      setToken('');
      feedback.toast('Notion token saved. Turn Notion on below and save.');
      await refreshResources();
    });
  const disconnect = async () => {
    const ok = await feedback.confirm({
      title: project ? `Disconnect ${project.name}’s Notion?` : 'Disconnect Notion?',
      body: 'Nocheh forgets this Notion sign-in and stops using it. The Notion pages stay as they are.',
      confirm: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    await run('disconnect', async () => {
      await apiPost('/connections/notion/disconnect', target);
      if (data?.enabled) await apiPost('/notion', {...target, expected_revision: data.revision, enabled: false});
      reset();
      feedback.toast('Notion disconnected.');
      await refreshResources();
    });
  };

  if ((signIn.error && !signIn.data) || (saved.error && !data))
    return <LoadError what="connections" onRetry={() => void refreshResources()} />;
  if (!signIn.data || !value)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  const status = signIn.data;
  const suffix = project ? '-' + project.id.slice(0, 8) : '',
    titleId = 'notion-title' + suffix,
    enabledId = 'notion-enabled' + suffix,
    approvalId = 'notion-approval' + suffix;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader
        id={titleId}
        title={project ? 'Notion for this project' : 'Your Notion'}
        description={
          project
            ? `A Notion this project’s groups use, through Notion’s own MCP server: everyone who talks to Nocheh in ${project.name}’s groups can have it searched and read, and your private chat can use it too. Changes ask you as set below. Other groups and other people’s private chats never reach it.`
            : 'Your own Notion, used only in your private chat and in background jobs you approve there. Nocheh can search, read and change it through Notion’s own MCP server. Groups and members never reach it; a project can have its own Notion, in the Projects tab. Nocheh’s own task list stays the main one.'
        }
        action={
          status.connected ? (
            <Badge tone="good" dot>
              Connected{status.workspace ? ' to ' + status.workspace : ''}
            </Badge>
          ) : status.reconnect ? (
            <Badge tone="warn" dot>
              Sign in again
            </Badge>
          ) : (
            <Badge dot>Not connected</Badge>
          )
        }
      />
      <div className="mt-3 border-t border-line">
        {shownProblem && (
          <div className="px-5 pt-4">
            <Notice tone="bad">{shownProblem}</Notice>
          </div>
        )}
        <SettingRow
          title="Notion sign-in"
          description={
            status.connected
              ? (status.method === 'token' ? 'Signed in with an MCP token' : 'Signed in through Notion') +
                (notionAccount(status) ? ' as ' + notionAccount(status) : '') +
                (status.connected_at ? ', ' + when(new Date(status.connected_at * 1000).toISOString()) : '') +
                '. Notion decides which pages Nocheh can see.'
              : status.reconnect
                ? 'Notion ended the sign-in. Connect again to keep using it.'
                : 'Notion opens in this tab. Pick the workspace and the pages Nocheh may use, then press Allow.'
          }
        >
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              variant={status.connected ? 'secondary' : 'primary'}
              busy={busy === 'connect'}
              disabled={!!busy}
              onClick={() => void connect()}
            >
              <ExternalLink aria-hidden /> {status.connected ? 'Connect again' : 'Connect Notion'}
            </Button>
            {(status.connected || status.reconnect) && (
              <Button variant="ghost" busy={busy === 'disconnect'} disabled={!!busy} onClick={() => void disconnect()}>
                <Unplug aria-hidden /> Disconnect
              </Button>
            )}
          </div>
        </SettingRow>
        {!status.connected && (
          <div className="border-t border-line px-5 py-4">
            <Details summary="On a Notion Business plan? Paste an MCP token instead">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  void saveToken();
                }}
              >
                <Input
                  type="password"
                  aria-label="Notion MCP token"
                  autoComplete="off"
                  placeholder="Token from Notion’s developer portal"
                  value={token}
                  maxLength={4096}
                  className="min-w-0 flex-1 basis-64"
                  onChange={event => setToken(event.target.value)}
                />
                <Button type="submit" busy={busy === 'token'} disabled={!token.trim() || !!busy}>
                  Save token
                </Button>
              </form>
            </Details>
          </div>
        )}
        <SettingRow
          title="Use Notion"
          htmlFor={enabledId}
          description={
            status.connected ? 'Off keeps the sign-in but stops every Notion call.' : 'Connect Notion first.'
          }
        >
          <Switch
            id={enabledId}
            label={project ? 'Use this project’s Notion' : 'Use Notion'}
            checked={value.enabled}
            disabled={!status.connected && !value.enabled}
            onChange={enabled => edit({enabled})}
          />
        </SettingRow>
        <SettingRow
          title="Ask me first"
          htmlFor={approvalId}
          description={
            project ? (
              <>
                A call that asks shows you the exact Notion change in your private chat and the Inbox before it runs.
                Anyone who talks to Nocheh in this project’s groups can ask for one, so Nothing asks me isn’t offered
                here, and a read of a page outside Notion asks like a change. Deny rules still win.
              </>
            ) : (
              <>
                A call that asks shows you the exact Notion change in your private chat and the Inbox before it runs. A
                read of a page outside your Notion, such as a public notion.site page, asks like a change; with Nothing
                asks me it asks only when you didn’t send that address yourself, and in a background job it always asks.
                A background job reads without asking only if its card said so when you approved it, and only while this
                setting allows it; its changes always ask. Scheduled tasks always ask. Deny rules still win.
                {value.approval === 'nothing' && <span className="mt-1 block text-warn">{nothingAsksWarning}</span>}
              </>
            )
          }
        >
          <Select
            id={approvalId}
            value={value.approval}
            onChange={event => edit({approval: event.target.value as Approval})}
          >
            {approvals
              .filter(item => !project || item.value !== 'nothing')
              .map(item => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
          </Select>
        </SettingRow>
      </div>
    </Card>
  );
}
