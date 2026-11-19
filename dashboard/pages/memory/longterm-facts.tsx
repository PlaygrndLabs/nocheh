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
  type FactCoverage,
  type FactsPage,
  type Person,
} from '../../lib/memory-sources';
import {FactItem} from '../../lib/originals';
import {Card, CardBody, CardHeader, Field, Input, LoadError, LoadingRows, Pager, Select} from '../../ui/core';
import {ChatPicker} from '../chats/chat-picker';
import {useCursorPages, useDebounced} from './shared';

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
        <div className="grid gap-3 sm:grid-cols-2">
          <ChatPicker
            label="In chat"
            value={chat ? [chat] : []}
            onChange={ids => setParams({chat: ids[0] ?? null}, true)}
            noOthersPrivate
          />
          <Field label="About person" htmlFor="facts-person">
            <div className="space-y-2">
              <Input
                type="search"
                aria-label="Search people"
                placeholder="Search people by name"
                value={typed}
                onChange={event => setTyped(event.target.value)}
              />
              <Select id="facts-person" value={about} onChange={event => setParams({about: event.target.value}, true)}>
                <option value="">Anyone</option>
                {options.map(person => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        </div>
        {page.error && !page.data ? (
          <LoadError what="facts" error={page.error} onRetry={() => void refreshResources()} />
        ) : !page.data ? (
          <LoadingRows rows={3} />
        ) : page.data.facts.length ? (
          <ul className="space-y-2" aria-label="Facts">
            {page.data.facts.map(fact => (
              <FactItem key={fact.id} fact={fact} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">{factsReasonText(page.data.reason, 'list', !!page.data.next)}</p>
        )}
      </CardBody>
      <Pager
        page={cursor.page}
        hasNext={!!page.data?.next}
        onPage={next => cursor.go(next, page.data?.next)}
        labels={['Newer', 'Older']}
      />
    </Card>
  );
}
