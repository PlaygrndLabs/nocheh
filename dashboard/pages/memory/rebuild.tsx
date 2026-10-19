/**
 * Memory › Long-term › Re-run: run failed learning again, re-learn chats from
 * their saved messages, or replace long-term memory with a new one. Each shows
 * what it would send before anything is sent.
 */
import {useState, type ReactNode} from 'react';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Segmented,
} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {ChatPicker} from '../chats/chat-picker';
import {CONFLICT_TEXT, useCommand} from './shared';

type Estimate = {
  workspace: string | null;
  failed_learning: number | null;
  relearn: {conversations: number; sessions: number; messages: number; interpretations: number};
  replace: {saved_messages: number};
};
type Budget = {reasoning_remaining_requests: number};

const CONFIRM_WORD = 'replace';
const count = (value: number, one: string, many: string) => `${value.toLocaleString()} ${value === 1 ? one : many}`;

export function Rebuild({revision, attached}: {revision: number; attached: boolean}) {
  const [scope, setScope] = useState<'all' | 'chosen'>('all');
  const [chats, setChats] = useState<string[]>([]);
  const chosen = scope === 'chosen' ? chats : [];
  const estimate = useResource<Estimate>(
    '/memory/honcho/rebuild' +
      (chosen.length ? '?' + chosen.map(id => 'space=' + encodeURIComponent(id)).join('&') : ''),
    30000,
  );
  const budget = useResource<Budget>('/honcho/budget', 15000);
  const data = estimate.data;
  const cost = (
    <>
      Each message is learned again by the memory model. That costs money and uses this month’s memory thinking requests
      {budget.data ? ` (${budget.data.reasoning_remaining_requests.toLocaleString()} left)` : ''}.
    </>
  );
  return (
    <Card>
      <CardHeader
        title="Re-run or replace"
        description="Make long-term memory learn again from your saved messages. Your messages themselves never change, and retired messages are always left out."
      />
      <CardBody className="space-y-4">
        {estimate.error && <LoadError what="what this would send" onRetry={() => void refreshResources()} />}
        {!data && !estimate.error && <LoadingRows rows={3} />}
        {data && (
          <>
            <Retry failed={data.failed_learning} attached={attached} />
            <Relearn
              estimate={data.relearn}
              attached={attached}
              scope={scope}
              setScope={setScope}
              chats={chats}
              setChats={setChats}
              cost={cost}
            />
            <Replace saved={data.replace.saved_messages} revision={revision} cost={cost} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Problem({error}: {error: string}) {
  if (!error) return null;
  return (
    <Notice
      tone={error === CONFLICT_TEXT ? 'warn' : 'bad'}
      action={
        error === CONFLICT_TEXT && (
          <Button size="sm" onClick={() => void refreshResources()}>
            Reload
          </Button>
        )
      }
    >
      {error}
    </Notice>
  );
}

function Retry({failed, attached}: {failed: number | null; attached: boolean}) {
  const feedback = useFeedback();
  const command = useCommand();
  const retry = async () => {
    const result = await command.run<{retried: number}>('/memory/honcho/retry-failed', {});
    if (result)
      feedback.toast(
        result.retried
          ? `Running ${count(result.retried, 'learning task', 'learning tasks')} again.`
          : 'Nothing failed.',
      );
  };
  return (
    <Section title="Retry failed learning">
      <p className="text-[13px] text-muted">
        Learning that failed, for example while the memory model couldn’t be reached, runs again on the messages
        long-term memory already has. Nothing is sent again.
      </p>
      <p className="text-[13px]">
        {failed === null
          ? 'Couldn’t check for failed learning right now.'
          : failed
            ? `${count(failed, 'learning task', 'learning tasks')} failed.`
            : 'Nothing has failed.'}
      </p>
      <Problem error={command.error} />
      <Button busy={command.busy} disabled={!attached || !failed} onClick={() => void retry()}>
        Retry failed learning
      </Button>
    </Section>
  );
}

function Relearn({
  estimate,
  attached,
  scope,
  setScope,
  chats,
  setChats,
  cost,
}: {
  estimate: Estimate['relearn'];
  attached: boolean;
  scope: 'all' | 'chosen';
  setScope: (value: 'all' | 'chosen') => void;
  chats: string[];
  setChats: (value: string[]) => void;
  cost: ReactNode;
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const ready = scope === 'all' || chats.length > 0;
  const summary = `${count(estimate.messages, 'saved message', 'saved messages')} from ${count(
    estimate.conversations,
    'conversation',
    'conversations',
  )}`;
  const relearn = async () => {
    if (
      !(await feedback.confirm({
        title: scope === 'all' ? 'Re-learn every chat?' : 'Re-learn the chosen chats?',
        body: (
          <div className="space-y-2">
            <p>
              Long-term memory forgets what it learned from {scope === 'all' ? 'every chat' : 'these chats'} and learns
              again from {summary}.
            </p>
            <p>{cost}</p>
          </div>
        ),
        confirm: 'Re-learn',
      }))
    )
      return;
    const result = await command.run<Estimate['relearn']>(
      '/memory/honcho/rebuild',
      scope === 'all' ? {} : {spaces: chats},
    );
    if (result) feedback.toast(`Re-learning ${count(result.messages, 'saved message', 'saved messages')}.`);
  };
  return (
    <Section title="Re-learn chats">
      <p className="text-[13px] text-muted">
        Long-term memory forgets what it learned from the chosen chats and learns them again from their saved messages,
        dated by when they were sent. A group includes its topics. While it re-learns, replies use notes and message
        search.
      </p>
      <Segmented
        label="Which chats"
        value={scope}
        onChange={setScope}
        options={[
          {value: 'all', label: 'Every chat'},
          {value: 'chosen', label: 'Chosen chats'},
        ]}
      />
      {scope === 'chosen' && <ChatPicker label="Chats to re-learn" value={chats} onChange={setChats} multiple />}
      {ready && (
        <p className="text-[13px]">
          {estimate.messages
            ? `${summary} will be sent again.`
            : 'Long-term memory holds nothing from these chats yet.'}
        </p>
      )}
      {ready && estimate.messages > 0 && <p className="text-xs text-muted">{cost}</p>}
      <Problem error={command.error} />
      <Button busy={command.busy} disabled={!attached || !ready || !estimate.messages} onClick={() => void relearn()}>
        Re-learn
      </Button>
    </Section>
  );
}

function Replace({saved, revision, cost}: {saved: number; revision: number; cost: ReactNode}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [from, setFrom] = useState<'archive' | 'empty'>('archive');
  const [typed, setTyped] = useState('');
  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;
  const replace = async () => {
    const result = await command.run('/memory/honcho/fresh-start', {
      expected_revision: revision,
      from_archive: from === 'archive',
    });
    if (result) {
      setTyped('');
      feedback.toast(
        from === 'archive'
          ? 'Long-term memory replaced. It is learning your saved messages again.'
          : 'Long-term memory replaced. It learns from new messages.',
      );
    }
  };
  return (
    <Section title="Replace long-term memory">
      <p className="text-[13px] text-muted">
        Starts a new long-term memory and deletes the current one completely, including everything it learned. Until the
        new one is ready, replies use notes and message search.
      </p>
      <Segmented
        label="The new memory"
        value={from}
        onChange={setFrom}
        options={[
          {value: 'archive', label: 'From saved messages'},
          {value: 'empty', label: 'Empty'},
        ]}
      />
      <p className="text-[13px]">
        {from === 'archive'
          ? `Up to ${count(saved, 'saved message', 'saved messages')} you allowed it to learn will be sent again.`
          : 'Only messages that arrive from now on are learned.'}
      </p>
      {from === 'archive' && <p className="text-xs text-muted">{cost}</p>}
      <Field label={`Type “${CONFIRM_WORD}” to confirm`} htmlFor="memory-replace-confirm" className="max-w-xs">
        <Input
          id="memory-replace-confirm"
          value={typed}
          autoComplete="off"
          onChange={event => {
            setTyped(event.target.value);
            command.clear();
          }}
        />
      </Field>
      <Problem error={command.error} />
      <Button variant="danger" busy={command.busy} disabled={!confirmed} onClick={() => void replace()}>
        Replace long-term memory
      </Button>
    </Section>
  );
}
