/**
 * Advanced: every generated reading of a message's files (transcripts,
 * extracted text), which one is in use, and making a new one with another
 * engine. Each reading has its own copy the assistant reads.
 */
import {useEffect, useState} from 'react';
import {useResource, refreshResources} from '../../lib/resource';
import {decode, fullTime} from '../../lib/messages-format';
import {sourceContentLabel} from '../../../src/source-content';
import {Badge, Button, Field, LoadError, Notice, Segmented, Select, Skeleton, Technical} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {GuardEditor} from './agent-copy';
import {useCommand} from './use-command';

type Version = {
  id: string;
  artifact_id: string | null;
  kind: string;
  created_at: string;
  producer: string;
  producer_version: string;
  guard_revision: number | null;
  selection_revision: number | null;
  active: boolean;
  provenance: unknown;
};
const READINGS = ['transcript', 'extracted_text', 'extraction_status'];
const kindName = (kind: string) =>
  ({transcript: 'Transcript', extracted_text: 'Extracted text', extraction_status: 'Reading status'})[kind] ??
  kind.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());

export function GeneratedVersions({id}: {id: string}) {
  const [view, setView] = useState<'readings' | 'all'>('readings');
  const [cursors, setCursors] = useState<string[]>(['']);
  const [open, setOpen] = useState('');
  const versions = useResource<{versions: Version[]; next: string | null}>(
    `/sources/${id}/derivatives?view=${view}&after=${cursors.at(-1)}`,
  );
  return (
    <div className="space-y-3">
      <Segmented
        label="Which versions"
        size="sm"
        value={view}
        onChange={value => {
          setView(value);
          setCursors(['']);
          setOpen('');
        }}
        options={[
          {value: 'readings', label: 'File readings'},
          {value: 'all', label: 'Everything generated'},
        ]}
      />
      {!versions.data && versions.error && (
        <LoadError what="generated versions" onRetry={() => void refreshResources()} />
      )}
      {!versions.data && !versions.error && <Skeleton className="h-12 w-full" />}
      {versions.data && !versions.data.versions.length && (
        <p className="text-[13px] text-muted">Nothing generated yet. Transcripts and file readings appear here.</p>
      )}
      {!!versions.data?.versions.length && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {versions.data.versions.map(version => (
            <li key={version.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium">{kindName(version.kind)}</span>
                {version.active ? (
                  <Badge tone="good">In use</Badge>
                ) : !version.guard_revision ? (
                  <Badge tone="info">Being prepared</Badge>
                ) : null}
                <span className="text-muted">{fullTime(version.created_at)}</span>
                <Button
                  variant="link"
                  size="sm"
                  className="ml-auto"
                  aria-expanded={open === version.id}
                  onClick={() => setOpen(open === version.id ? '' : version.id)}
                >
                  {open === version.id ? 'Close' : 'Open'}
                </Button>
              </div>
              {open === version.id && <VersionDetail version={version} />}
            </li>
          ))}
        </ul>
      )}
      {(cursors.length > 1 || versions.data?.next) && (
        <div className="flex gap-2">
          {cursors.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => setCursors(cursors.slice(0, -1))}>
              Previous
            </Button>
          )}
          {versions.data?.next && (
            <Button size="sm" variant="ghost" onClick={() => setCursors([...cursors, versions.data!.next!])}>
              More
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function VersionDetail({version}: {version: Version}) {
  const detail = useResource<any>('/derivatives/' + version.id);
  const command = useCommand();
  const feedback = useFeedback();
  const canUse = READINGS.includes(version.kind);
  async function activate() {
    const result = await command.run('activate', `/derivatives/${version.id}/activate`, {
      expected_revision: version.selection_revision,
    });
    if (result) feedback.toast(`This ${kindName(version.kind).toLowerCase()} is now in use.`);
  }
  if (!detail.data && detail.error) return <LoadError what="this version" onRetry={() => void refreshResources()} />;
  if (!detail.data) return <Skeleton className="mt-2 h-16 w-full" />;
  return (
    <div className="mt-3 space-y-3">
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Generated output</p>
        <pre
          dir="auto"
          className="max-h-48 overflow-auto rounded-md bg-subtle px-3 py-2 font-sans text-[13px] whitespace-pre-wrap break-words"
        >
          {decode(detail.data.content_base64) || 'Empty'}
        </pre>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Copy the assistant reads</p>
        <GuardEditor kind="derived_artifacts" id={version.id} emptyText="This version is still being prepared." />
      </div>
      {canUse && !version.active && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            busy={command.busy === 'activate'}
            disabled={!version.guard_revision}
            onClick={() => void activate()}
          >
            Use this version
          </Button>
          <span className="text-xs text-muted">Memory that depends on it is refreshed. Older versions stay here.</span>
        </div>
      )}
      {command.error && <Notice tone="bad">{command.error}</Notice>}
      <Technical
        summary="How it was made"
        value={{
          engine: detail.data.producer,
          version: detail.data.producer_version,
          source_revision: detail.data.source_revision,
          input_hash: detail.data.input_hash,
          configuration_hash: detail.data.configuration_hash,
          provenance: detail.data.provenance,
        }}
      />
    </div>
  );
}

/** Make a new reading of one original file with a chosen engine, then follow it until it finishes. */
export function Reprocess({id, files}: {id: string; files: any[]}) {
  const engines = useResource<{engines: {producer: string; producer_version: string; kind: string}[]}>(
    '/derivation-engines',
  );
  const command = useCommand();
  const feedback = useFeedback();
  const [file, setFile] = useState(files.length === 1 && files[0].file_hash ? files[0].id : '');
  const [engine, setEngine] = useState('');
  const [job, setJob] = useState('');
  const status = useResource<{state: string; error_code?: string}>(job ? '/reprocessing/' + job : null, job ? 3000 : 0);
  const finished = ['done', 'failed'].includes(status.data?.state ?? '');
  useEffect(() => {
    if (!job || !finished) return;
    void refreshResources();
    if (status.data?.state === 'done') feedback.toast('New version made. Open it above to check and use it.');
  }, [job, finished]);

  const original = files.find(item => item.id === file);
  const choice = engines.data?.engines.find(item => item.producer + '@' + item.producer_version === engine);
  async function submit() {
    if (!original || !choice) return;
    const result = await command.run<{id: string}>('reprocess', `/sources/${id}/reprocess`, {
      artifact_id: original.id,
      input_hash: original.file_hash,
      producer: choice.producer,
      producer_version: choice.producer_version,
      configuration: {},
    });
    if (result) setJob(result.id);
  }
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Original file" htmlFor={`reprocess-file-${id}`}>
          <Select id={`reprocess-file-${id}`} value={file} onChange={event => setFile(event.target.value)}>
            <option value="">Choose a file</option>
            {files.map(item => (
              <option key={item.id} value={item.id} disabled={!item.file_hash}>
                {item.metadata?.file_name || sourceContentLabel(item.kind)}
                {!item.file_hash ? ' (not downloaded yet)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Engine"
          htmlFor={`reprocess-engine-${id}`}
          error={engines.error ? 'Engines couldn’t be loaded.' : undefined}
        >
          <Select id={`reprocess-engine-${id}`} value={engine} onChange={event => setEngine(event.target.value)}>
            <option value="">Choose an engine</option>
            {(engines.data?.engines ?? []).map(item => (
              <option
                key={item.producer + '@' + item.producer_version}
                value={item.producer + '@' + item.producer_version}
              >
                {kindName(item.kind)} · {item.producer} {item.producer_version}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" busy={command.busy === 'reprocess'} disabled={!original?.file_hash || !choice}>
          Make a new version
        </Button>
        {job && (
          <span role="status" className="text-[13px] text-muted">
            {status.data?.state === 'done'
              ? 'Done.'
              : status.data?.state === 'failed'
                ? `Failed${status.data.error_code ? ': ' + status.data.error_code.replaceAll('_', ' ') : ''}.`
                : 'Working…'}
          </span>
        )}
      </div>
      {command.error && <Notice tone="bad">{command.error}</Notice>}
    </form>
  );
}
