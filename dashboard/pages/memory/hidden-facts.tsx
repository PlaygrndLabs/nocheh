/**
 * Memory › Long-term › Facts › Hidden: facts a clean-up retired (ADR-0298). They are kept, never deleted, and Bring back
 * makes one visible again, with its group copies.
 */
import {useState} from 'react';
import {apiPost} from '../../lib/api';
import {factsReasonText, type FactsReason} from '../../lib/memory-sources';
import {sentAt} from '../../lib/originals';
import {refreshResources, useResource} from '../../lib/resource';
import {Button, Card, CardBody, CardHeader, LoadError, LoadingRows, Pager, Table, Td, Th} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {errorWords, useCursorPages} from './shared';

export type HiddenFact = {
  id: string;
  text: string;
  about: string | null;
  where: 'everywhere' | 'group';
  reason: 'replaced' | 'unused';
  hidden_at: string | null;
  learned_at: string;
};
type HiddenPage = {facts: HiddenFact[]; next: string | null; reason?: FactsReason};

const why = {replaced: 'A newer fact replaced it', unused: 'Not used for the set days'};

export function HiddenFacts() {
  const cursor = useCursorPages('hidden');
  const page = useResource<HiddenPage>('/memory/hidden?' + new URLSearchParams({after: cursor.after}), 60000);
  const feedback = useFeedback();
  const [busy, setBusy] = useState('');
  const facts = page.data?.facts ?? [];
  const bringBack = async (fact: HiddenFact) => {
    setBusy(fact.id);
    try {
      await apiPost('/memory/hidden/restore', {ids: [fact.id]});
      feedback.toast('Brought back. Replies can use it again.');
      void refreshResources();
    } catch (failure) {
      feedback.toast(errorWords(failure), 'bad');
    } finally {
      setBusy('');
    }
  };
  return (
    <Card>
      <CardHeader
        title="Hidden facts"
        description="Facts a clean-up retired. They are kept, not deleted; replies don’t use them until you bring one back."
      />
      {page.error && !page.data ? (
        <CardBody>
          <LoadError what="hidden facts" error={page.error} onRetry={() => void refreshResources()} />
        </CardBody>
      ) : !page.data ? (
        <LoadingRows rows={2} />
      ) : (
        !facts.length && (
          <CardBody>
            <p className="text-[13px] text-muted">
              {page.data.reason ? factsReasonText(page.data.reason, 'list') : 'Nothing is hidden.'}
            </p>
          </CardBody>
        )
      )}
      {facts.length > 0 && (
        <Table aria-label="Hidden facts" className="max-sm:block">
          <thead className="max-sm:sr-only">
            <tr>
              <Th scope="col">Fact</Th>
              <Th scope="col">Why hidden</Th>
              <Th scope="col">
                <span className="sr-only">Bring back</span>
              </Th>
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {facts.map(fact => (
              <tr key={fact.id} className="max-sm:block max-sm:border-b max-sm:border-line max-sm:py-2">
                <Td dir="auto" className="break-words max-sm:block max-sm:border-0 max-sm:py-1 sm:w-[46%]">
                  {fact.text}
                  <p className="mt-0.5 text-xs text-muted">
                    {[
                      fact.about,
                      fact.where === 'group' ? 'In a group’s memory' : null,
                      'Learned ' + sentAt(fact.learned_at),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </Td>
                <Td className="text-xs text-muted max-sm:block max-sm:border-0 max-sm:py-1">
                  <p>{why[fact.reason]}</p>
                  {fact.hidden_at && <p>Hidden {sentAt(fact.hidden_at)}</p>}
                </Td>
                <Td className="max-sm:block max-sm:border-0 max-sm:py-1 sm:text-right">
                  <Button size="sm" busy={busy === fact.id} disabled={!!busy} onClick={() => void bringBack(fact)}>
                    Bring back
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        page={cursor.page}
        hasNext={!!page.data?.next}
        onPage={next => cursor.go(next, page.data?.next)}
        labels={['Newer', 'Older']}
      />
    </Card>
  );
}
