/**
 * Settings › Connections: outside services Nocheh can use for the owner.
 * Notion is the first: the owner signs in to Notion here, then turns it on and
 * chooses which Notion calls ask first. The sign-in stays with the other keys
 * and is never shown again. On/off and approvals save from the top of the page.
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
  connected_at: number | null;
  reconnect: boolean;
};

const approvals: {value: Approval; label: string}[] = [
  {value: 'changes', label: 'Reads run, changes ask me'},
  {value: 'everything', label: 'Everything asks me'},
  {value: 'nothing', label: 'Nothing asks me'},
];
const signInErrors: Record<string, string> = {
  notion_sign_in_expired: 'That Notion sign-in took too long or was started elsewhere. Press Connect Notion again.',
  notion_sign_in_refused: 'Notion did not accept the sign-in. Press Connect Notion again.',
  notion_token_refused: 'Notion refused that token. Check it in Notion’s developer portal and paste it again.',
  invalid_notion_token: 'That doesn’t look like a Notion token.',
  notion_unavailable: 'Notion could not be reached. Try again in a minute.',
  notion_registration_failed: 'Notion did not register Nocheh. Try again in a minute.',
};
const signInWords = (e: unknown) => signInErrors[(e as ApiError)?.message ?? ''] ?? errorWords(e);

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
    apiPost('/connections/notion/finish', {code, state}).then(
      () => {
        onDone('Notion is connected. Turn it on below and save.');
        void refreshResources();
      },
      e => onDone(signInWords(e), true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function ConnectionSettings() {
  const signIn = useResource<NotionSignIn>('/connections/notion');
  const saved = useResource<NotionSettings>('/notion');
  const feedback = useFeedback();
  const [draft, setDraft] = useState<Pick<NotionSettings, 'enabled' | 'approval'> | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useNotionReturn((message, failed) => (failed ? setProblem(message) : feedback.toast(message)));

  const data = saved.data;
  const value = draft ?? data ?? null;
  const dirty = !!draft && !!data && (draft.enabled !== data.enabled || draft.approval !== data.approval);
  const edit = (next: Partial<Pick<NotionSettings, 'enabled' | 'approval'>>) => {
    if (!value) return;
    setRevision(current => current ?? data?.revision ?? null);
    setDraft({enabled: value.enabled, approval: value.approval, ...next});
  };
  const reset = () => {
    setDraft(null);
    setRevision(null);
  };
  useDraftSource({
    id: 'notion-settings',
    labels: dirty ? ['Connections: Notion'] : [],
    save: async () => {
      if (!draft) return;
      try {
        await apiPost('/notion', {
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
        redirect: window.location.origin + '/?connect=notion',
      });
      window.location.assign(url);
    });
  const saveToken = () =>
    run('token', async () => {
      await apiPost('/connections/notion/token', {token});
      setToken('');
      feedback.toast('Notion token saved. Turn Notion on below and save.');
      await refreshResources();
    });
  const disconnect = async () => {
    const ok = await feedback.confirm({
      title: 'Disconnect Notion?',
      body: 'Nocheh forgets its Notion sign-in and stops using Notion. Your Notion pages stay as they are.',
      confirm: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    await run('disconnect', async () => {
      await apiPost('/connections/notion/disconnect', {});
      if (data?.enabled) await apiPost('/notion', {expected_revision: data.revision, enabled: false});
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
  return (
    <Card aria-labelledby="notion-title">
      <CardHeader
        id="notion-title"
        title="Notion"
        description="Let Nocheh search, read and change your Notion from your private chat, through Notion’s own MCP server. Groups never reach it, and Nocheh’s own task list stays the main one."
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
        {problem && (
          <div className="px-5 pt-4">
            <Notice tone="bad">{problem}</Notice>
          </div>
        )}
        <SettingRow
          title="Notion sign-in"
          description={
            status.connected
              ? (status.method === 'token' ? 'Signed in with an MCP token' : 'Signed in through Notion') +
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
          htmlFor="notion-enabled"
          description={
            status.connected ? 'Off keeps the sign-in but stops every Notion call.' : 'Connect Notion first.'
          }
        >
          <Switch
            id="notion-enabled"
            label="Use Notion"
            checked={value.enabled}
            disabled={!status.connected && !value.enabled}
            onChange={enabled => edit({enabled})}
          />
        </SettingRow>
        <SettingRow
          title="Ask me first"
          htmlFor="notion-approval"
          description="A call that asks shows you the exact Notion change in your private chat and the Inbox before it runs. Deny rules still win."
        >
          <Select
            id="notion-approval"
            value={value.approval}
            onChange={event => edit({approval: event.target.value as Approval})}
          >
            {approvals.map(item => (
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
