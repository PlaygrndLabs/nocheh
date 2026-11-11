/**
 * System › Machine log: every command background jobs ran on the owner's machines, newest first,
 * as the assistant asked for it, with its exit code and fingerprints of what ran and of what it
 * printed. Nocheh keeps no output. Internal commands (the shell's own setup) show only on request.
 */
import {useState, type ReactNode} from 'react';
import {ScrollText} from 'lucide-react';
import {
  commandAdvice,
  commandKinds,
  commandQuery,
  commandState,
  exitBadge,
  machineErrorWords,
  type MachineCommand,
  type Machines,
} from '../../lib/machines';
import {useParam} from '../../lib/navigation';
import {useResource} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import {ago, bytes, count, dateTime, duration} from '../../lib/system-format';
import {
  Badge,
  Card,
  CardHeader,
  Empty,
  Field,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Select,
  Table,
  Td,
  Technical,
  Th,
} from '../../ui/core';
import {Drawer} from '../../ui/overlay';
import {Exact} from '../inbox/review-drawer';
import type {Job} from './jobs';

type Page = {commands: MachineCommand[]; next: number | null};

export function MachineLogView() {
  const machine = useParam('machine') ?? '';
  const job = useParam('job') ?? '';
  const all = useParam('all') === '1';
  const machines = useResource<Machines>('/machines', 60000);
  const jobs = useResource<{jobs: Job[]}>('/background-jobs', 60000);
  // Filters list today's machines and machine jobs; a removed machine or an erased job keeps its name in the log.
  const machineNames = new Map((machines.data?.machines ?? []).map(row => [row.id, row.name]));
  const jobTitles = new Map(
    (jobs.data?.jobs ?? []).filter(row => row.machine).map(row => [row.id, row.title ?? 'Job ' + row.id.slice(0, 8)]),
  );
  if (machine && !machineNames.has(machine)) machineNames.set(machine, 'Machine ' + machine.slice(0, 8));
  if (job && !jobTitles.has(job)) jobTitles.set(job, 'Job ' + job.slice(0, 8));
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Machine" htmlFor="log-machine" className="w-full sm:w-56">
          <Select
            id="log-machine"
            value={machine}
            onChange={e => setParams({machine: e.target.value, command: null}, true)}
          >
            <option value="">All machines</option>
            {[...machineNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Job" htmlFor="log-job" className="w-full sm:w-72">
          <Select id="log-job" value={job} onChange={e => setParams({job: e.target.value, command: null}, true)}>
            <option value="">All jobs</option>
            {[...jobTitles].map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex h-9 items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={all}
            onChange={e => setParams({all: e.target.checked ? '1' : null, command: null}, true)}
          />
          All commands, also internal ones
        </label>
      </div>
      <Log key={machine + ':' + job + ':' + all} machine={machine} job={job} all={all} />
    </>
  );
}

function Log({machine, job, all}: {machine: string; job: string; all: boolean}) {
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const {data, error} = useResource<Page>(commandQuery({machine, job, all, before: pages.at(-1)}), 10000);
  const rows = data?.commands ?? [];
  const filtered = !!(machine || job);
  return (
    <Card>
      <CardHeader
        title="Machine log"
        description="Every command a job ran on your machines, newest first, as the assistant asked for it. Nocheh keeps fingerprints of what ran and of what it printed, not the output."
      />
      <div className="mt-3">
        {error && (
          <div className="px-5 pb-3">
            <LoadError what="the machine log" />
          </div>
        )}
        {!data && !error ? (
          <LoadingRows rows={5} />
        ) : data && !rows.length ? (
          <Empty icon={ScrollText} title={filtered ? 'No commands match' : 'No commands yet'}>
            {filtered
              ? 'Try another machine or job.'
              : 'Commands appear here when a job you approved works on one of your machines.'}
          </Empty>
        ) : rows.length ? (
          <>
            <Table aria-label="Machine commands">
              <thead>
                <tr>
                  <Th scope="col">Time</Th>
                  <Th scope="col" className="hidden md:table-cell">
                    Machine
                  </Th>
                  <Th scope="col" className="hidden lg:table-cell">
                    Job
                  </Th>
                  <Th scope="col" className="hidden sm:table-cell">
                    Kind
                  </Th>
                  <Th scope="col">Command</Th>
                  <Th scope="col">Exit</Th>
                  <Th scope="col" className="hidden sm:table-cell">
                    State
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const [state, tone] = commandState(row.state);
                  const exit = exitBadge(row.exit_code);
                  return (
                    <tr
                      key={row.id}
                      className="cursor-pointer hover:bg-subtle/60 [&>td]:align-middle"
                      onClick={() => setParams({command: String(row.id)})}
                    >
                      <Td className="whitespace-nowrap text-muted">
                        <time dateTime={row.started_at} title={dateTime(row.started_at)}>
                          {ago(row.started_at)}
                        </time>
                      </Td>
                      <Td className="hidden max-w-40 truncate md:table-cell">{row.machine_name}</Td>
                      <Td className="hidden max-w-56 truncate text-muted lg:table-cell" dir="auto">
                        {row.job_title ?? (row.job_id ? 'Job ' + row.job_id.slice(0, 8) : '—')}
                      </Td>
                      <Td className="hidden text-muted sm:table-cell">{commandKinds[row.kind] ?? row.kind}</Td>
                      <Td className="w-full max-w-0 min-w-40">
                        <button
                          type="button"
                          className="block w-full truncate text-left font-mono text-[13px] leading-5 hover:underline"
                          title={row.command}
                          onClick={event => {
                            event.stopPropagation();
                            setParams({command: String(row.id)});
                          }}
                        >
                          {row.command}
                        </button>
                        <p className="text-xs text-muted md:hidden">{row.machine_name}</p>
                      </Td>
                      <Td className="tabular">
                        {exit ? <Badge tone={exit.tone}>{exit.label}</Badge> : <span className="text-muted">—</span>}
                      </Td>
                      <Td className="hidden whitespace-nowrap sm:table-cell">
                        <Badge tone={tone}>{state}</Badge>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              page={pages.length - 1}
              hasNext={data?.next != null}
              onPage={page =>
                setPages(current => (page > current.length - 1 ? [...current, data!.next] : current.slice(0, page + 1)))
              }
              summary={`Page ${pages.length} · updates every 10 seconds`}
            />
          </>
        ) : null}
      </div>
      <CommandDrawer rows={rows} loaded={!!data} />
    </Card>
  );
}

/** One command with all it has: shown from the page it is on. */
function CommandDrawer({rows, loaded}: {rows: MachineCommand[]; loaded: boolean}) {
  const id = useParam('command');
  const row = rows.find(item => String(item.id) === id) ?? null;
  const exit = row ? exitBadge(row.exit_code) : null;
  const [state, tone] = commandState(row?.state ?? '');
  // Its output is counted when it ends: a running command has printed something not known yet.
  const running = row?.state === 'running';
  const took =
    row?.finished_at != null
      ? duration(new Date(row.finished_at).getTime() - new Date(row.started_at).getTime())
      : null;
  const facts: [string, ReactNode][] = row
    ? [
        ['Machine', row.machine_name],
        [
          'Job',
          row.job_id ? (
            <a className="text-accent-text hover:underline" href={href('system', {view: 'machines', job: row.job_id})}>
              {row.job_title ?? 'Job ' + row.job_id.slice(0, 8)}
            </a>
          ) : (
            'No job'
          ),
        ],
        ['Kind', commandKinds[row.kind] ?? row.kind],
        ['Exit code', exit ? exit.label : '—'],
        ['Started', dateTime(row.started_at)],
        ['Finished', row.finished_at ? dateTime(row.finished_at) : 'Not yet'],
        ['Took', took ?? '—'],
        ['Printed', running ? 'Not known yet' : row.output_bytes ? bytes(row.output_bytes) : 'Nothing'],
      ]
    : [];
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && setParams({command: null})}
      title={row ? `${commandKinds[row.kind] ?? 'Command'} on ${row.machine_name}` : 'Command'}
      description={row ? `Started ${ago(row.started_at)}` : undefined}
    >
      {!row && !loaded ? (
        <LoadingRows rows={4} />
      ) : !row ? (
        <Notice tone="warn" title="This command isn’t on this page">
          Close this panel and find it in the log, or the link may be incomplete.
        </Notice>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone} dot>
              {state}
            </Badge>
            {row.error_code && <span className="text-[13px] text-muted">{machineErrorWords(row.error_code)}</span>}
          </div>
          {commandAdvice(row.error_code) && <p className="text-[13px] text-warn">{commandAdvice(row.error_code)}</p>}
          <Exact
            label={
              row.kind === 'test' || row.kind === 'cleanup'
                ? 'What Nocheh ran'
                : 'Command, as the assistant asked for it'
            }
            mono
          >
            {row.command}
          </Exact>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-0.5 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {row.script_sha256 && (
            <div>
              <p className="mb-1 text-xs text-muted">Fingerprint of what ran (SHA-256)</p>
              <p className="font-mono text-[13px] break-all">{row.script_sha256}</p>
            </div>
          )}
          <div>
            <p className="mb-1 text-xs text-muted">Fingerprint of what it printed (SHA-256)</p>
            {running ? (
              <p className="text-[13px]">Not known yet</p>
            ) : (
              <p className="font-mono text-[13px] break-all">{row.output_sha256 ?? '—'}</p>
            )}
          </div>
          <p className="text-xs text-muted">
            Log entry {count(row.id)}.{' '}
            {row.script_sha256
              ? 'What ran is the whole script the machine got: the command with the assistant’s own setup around it. '
              : ''}
            Nocheh doesn’t keep the output itself; its fingerprint shows whether a copy of it is the same.
          </p>
          <Technical value={row} />
        </div>
      )}
    </Drawer>
  );
}
