/**
 * Memory › Long-term › Facts: what long-term memory learned, newest first, in one chat or about one person, each with
 * where it came from; and how many facts name their exact messages (ADR-0261 step 4). Looking changes nothing.
 */
import {useState} from 'react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {
  coverageLine,
  factsReasonText,
  personOptions,
  factBadge,
  type Fact,
  type FactCoverage,
  type FactsPage,
  type Person,
} from '../../lib/memory-sources';
import {OriginalList, sentAt} from '../../lib/originals';
import {
  Card,
  CardBody,
  CardHeader,
  Dot,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Pager,
  Select,
  Table,
  Td,
  Th,
} from '../../ui/core';
import {ChatPicker} from '../chats/chat-picker';
import {useCursorPages, useDebounced} from './shared';

const ROWS = 10;
/** How many tables of ROWS one server page of 25 makes. */
const PARTS = 3;

export function LongTermFacts() {
  const chat = useParam('chat') ?? '';
  const about = useParam('about') ?? '';
  const coverage = useResource<FactCoverage>('/memory/longterm/coverage', 60000);
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim());
  const people = useResource<{entities: Person[]}>(
    '/entities?' + new URLSearchParams({kind: 'person', q: query, after: '', state: 'active'}),
    60000,
  );
  // The person chosen (from People, say) is offered by name even when the first page of people doesn't hold them.
  const chosen = useResource<{entity: Person}>(about ? '/entities/' + about : null, 60000);
  const options = personOptions(people.data?.entities ?? [], chosen.data?.entity);
  const cursor = useCursorPages(chat + '\u0000' + about);
  const page = useResource<FactsPage>(
    '/memory/facts?' + new URLSearchParams({chat, person: about, after: cursor.after}),
    60000,
  );
  const counted = coverage.data?.coverage;
  // The server hands facts 25 at a time; the table shows ROWS of them, so the page stays near one screen.
  const filter = chat + '\u0000' + about;
  const [part, setPart] = useState({filter, page: 0, index: 0});
  const facts = page.data?.facts ?? [];
  const parts = Math.max(1, Math.ceil(facts.length / ROWS));
  const index = part.filter === filter && part.page === cursor.page ? Math.min(part.index, parts - 1) : 0;
  const shown = facts.slice(index * ROWS, (index + 1) * ROWS);
  const turn = (older: boolean) => {
    if (older && index + 1 < parts) return setPart({filter, page: cursor.page, index: index + 1});
    if (!older && index > 0) return setPart({filter, page: cursor.page, index: index - 1});
    const next = cursor.page + (older ? 1 : -1);
    cursor.go(next, page.data?.next);
    // Stepping back lands on the last rows of the page before, which is where the owner came from.
    setPart({filter, page: next, index: older ? 0 : PARTS});
  };
  return (
    <Card>
      <CardHeader
        title="Facts it learned"
        description="Newest first. Each fact links to the messages it came from. Looking doesn’t change anything."
      />
      <CardBody className="space-y-4">
        {counted ? (
          <p className="text-[13px]" title="Exact: the fact names every message it came from.">
            {coverageLine(counted)}
          </p>
        ) : (
          coverage.data?.reason === 'unavailable' && (
            <p className="text-[13px] text-muted">{factsReasonText('unavailable', 'list')}</p>
          )
        )}
        <div className="grid items-start gap-3 sm:grid-cols-3">
          <ChatPicker
            label="In chat"
            value={chat ? [chat] : []}
            onChange={ids => setParams({chat: ids[0] ?? null}, true)}
            noOthersPrivate
            compact
          />
          <Field label="Find a person" htmlFor="facts-person-search">
            <Input
              id="facts-person-search"
              type="search"
              aria-label="Search people"
              placeholder="Search people by name"
              value={typed}
              onChange={event => setTyped(event.target.value)}
            />
          </Field>
          <Field label="About person" htmlFor="facts-person">
            <Select id="facts-person" value={about} onChange={event => setParams({about: event.target.value}, true)}>
              <option value="">Anyone</option>
              {options.map(person => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {page.error && !page.data ? (
          <LoadError what="facts" error={page.error} onRetry={() => void refreshResources()} />
        ) : !page.data ? (
          <LoadingRows rows={3} />
        ) : (
          !facts.length && (
            <p className="text-[13px] text-muted">{factsReasonText(page.data.reason, 'list', !!page.data.next)}</p>
          )
        )}
      </CardBody>
      {shown.length > 0 && (
        <Table aria-label="Facts" className="max-sm:block">
          <thead className="max-sm:sr-only">
            <tr>
              <Th scope="col">Fact</Th>
              <Th scope="col">Learned</Th>
              <Th scope="col">Where it came from</Th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {shown.map(fact => (
              <FactRow key={fact.id} fact={fact} />
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        page={cursor.page * PARTS + index}
        hasNext={index + 1 < parts || !!page.data?.next}
        onPage={next => turn(next > cursor.page * PARTS + index)}
        labels={['Newer', 'Older']}
      />
    </Card>
  );
}

/** One fact as a table row: its words, when it was learned and how its source is known, and its originals. On a
 *  phone the cells stack. */
function FactRow({fact}: {fact: Fact}) {
  const badge = factBadge(fact);
  return (
    <tr className="max-sm:block max-sm:border-b max-sm:border-line max-sm:py-2">
      <Td dir="auto" className="break-words max-sm:block max-sm:border-0 max-sm:py-1 sm:w-[38%]">
        {fact.text}
      </Td>
      <Td className="space-y-1 text-xs text-muted max-sm:block max-sm:border-0 max-sm:py-1 sm:w-44">
        <p>{sentAt(fact.learned_at)}</p>
        {badge && (
          <p className="flex items-center gap-1.5">
            <Dot tone={badge.tone} />
            {badge.label}
          </p>
        )}
      </Td>
      <Td className="max-sm:block max-sm:border-0 max-sm:py-1">
        <OriginalList originals={fact.originals} more={fact.more} label="Where it came from" />
      </Td>
    </tr>
  );
}
