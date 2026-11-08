/**
 * Settings › Connections › GitHub: Nocheh's own GitHub App and the repository copies that
 * background jobs approved in the private chat may read in their sealed box (ADR-0209, ADR-0210).
 * Connect GitHub sends the owner to GitHub, which creates the app and then asks which repositories
 * it may read, and brings them back here. The app's key never comes back and never reaches a box.
 * Every control acts at once. Copy has its own busy state, and Remove and Disconnect never wait
 * for a copy.
 */
import {useEffect, useRef, useState} from 'react';
import {Copy, ExternalLink, RefreshCw, Trash2, Unplug} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {copyingRow, offersDisconnect} from '../../lib/github';
import {refreshResources, useResource} from '../../lib/resource';
import {ago, dateTime} from '../../lib/system-format';
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
import {errorWords} from '../memory/shared';

type Listed = {name: string; branch: string; private: boolean; size_kb: number};
type Copied = {
  repo: string;
  branch: string;
  commit: string;
  digest: string;
  bytes: number;
  need: number;
  files: number;
  previous_digest: string | null;
  copied_at: string;
  missing: boolean;
};
type GithubApp = {name: string; account: string; install_url: string; settings_url: string};
type GithubStatus = {
  connected: boolean;
  app: GithubApp | null;
  connected_at: number | null;
  reconnect: boolean;
  listed: Listed[];
  listed_at: number | null;
  copies: Copied[] | null;
};

const failures: Record<string, string> = {
  github_app_refused: 'GitHub refused Nocheh’s app. It may have been deleted on GitHub. Connect GitHub again.',
  github_sign_in_expired: 'That GitHub sign-in took too long or was started elsewhere. Press Connect GitHub again.',
  invalid_github_sign_in: 'GitHub sent you back without what Nocheh needs. Press Connect GitHub again.',
  github_app_not_created: 'GitHub did not hand over the new app. Press Connect GitHub again.',
  invalid_github_redirect:
    'Open the dashboard on this computer (localhost) or at its https address, then connect GitHub.',
  invalid_github_organization: 'That is not a GitHub organization name.',
  github_rebuild_needed: 'Nocheh needs a rebuild of its images before it can use a GitHub app.',
  github_unavailable: 'Nocheh could not reach GitHub or its own store. Try again in a minute.',
  invalid_github_repo: 'Write it as owner/name.',
  github_repo_not_readable:
    'Nocheh’s GitHub app cannot read this repository. Add it with Choose repositories, or check the name.',
  github_repo_too_large:
    'This repository is too big for a job’s box. Its packed history and its files must fit in 256 MB, with at most 64 MB packed, 50,000 files, and about 64,000 files and folders together.',
  github_repo_limit: 'Nocheh keeps at most 10 copies. Remove one first.',
  github_copy_refused:
    'GitHub sent something Nocheh does not accept, or the history fails git’s strict check. Nothing was kept.',
  github_copy_cancelled:
    'This copy was removed, or its branch moved, while it was being made. Nothing was kept; copy it again.',
  github_not_connected: 'Connect GitHub first.',
  github_network_conflict: 'A Docker network named nocheh-repo-fetch exists that Nocheh did not make.',
  github_copy_unavailable: 'The sealed box image is missing; run ./bin/nocheh up.',
  github_connection_path_denied: 'The GitHub sign-in file is a link; Nocheh refuses it.',
  job_busy: 'GitHub is busy with another copy. Try again in a few minutes.',
  wait_for_active_jobs: 'Nocheh is backing up or restarting. Try again when it is done.',
};
const failureWords = (e: unknown) => failures[(e as ApiError)?.message ?? ''] ?? errorWords(e);

const connectHelp =
  'Nocheh makes its own GitHub app. GitHub asks you to create it, then which repositories it may read, and brings you back here. The app can only read code, and its key stays with Nocheh.';
const reconnectHelp =
  'GitHub refused Nocheh’s app. It may have been deleted on GitHub, or this computer’s clock may be wrong. Nocheh tries it again every hour, and jobs keep the copies they have. Connect again to make a new app.';
const disconnectText =
  'Nocheh forgets its GitHub app and the app’s key, and deletes its copies on this computer. Cards still waiting for approval are withdrawn, jobs waiting to start are stopped, and running jobs lose their box within a minute. What jobs already read from a copy stays in their records, their history and backups; Disconnect does not erase it. Then delete the app on GitHub too.';
const removeText =
  'Cards still waiting for your approval are withdrawn and jobs waiting to start are stopped. Running jobs lose their box within a minute and go on without it. Copying it again later does not give it back to them. What jobs already read from it stays in their records, their history and backups; Remove does not erase it.';
const missingText =
  'Nocheh makes a new copy. Cards still waiting for the missing one are withdrawn, jobs waiting to start are stopped, and jobs that read it never get the new one.';

/** A time github.py wrote, in epoch seconds. */
const isoOf = (value: number | null) => (value === null ? null : new Date(value * 1000).toISOString());
const megabytes = (bytes: number) => Math.max(1, Math.ceil(bytes / 1e6)).toLocaleString('en-US');

/** GitHub's form: it creates the app from Nocheh's manifest, then returns to /connect/github. */
function postToGithub(action: string, manifest: string) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

/**
 * GitHub sends the browser back to `/?connect=github…`: with a code once it created the app, which
 * is traded for the app and leads on to GitHub's page for picking repositories; then with the
 * installation, after which the list is read again. The address is cleaned, except when Nocheh was
 * busy or did not answer: the code still works then, and reloading the page finishes the sign-in.
 */
function useGithubReturn(onDone: (message: string, failed?: boolean) => void) {
  const handled = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (handled.current || params.get('connect') !== 'github') return;
    handled.current = true;
    const clean = () => window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const code = params.get('code'),
      state = params.get('state'),
      setup = params.get('setup_action');
    if (code && state) {
      apiPost<{install_url: string}>('/connections/github/finish', {code, state}).then(
        ({install_url}) => {
          clean();
          window.location.assign(install_url);
        },
        e => {
          const error = e as ApiError;
          if (error?.message === 'wait_for_active_jobs' || error?.status === undefined) {
            onDone('Nocheh could not finish connecting GitHub yet. Reload this page in a minute to finish.', true);
            return;
          }
          clean();
          onDone(failureWords(e), true);
        },
      );
      return;
    }
    clean();
    if (setup === 'request') {
      onDone('GitHub asked the organization’s owners to approve Nocheh’s app. Refresh the list once they do.');
      return;
    }
    if (setup || params.get('installation_id')) {
      apiPost('/connections/github/list', {}).then(
        () => {
          onDone('GitHub is connected. Copy a repository below.');
          void refreshResources();
        },
        e => onDone(failureWords(e), true),
      );
      return;
    }
    onDone('GitHub sign-in did not finish. Press Connect GitHub again.', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function GithubConnection() {
  const status = useResource<GithubStatus>('/connections/github');
  const feedback = useFeedback();
  // A copy has its own busy state, so Remove and Disconnect stay usable while it runs.
  const [copying, setCopying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [organization, setOrganization] = useState('');
  // The app Disconnect forgot, so the card can point to where it is deleted on GitHub.
  const [forgotten, setForgotten] = useState<GithubApp | null>(null);
  useGithubReturn((message, failed) => (failed ? setProblem(message) : feedback.toast(message)));

  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setProblem(null);
    try {
      await work();
      return true;
    } catch (e) {
      setProblem(failureWords(e));
      return false;
    } finally {
      setBusy(current => (current === name ? null : current));
      await refreshResources().catch(() => {});
    }
  };
  const connect = () =>
    act('connect', async () => {
      const {action, manifest} = await apiPost<{action: string; manifest: string}>('/connections/github/start', {
        redirect: window.location.origin + '/connect/github',
        organization: organization.trim() || null,
      });
      postToGithub(action, manifest);
    });
  const copy = async (repo: string, missing = false) => {
    if (
      missing &&
      !(await feedback.confirm({title: 'Copy ' + repo + ' again?', body: missingText, confirm: 'Copy again'}))
    )
      return false;
    setCopying(repo);
    setProblem(null);
    try {
      const result = await apiPost<{state?: string}>('/connections/github/copy', {repo});
      feedback.toast(result?.state === 'current' ? repo + ' is already at its latest commit.' : repo + ' is copied.');
      return true;
    } catch (e) {
      setProblem(failureWords(e));
      return false;
    } finally {
      setCopying(null);
      await refreshResources().catch(() => {});
    }
  };
  const remove = async (repo: string) => {
    if (
      !(await feedback.confirm({
        title: 'Remove the copy of ' + repo + '?',
        body: removeText,
        confirm: 'Remove',
        danger: true,
      }))
    )
      return;
    await act('remove:' + repo, async () => {
      await apiPost('/connections/github/remove', {repo});
      feedback.toast('The copy of ' + repo + ' is removed.');
    });
  };
  const disconnect = async () => {
    if (
      !(await feedback.confirm({
        title: 'Disconnect GitHub?',
        body: disconnectText,
        confirm: 'Disconnect',
        danger: true,
      }))
    )
      return;
    // Kept first: Disconnect may forget the app and still fail afterwards. The notice shows only once the app is gone.
    setForgotten(status.data?.app ?? null);
    await act('disconnect', async () => {
      await apiPost('/connections/github/disconnect', {});
      feedback.toast('GitHub disconnected.');
    });
  };
  const refreshList = () =>
    act('list', async () => {
      await apiPost('/connections/github/list', {});
    });

  if (status.error && !status.data)
    return <LoadError what="the GitHub connection" onRetry={() => void refreshResources()} />;
  if (!status.data)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  const data = status.data;
  const copies = data.copies ?? [];
  const named = new Map<string, {name: string; listed?: Listed; copy?: Copied}>();
  for (const listed of data.listed) named.set(listed.name.toLowerCase(), {name: listed.name, listed});
  for (const copy of copies) {
    const key = copy.repo.toLowerCase();
    named.set(key, {...(named.get(key) ?? {name: copy.repo}), copy});
  }
  const rows = [...named.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  // A Copy of a name with no row yet shows its progress by the field it was typed in.
  const copyingName = copyingRow(
    copying,
    rows.map(row => row.name),
  );
  const copyingElsewhere = copying !== null && copyingName === null;
  const connectedAt = isoOf(data.connected_at);

  return (
    <Card aria-labelledby="github-title">
      <CardHeader
        id="github-title"
        title="GitHub"
        description="Let background jobs you approve in your private chat read a copy of a repository and its history. The copy goes into the job’s sealed box; no GitHub key ever does."
        action={
          data.reconnect ? (
            <Badge tone="warn" dot>
              Connect again
            </Badge>
          ) : data.connected ? (
            <Badge tone="good" dot>
              Connected
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
        {forgotten && !data.app && (
          <div className="px-5 pt-4">
            <Notice tone="warn">
              Delete {forgotten.name} on GitHub too. Without its key it can do nothing, but it still has the
              repositories you gave it.{' '}
              <a className="underline" href={forgotten.settings_url} target="_blank" rel="noreferrer">
                Open it on GitHub
              </a>
            </Notice>
          </div>
        )}
        <SettingRow
          title="GitHub app"
          stack={!data.connected}
          description={
            data.connected && data.app
              ? 'Nocheh reads through its app ' +
                data.app.name +
                ' on ' +
                data.app.account +
                (connectedAt ? ', made ' + dateTime(connectedAt) : '') +
                '. Choose which repositories it may read on GitHub.'
              : data.reconnect
                ? reconnectHelp
                : connectHelp
          }
        >
          {data.connected && data.app ? (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button variant="secondary" asChild>
                <a href={data.app.install_url}>
                  <ExternalLink aria-hidden /> Choose repositories
                </a>
              </Button>
              <Button variant="ghost" busy={busy === 'disconnect'} onClick={() => void disconnect()}>
                <Unplug aria-hidden /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <Button busy={busy === 'connect'} disabled={!!busy} onClick={() => void connect()}>
                  <ExternalLink aria-hidden /> Connect GitHub
                </Button>
                {data.reconnect && data.app && (
                  <Button variant="ghost" asChild>
                    <a href={data.app.settings_url} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden /> Open {data.app.name} on GitHub
                    </a>
                  </Button>
                )}
                {offersDisconnect(data) && (
                  <Button variant="ghost" busy={busy === 'disconnect'} onClick={() => void disconnect()}>
                    <Unplug aria-hidden /> Disconnect
                  </Button>
                )}
              </div>
              <Details summary="Repositories in an organization you run">
                <label className="grid gap-1 text-[13px] text-muted">
                  GitHub makes the app for this organization instead of your own account. Leave it empty for your own
                  repositories.
                  <Input
                    aria-label="GitHub organization"
                    placeholder="organization-name"
                    autoComplete="off"
                    value={organization}
                    maxLength={39}
                    onChange={event => setOrganization(event.target.value)}
                  />
                </label>
              </Details>
            </div>
          )}
        </SettingRow>
        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-medium">Repositories</h3>
          {data.copies === null && (
            <Notice tone="warn" className="mt-3">
              Nocheh could not read its copies right now. Try again in a minute.
            </Notice>
          )}
          {!rows.length ? (
            <p className="mt-2 text-[13px] text-muted">
              {data.connected
                ? 'The app reads no repository yet. Choose repositories on GitHub, then refresh the list.'
                : 'Connect GitHub to list the repositories its app reads.'}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line" aria-label="Repositories">
              {rows.map(row => {
                const saved = row.copy;
                return (
                  <li key={row.name} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {row.name}
                        {row.listed && (
                          <span className="ml-2 text-xs font-normal text-muted">
                            {row.listed.private ? 'Private' : 'Public'}
                          </span>
                        )}
                      </p>
                      <p className="text-[13px] text-muted">
                        {copyingName === row.name
                          ? 'Copying… this can take a few minutes'
                          : !saved
                            ? 'Not copied'
                            : saved.missing
                              ? 'The copy is missing on this computer'
                              : `${saved.branch} at ${saved.commit.slice(0, 7)}, copied ${ago(saved.copied_at)}, ${megabytes(saved.bytes)} MB, ${saved.files.toLocaleString('en-US')} files`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {data.connected && (
                        <Button
                          size="sm"
                          variant="secondary"
                          busy={copyingName === row.name}
                          disabled={!!copying}
                          onClick={() => void copy(row.name, !!saved?.missing)}
                        >
                          <Copy aria-hidden /> {saved ? 'Copy again' : 'Copy'}
                        </Button>
                      )}
                      {saved && (
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={busy === 'remove:' + row.name}
                          onClick={() => void remove(row.name)}
                        >
                          <Trash2 aria-hidden /> Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {data.connected && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
              <Button variant="ghost" busy={busy === 'list'} onClick={() => void refreshList()}>
                <RefreshCw aria-hidden /> Refresh list
              </Button>
              <form
                className="flex min-w-0 flex-1 basis-64 flex-wrap justify-end gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  void copy(other.trim()).then(copied => copied && setOther(''));
                }}
              >
                <Input
                  aria-label="Repository to copy"
                  placeholder="owner/name"
                  autoComplete="off"
                  value={other}
                  maxLength={140}
                  className="min-w-0 flex-1 basis-48"
                  onChange={event => setOther(event.target.value)}
                />
                <Button type="submit" variant="secondary" busy={copyingElsewhere} disabled={!other.trim() || !!copying}>
                  Copy
                </Button>
              </form>
              {copyingElsewhere && (
                <p className="basis-full text-right text-[13px] text-muted">Copying… this can take a few minutes</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
