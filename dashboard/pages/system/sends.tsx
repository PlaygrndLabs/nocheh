/**
 * System › Sent to apps: what Nocheh sent to chat apps such as Telegram, newest first, and whether it arrived.
 * Each entry keeps only what kind of send it was, to which chat, when and how it went; never the words.
 */
import {useState} from 'react';
import {Send} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {useResource} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import {chatSends, sendSummary, type ChatSend} from '../../lib/system-health';
import {ago, dateTime, sendApp, sendReason, sendState, sendWhat} from '../../lib/system-format';
import {
  Badge,
  Card,
  CardHeader,
  Empty,
  LoadError,
  LoadingRows,
  Pager,
  Segmented,
  Skeleton,
  Table,
  Td,
  Th,
} from '../../ui/core';

type Filter = 'all' | 'problems';
type Page = {records: ChatSend[]; next: string | null};

export function SendsView() {
  const filter: Filter = useParam('filter') === 'problems' ? 'problems' : 'all';
  const monitoring = useResource<any>('/monitoring', 10000);
  const summary = chatSends(monitoring.data);
  return (
    <Card>
      <CardHeader
        title="Sent to apps"
        description="Replies, cards, notices and reactions Nocheh sent to your chat apps, newest first. Only what kind it was, where and how it went is kept, never the words."
        action={
          <Segmented
            size="sm"
            label="Show"
            value={filter}
            onChange={value => setParams({filter: value === 'all' ? null : value}, true)}
            options={[
              {value: 'all', label: 'All'},
              {value: 'problems', label: 'Problems'},
            ]}
          />
        }
      />
      <div className="px-5 pt-2 text-[13px]">
        {summary ? (
          <p>{sendSummary(summary)}</p>
        ) : monitoring.data || monitoring.error ? (
          <p className="text-muted">The last day couldn’t be counted right now.</p>
        ) : (
          <Skeleton className="h-5 w-72 max-w-full" />
        )}
      </div>
      <Sends key={filter} filter={filter} />
    </Card>
  );
}

/** Where a send went: the chat's name when Nocheh knows it, with its topic. */
function ChatName({row}: {row: ChatSend}) {
  if (!row.chat) return <span className="text-muted">—</span>;
  const name = (row.chat_title ?? row.chat) + (row.topic != null ? ` · topic ${row.topic}` : '');
  if (row.channel !== 'telegram') return <>{name}</>;
  const space = row.chat + (row.topic != null ? '/topic/' + row.topic : '');
  return (
    <a className="hover:underline" href={href('chats', {chat: space})} dir="auto">
      {name}
    </a>
  );
}

function Sends({filter}: {filter: Filter}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const before = pages.at(-1);
  const query = new URLSearchParams({
    limit: '25',
    ...(filter === 'problems' ? {filter} : {}),
    ...(before ? {before} : {}),
  });
  const {data, error} = useResource<Page>('/chat-sends?' + query, 10000);
  const rows = data?.records ?? [];
  return (
    <div className="mt-3">
      {error && (
        <div className="px-5 pb-3">
          <LoadError what="what was sent" />
        </div>
      )}
      {!data && !error ? (
        <LoadingRows rows={5} />
      ) : data && !rows.length && pages.length > 1 ? (
        // An older page can come back empty, such as when its starting point has expired.
        <>
          <Empty icon={Send} title="Nothing older">
            Go back to the newest sends.
          </Empty>
          <Pager
            page={pages.length - 1}
            hasNext={false}
            labels={['Newer', 'Older']}
            onPage={() => setPages([null])}
            summary={`Page ${pages.length}`}
          />
        </>
      ) : data && !rows.length ? (
        <Empty icon={Send} title={filter === 'problems' ? 'Nothing failed' : 'Nothing sent yet'}>
          {filter === 'problems'
            ? 'Sends a chat app refused or never answered appear here.'
            : 'Replies, cards, notices and reactions appear here when Nocheh sends them.'}
        </Empty>
      ) : rows.length ? (
        <>
          <Table aria-label="Sent to apps">
            <thead>
              <tr>
                <Th scope="col" className="hidden sm:table-cell">
                  When
                </Th>
                <Th scope="col" className="hidden md:table-cell">
                  App
                </Th>
                <Th scope="col" className="hidden sm:table-cell">
                  Chat
                </Th>
                <Th scope="col">What</Th>
                <Th scope="col">Result</Th>
                <Th scope="col" className="hidden sm:table-cell">
                  Reason
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const state = sendState(row);
                const reason = sendReason(row);
                return (
                  <tr key={row.id}>
                    <Td className="hidden whitespace-nowrap text-muted sm:table-cell">
                      <time dateTime={row.at} title={dateTime(row.at)}>
                        {ago(row.at)}
                      </time>
                    </Td>
                    <Td className="hidden md:table-cell">{sendApp(row.channel)}</Td>
                    <Td className="hidden max-w-56 truncate sm:table-cell">
                      <ChatName row={row} />
                    </Td>
                    <Td className="min-w-28">
                      {sendWhat(row)}
                      {/* Phones show where and when under what was sent. */}
                      <p className="max-w-52 truncate text-xs text-muted sm:hidden">
                        {row.chat && (
                          <>
                            <ChatName row={row} />
                            {' · '}
                          </>
                        )}
                        <time dateTime={row.at}>{ago(row.at)}</time>
                      </p>
                    </Td>
                    <Td>
                      <Badge tone={state.tone}>{state.label}</Badge>
                      {reason && <p className="mt-0.5 text-xs text-muted sm:hidden">{reason}</p>}
                    </Td>
                    <Td className="hidden min-w-40 text-muted sm:table-cell">{reason || '—'}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pager
            page={pages.length - 1}
            hasNext={data?.next != null}
            labels={['Newer', 'Older']}
            onPage={page =>
              setPages(current => (page > current.length - 1 ? [...current, data!.next] : current.slice(0, page + 1)))
            }
            summary={`Page ${pages.length} · updates every 10 seconds`}
          />
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            Uncertain means the app didn’t answer, so it may still have arrived. Not sent means Nocheh held it back
            itself.
          </p>
        </>
      ) : null}
    </div>
  );
}
