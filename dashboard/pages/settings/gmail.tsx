/**
 * Connections › Yours › Your Gmail (ADR-0272): the owner's own Gmail, read only, used only in the owner's private chat.
 * Reading mail is a Google "restricted" permission, so the owner makes a Google Cloud project in Personal mode, which
 * needs no review and keeps its sign-in, and pastes its OAuth client here. Connect Gmail then signs in through Google,
 * which sends the browser back to `/?connect=gmail`. The secret and the tokens never come back. Every control acts at once.
 */
import {useEffect, useRef, useState} from 'react';
import {ExternalLink, KeyRound, Unplug} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
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
  SettingRow,
} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {errorWords, when} from '../memory/shared';

type GmailStatus = {
  client: string | null;
  connected: boolean;
  email: string | null;
  connected_at: number | null;
  reconnect: boolean;
};

const personalPage = 'https://console.cloud.google.com/auth/overview/personal';
const gmailApi = 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';
const failures: Record<string, string> = {
  invalid_gmail_client: 'That doesn’t look like a Google client ID and secret. Copy both again from Google.',
  gmail_client_missing: 'Save your Google keys first.',
  gmail_sign_in_expired: 'That Gmail sign-in took too long or was started elsewhere. Press Connect Gmail again.',
  gmail_sign_in_refused:
    'Google did not accept the sign-in. Check the keys and the redirect address in Google, then press Connect Gmail again.',
  gmail_scope_missing: 'Reading your email was unticked on Google’s page. Press Connect Gmail and leave it ticked.',
  gmail_api_off: 'The Gmail API is off in your Google project. Turn it on, then press Connect Gmail again.',
  gmail_reconnect_needed: 'Google ended the sign-in. Press Connect Gmail again.',
  invalid_gmail_redirect:
    'Open the dashboard on this computer (localhost) or at its https address, then connect Gmail.',
  gmail_unavailable: 'Google could not be reached. Try again in a minute.',
};
const failureWords = (e: unknown) => failures[(e as ApiError)?.message ?? ''] ?? errorWords(e);
const returnAddress = () => window.location.origin + '/?connect=gmail';

/** Google sends the browser back to `/?connect=gmail&code=…&state=…`; finish the sign-in and clean the address. */
function useGmailReturn(onDone: (message: string, failed?: boolean) => void) {
  const handled = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (handled.current || params.get('connect') !== 'gmail') return;
    handled.current = true;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const code = params.get('code'),
      state = params.get('state');
    if (!code || !state) {
      onDone(
        params.get('error') === 'access_denied' ? 'Gmail sign-in was cancelled.' : 'Gmail sign-in did not finish.',
        true,
      );
      return;
    }
    apiPost('/connections/gmail/finish', {code, state}).then(
      () => {
        onDone('Gmail is connected. Ask Nocheh about your mail in your private chat.');
        void refreshResources();
      },
      e => onDone(failureWords(e), true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function GmailConnection() {
  const status = useResource<GmailStatus>('/connections/gmail');
  const feedback = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  useGmailReturn((message, failed) => (failed ? setProblem(message) : feedback.toast(message)));

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(failureWords(e));
    } finally {
      setBusy(null);
      await refreshResources().catch(() => {});
    }
  };
  const saveKeys = () =>
    run('keys', async () => {
      await apiPost('/connections/gmail/client', {client_id: clientId, client_secret: secret});
      setClientId('');
      setSecret('');
      setEditing(false);
      feedback.toast('Google keys saved. Press Connect Gmail.');
    });
  const connect = () =>
    run('connect', async () => {
      const {url} = await apiPost<{url: string}>('/connections/gmail/start', {redirect: returnAddress()});
      window.location.assign(url);
    });
  const disconnect = async () => {
    const ok = await feedback.confirm({
      title: 'Disconnect Gmail?',
      body: 'Nocheh forgets this Gmail sign-in and asks Google to end it. Your mail stays as it is, and your Google keys stay saved.',
      confirm: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    await run('disconnect', async () => {
      await apiPost('/connections/gmail/disconnect', {});
      feedback.toast('Gmail disconnected.');
    });
  };

  if (status.error && !status.data) return <LoadError what="Gmail" onRetry={() => void refreshResources()} />;
  if (!status.data)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  const data = status.data;
  const showForm = !data.client || editing;
  return (
    <Card aria-labelledby="gmail-title">
      <CardHeader
        id="gmail-title"
        title="Your Gmail"
        description="Your own Gmail, read only, used only in your private chat. Nocheh can search your mail and read a message or a whole conversation when you ask. Groups and members never reach it, and nothing is copied into memory."
        action={
          data.connected ? (
            <Badge tone="good" dot>
              Connected{data.email ? ' to ' + data.email : ''}
            </Badge>
          ) : data.reconnect ? (
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
          title="Google keys"
          stack={showForm}
          description={
            data.client
              ? 'Saved for the client ' + data.client.split('-')[0] + '…. New keys sign you out of Gmail here.'
              : 'Google lets only you sign in to a project you make in Personal mode, with no review and no sign-in that runs out.'
          }
        >
          {showForm ? (
            <div className="grid gap-3">
              <Details summary="How to make your Google keys">
                <ol className="grid list-decimal gap-1.5 pl-5 text-[13px] text-muted">
                  <li>
                    Signed in to Google with the Gmail you want Nocheh to read, open{' '}
                    <a className="underline" href={personalPage} target="_blank" rel="noreferrer">
                      Google’s Personal mode page
                    </a>
                    .
                  </li>
                  <li>Keep the project it offers, and pick Web application as the application type.</li>
                  <li>
                    Under Authorized redirect URIs, add <code className="break-all text-fg">{returnAddress()}</code>
                  </li>
                  <li>
                    Press Continue, then copy the Client ID and Client secret below. Google shows the secret only once.
                  </li>
                  <li>
                    Turn on the{' '}
                    <a className="underline" href={gmailApi} target="_blank" rel="noreferrer">
                      Gmail API
                    </a>{' '}
                    for that project.
                  </li>
                </ol>
              </Details>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  void saveKeys();
                }}
              >
                <Input
                  aria-label="Client ID"
                  autoComplete="off"
                  placeholder="Client ID (…apps.googleusercontent.com)"
                  value={clientId}
                  maxLength={200}
                  className="min-w-0 flex-1 basis-64"
                  onChange={event => setClientId(event.target.value)}
                />
                <Input
                  type="password"
                  aria-label="Client secret"
                  autoComplete="off"
                  placeholder="Client secret"
                  value={secret}
                  maxLength={256}
                  className="min-w-0 flex-1 basis-48"
                  onChange={event => setSecret(event.target.value)}
                />
                <Button type="submit" busy={busy === 'keys'} disabled={!clientId.trim() || !secret.trim() || !!busy}>
                  <KeyRound aria-hidden /> Save keys
                </Button>
                {editing && (
                  <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
              </form>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <KeyRound aria-hidden /> Change keys
            </Button>
          )}
        </SettingRow>
        <SettingRow
          title="Gmail sign-in"
          description={
            data.connected
              ? 'Signed in' +
                (data.email ? ' as ' + data.email : '') +
                (data.connected_at ? ', ' + when(new Date(data.connected_at * 1000).toISOString()) : '') +
                '. Nocheh only reads.'
              : data.reconnect
                ? 'Google ended the sign-in. Connect again to keep using it.'
                : 'Google opens in this tab. Choose your account and allow reading your email.'
          }
        >
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              variant={data.connected ? 'secondary' : 'primary'}
              busy={busy === 'connect'}
              disabled={!data.client || !!busy}
              onClick={() => void connect()}
            >
              <ExternalLink aria-hidden /> {data.connected ? 'Connect again' : 'Connect Gmail'}
            </Button>
            {(data.connected || data.reconnect) && (
              <Button variant="ghost" busy={busy === 'disconnect'} disabled={!!busy} onClick={() => void disconnect()}>
                <Unplug aria-hidden /> Disconnect
              </Button>
            )}
          </div>
        </SettingRow>
      </div>
    </Card>
  );
}
