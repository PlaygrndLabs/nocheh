/** What Nocheh did, one sub-tab of one table each: decided actions and their results, memory organizing, and assistant runs. */
import {useState, type ReactNode} from 'react';
import {Bot, CalendarClock, FolderTree, History as HistoryIcon, MessageSquare} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {decisionLink, proposalState} from '../../lib/supervision';
import {useSubTab} from '../../lib/navigation';
import {Card, CardHeader, Dot, Empty, LoadError, LoadingRows, Pager, Table, Td, Th, type Tone} from '../../ui/core';
import {SubPanel, SubTabs} from '../../ui/page';
import {runName} from './drawers';
import {proposalTitle} from './knowledge-review';
import {
  actionIcon,
  actionName,
  actionPlace,
  actionStateLabel,
  actionSummary,
  byNewest,
  fromNow,
  fullTime,
  stateLabel,
  useChatNames,
  type ActionQueue,
  type Run,
} from './shared';

const PAGE = 10;
const subTabs = ['actions', 'organizing', 'runs'] as const;

export function History() {
  const queue = useResource<ActionQueue>('/tools/actions', 15000);
  const status = useResource<{archive?: {managed_runs?: Run[]}}>('/status', 15000);
  const chat = useChatNames();
  const [tab, setTab] = useSubTab(subTabs);
  const [actionPage, setActionPage] = useState(0);
  const [runPage, setRunPage] = useState(0);
  const actions = [...(queue.data?.actions ?? []), ...(queue.data?.telegram ?? [])]
    .filter(action => action.state !== 'proposed')
    .sort(byNewest);
  const runs = [...(status.data?.archive?.managed_runs ?? [])].sort(byNewest);

  return (
    <div className="space-y-5">
      <SubTabs
        label="History"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'actions', label: 'Actions'},
          {id: 'organizing', label: 'Memory organizing'},
          {id: 'runs', label: 'Assistant runs'},
        ]}
      />
      {tab === 'actions' && (
        <SubPanel id="actions" current={tab}>
          <Card>
            <CardHeader
              title="Actions"
              description="Messages and actions you decided on, and how they turned out."
              className="pb-3"
            />
            {queue.error && <LoadError className="mx-5 mb-3" what="actions" onRetry={() => void refreshResources()} />}
            {!queue.data ? (
              queue.error ? null : (
                <LoadingRows rows={3} />
              )
            ) : actions.length === 0 ? (
              <Empty icon={HistoryIcon} title="No decided actions yet">
                After you approve or deny something in Waiting, it shows here with its result.
              </Empty>
            ) : (
              <HistoryTable
                label="Actions"
                columns={['Action', 'What', 'Where', 'Result', 'When']}
                rows={actions.slice(actionPage * PAGE, (actionPage + 1) * PAGE).map(action => {
                  const [label, tone] = actionStateLabel(action);
                  const Icon = actionIcon(action.kind);
                  return {
                    id: action.id,
                    href: href('inbox', {view: 'history', action: action.id}),
                    icon: <Icon className="size-4" />,
                    title: actionName(action.kind),
                    summary: actionSummary(action),
                    place: (action.kind === 'telegram_message' ? 'To ' : 'In ') + chat(actionPlace(action)),
                    state: label,
                    tone,
                    time: action.created_at,
                  };
                })}
              />
            )}
            <Pager
              page={actionPage}
              hasNext={(actionPage + 1) * PAGE < actions.length}
              onPage={setActionPage}
              labels={['Newer', 'Older']}
            />
          </Card>
        </SubPanel>
      )}

      {tab === 'organizing' && (
        <SubPanel id="organizing" current={tab}>
          <Organizing />
        </SubPanel>
      )}

      {tab === 'runs' && (
        <SubPanel id="runs" current={tab}>
          <Card>
            <CardHeader
              title="Assistant runs"
              description="Scheduled jobs and other assistant runs, latest 50."
              className="pb-3"
              action={
                <a className="text-[13px] text-accent-text hover:underline" href="#schedules">
                  Manage schedules
                </a>
              }
            />
            {status.error && (
              <LoadError className="mx-5 mb-3" what="assistant runs" onRetry={() => void refreshResources()} />
            )}
            {!status.data ? (
              status.error ? null : (
                <LoadingRows rows={3} />
              )
            ) : runs.length === 0 ? (
              <Empty icon={Bot} title="No runs yet">
                Scheduled jobs and other runs of the assistant show here.
              </Empty>
            ) : (
              <HistoryTable
                label="Assistant runs"
                columns={['Run', 'Problem', 'Where', 'Result', 'When']}
                rows={runs.slice(runPage * PAGE, (runPage + 1) * PAGE).map(run => {
                  const [label, tone] = stateLabel(run.state);
                  const Icon = run.channel === 'scheduler' ? CalendarClock : MessageSquare;
                  return {
                    id: run.event_id,
                    href: href('inbox', {view: 'history', tab: 'runs', run: run.event_id}),
                    icon: <Icon className="size-4" />,
                    title: runName(run),
                    summary: run.error_code ? run.error_code.replaceAll('_', ' ') : '',
                    place: 'In ' + chat(run.scope),
                    state: label,
                    tone,
                    time: run.created_at,
                  };
                })}
              />
            )}
            <Pager
              page={runPage}
              hasNext={(runPage + 1) * PAGE < runs.length}
              onPage={setRunPage}
              labels={['Newer', 'Older']}
            />
          </Card>
        </SubPanel>
      )}
    </div>
  );
}

type HistoryRow = {
  id: string;
  href: string;
  icon: ReactNode;
  title: string;
  summary: string;
  /** The chat it happened in; left out for a table that has no place column. */
  place?: string;
  state: string;
  tone: Tone;
  time: string;
};

/** One kind of history as a table: what it was, a line about it, where, how it ended and when. Its name opens it. */
function HistoryTable({label, columns, rows}: {label: string; columns: string[]; rows: HistoryRow[]}) {
  const places = columns.includes('Where');
  return (
    <Table aria-label={label} className="border-t border-line max-sm:block [&>tbody]:max-sm:block">
      <thead className="max-sm:sr-only">
        <tr>
          {columns.map(column => (
            <Th key={column} scope="col" className={column === 'When' ? 'text-right' : undefined}>
              {column}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          // On a phone the name takes the first line and the rest wraps under it.
          <tr
            key={row.id}
            className="hover:bg-subtle max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0"
          >
            <Td className="whitespace-nowrap max-sm:w-full">
              <a href={row.href} className="flex items-center gap-2 font-medium hover:underline">
                <span aria-hidden className="text-muted">
                  {row.icon}
                </span>
                {row.title}
              </a>
            </Td>
            <Td className="max-w-0 text-[13px] text-muted sm:w-[40%] max-sm:w-full max-sm:max-w-none">
              <span dir="auto" className="block truncate" title={row.summary}>
                {row.summary}
              </span>
            </Td>
            {places && <Td className="text-[13px] text-muted">{row.place}</Td>}
            <Td className="text-[13px] whitespace-nowrap">
              <span className="flex items-center gap-2">
                <Dot tone={row.tone} />
                {row.state}
              </span>
            </Td>
            <Td className="text-right text-[13px] whitespace-nowrap text-muted" title={fullTime(row.time)}>
              {fromNow(row.time)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

type Proposal = {
  id: string;
  kind: string;
  state: string;
  created_at: string;
  proposal?: {kind?: string; reason?: string};
};
const proposalTone = (state: string): Tone =>
  state === 'applied' ? 'good' : ['failed', 'stale'].includes(state) ? 'bad' : state === 'review' ? 'warn' : 'neutral';

/** Changes to how memory is organized, including the ones Nocheh applied by itself; each opens its review, where it can be cancelled or undone. */
function Organizing() {
  const [cursors, setCursors] = useState<string[]>(['']);
  const list = useResource<{proposals: Proposal[]; next: string | null}>(
    '/knowledge/proposals?after=' + encodeURIComponent(cursors.at(-1) ?? ''),
    30000,
  );
  // The store sends more than a page; the next page starts after the last one shown.
  const all = list.data?.proposals ?? [];
  const items = all.slice(0, PAGE);
  const next = all.length > PAGE ? items.at(-1)!.id : (list.data?.next ?? null);
  return (
    <Card>
      <CardHeader
        title="Memory organizing"
        description="Projects Nocheh created or chats it sorted, with your decisions. Open one to cancel or undo it."
        className="pb-3"
      />
      {list.error && (
        <LoadError className="mx-5 mb-3" what="organizing changes" onRetry={() => void refreshResources()} />
      )}
      {!list.data ? (
        list.error ? null : (
          <LoadingRows rows={2} />
        )
      ) : items.length === 0 ? (
        <Empty icon={FolderTree} title="No organizing changes yet">
          When Nocheh suggests or makes a change to your projects, it shows here.
        </Empty>
      ) : (
        <HistoryTable
          label="Memory organizing"
          columns={['Change', 'Why', 'Result', 'When']}
          rows={items.map(item => ({
            id: item.id,
            href: decisionLink('knowledge', item.id),
            icon: <FolderTree className="size-4" />,
            title: proposalTitle(String(item.proposal?.kind ?? item.kind)),
            summary: item.proposal?.reason ?? '',
            state: proposalState(item.state),
            tone: proposalTone(item.state),
            time: item.created_at,
          }))}
        />
      )}
      <Pager
        page={cursors.length - 1}
        hasNext={!!next}
        labels={['Newer', 'Older']}
        onPage={page =>
          setCursors(current => (page < current.length - 1 ? current.slice(0, page + 1) : [...current, next!]))
        }
      />
    </Card>
  );
}
