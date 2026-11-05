/**
 * Settings › Connections › GitHub: the owner's fine-grained key and the repository copies
 * that background jobs approved in the private chat may read in their sealed box (ADR-0209).
 * Every control acts at once. The key is pasted once and never comes back; it never reaches
 * a box. Copy has its own busy state, and Remove and Disconnect never wait for a copy.
 */
import {useState} from 'react';
import {Copy, ExternalLink, RefreshCw, Trash2, Unplug} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {offersDisconnect} from '../../lib/github';
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
type GithubStatus = {
  connected: boolean;
  login: string | null;
  connected_at: string | number | null;
  expires_at: string | null;
  reconnect: boolean;
  listed: Listed[];
  listed_at: number | null;
  copies: Copied[] | null;
};

const failures: Record<string, string> = {
  invalid_github_token: 'Paste a fine-grained token; it starts with github_pat_.',
  github_token_refused: 'GitHub refused the key. Make a new one and paste it.',
  github_unavailable: 'Nocheh could not reach GitHub or its own store. Try again in a minute.',
  invalid_github_repo: 'Write it as owner/name.',
  github_repo_not_readable: 'The key cannot read this repository. Give it Contents: Read-only, or check the name.',
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

const keyHelp =
  'Make a fine-grained token in GitHub. Under Repository access, pick Only select repositories and choose the ones jobs may read. Under Permissions, set Contents to Read-only and leave the rest at No access. Nocheh only reads, but it cannot check what else a key allows, so give it nothing more. Paste it here. Nocheh checks it once and never shows it again.';
const disconnectText =
  'Nocheh forgets the key and deletes its copies on this computer. Cards still waiting for approval are withdrawn, jobs waiting to start are stopped, and running jobs lose their box within a minute. What jobs already read from a copy stays in their records, their history and backups; Disconnect does not erase it. Delete the key in GitHub too.';
const removeText =
  'Cards still waiting for your approval are withdrawn and jobs waiting to start are stopped. Running jobs lose their box within a minute and go on without it. Copying it again later does not give it back to them. What jobs already read from it stays in their records, their history and backups; Remove does not erase it.';
const missingText =
  'Nocheh makes a new copy. Cards still waiting for the missing one are withdrawn, jobs waiting to start are stopped, and jobs that read it never get the new one.';

/** A time github.py wrote: ISO text, or epoch seconds. */
const isoOf = (value: string | number | null) =>
  value === null ? null : typeof value === 'number' ? new Date(value * 1000).toISOString() : value;
const daysLeft = (expires: string | null) =>
  expires ? Math.ceil((new Date(expires).getTime() - Date.now()) / 86400000) : null;
const megabytes = (bytes: number) => Math.max(1, Math.ceil(bytes / 1e6)).toLocaleString('en-US');

/** The key field: Save posts it once, and the field is cleared after Nocheh took it. */
function KeyForm({busy, onSave}: {busy: boolean; onSave: (token: string) => Promise<boolean>}) {
  const [token, setToken] = useState('');
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={event => {
        event.preventDefault();
        void onSave(token).then(saved => saved && setToken(''));
      }}
    >
      <Input
        type="password"
        aria-label="GitHub key"
        autoComplete="off"
        placeholder="github_pat_…"
        value={token}
        maxLength={300}
        className="min-w-0 flex-1 basis-64"
        onChange={event => setToken(event.target.value)}
      />
      <Button type="submit" busy={busy} disabled={!token.trim() || busy}>
        Save
      </Button>
    </form>
  );
}

export function GithubConnection() {
  const status = useResource<GithubStatus>('/connections/github');
  const feedback = useFeedback();
  // A copy has its own busy state, so Remove and Disconnect stay usable while it runs.
  const [copying, setCopying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [other, setOther] = useState('');

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
  const saveKey = (token: string) =>
    act('token', async () => {
      await apiPost('/connections/github/token', {token: token.trim()});
      feedback.toast('GitHub key saved.');
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
    await act('disconnect', async () => {
      await apiPost('/connections/github/disconnect', {});
      feedback.toast('GitHub disconnected. Delete the key in GitHub too.');
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
  const left = data.connected ? daysLeft(data.expires_at) : null;
  const copies = data.copies ?? [];
  const named = new Map<string, {name: string; listed?: Listed; copy?: Copied}>();
  for (const listed of data.listed) named.set(listed.name.toLowerCase(), {name: listed.name, listed});
  for (const copy of copies) {
    const key = copy.repo.toLowerCase();
    named.set(key, {...(named.get(key) ?? {name: copy.repo}), copy});
  }
  const rows = [...named.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const connectedAt = isoOf(data.connected_at);

  return (
    <Card aria-labelledby="github-title">
      <CardHeader
        id="github-title"
        title="GitHub"
        description="Let background jobs you approve in your private chat read a copy of a repository and its history. The copy goes into the job’s sealed box; your GitHub key never does."
        action={
          data.reconnect ? (
            <Badge tone="warn" dot>
              Connect again
            </Badge>
          ) : data.connected && left !== null && left <= 7 ? (
            <Badge tone="warn" dot>
              Expires in {left} {left === 1 ? 'day' : 'days'}
            </Badge>
          ) : data.connected ? (
            <Badge tone="good" dot>
              Connected as {data.login}
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
          title="GitHub key"
          stack={!data.connected}
          description={
            data.connected
              ? 'Connected as ' +
                data.login +
                (connectedAt ? ' on ' + dateTime(connectedAt) : '') +
                (data.expires_at ? ' · expires ' + dateTime(data.expires_at) : '')
              : keyHelp
          }
        >
          {data.connected ? (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button variant="ghost" busy={busy === 'disconnect'} onClick={() => void disconnect()}>
                <Unplug aria-hidden /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" asChild>
                  <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden /> Open GitHub
                  </a>
                </Button>
                {offersDisconnect(data) && (
                  <Button variant="ghost" busy={busy === 'disconnect'} onClick={() => void disconnect()}>
                    <Unplug aria-hidden /> Disconnect
                  </Button>
                )}
              </div>
              <KeyForm busy={busy === 'token'} onSave={saveKey} />
            </div>
          )}
        </SettingRow>
        {data.connected && (
          <div className="border-t border-line px-5 py-4">
            <Details summary="Replace key">
              <KeyForm busy={busy === 'token'} onSave={saveKey} />
            </Details>
          </div>
        )}
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
                ? 'The key reads no repository yet. Refresh the list, or copy one by its name below.'
                : 'Connect GitHub to list the repositories its key reads.'}
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
                        {copying === row.name
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
                          busy={copying === row.name}
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
                <Button type="submit" variant="secondary" disabled={!other.trim() || !!copying}>
                  Copy
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
