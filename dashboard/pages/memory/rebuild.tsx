/**
 * Memory › Long-term › Re-run: run failed learning again, re-learn chats from
 * their saved messages, or replace long-term memory with a new one. The three
 * actions are rows of one table; re-learn and replace open a dialog that shows
 * what it would send before anything is sent.
 */
import {useState, type ReactNode} from 'react';
import {refreshResources, useResource} from '../../lib/resource';
import {
  ActionRow,
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
  Table,
  Th,
} from '../../ui/core';
import {Dialog, useFeedback} from '../../ui/overlay';
import {ChatPicker} from '../chats/chat-picker';
import {CONFLICT_TEXT, useCommand} from './shared';

type Estimate = {
  workspace: string | null;
  failed_learning: number | null;
  relearn: {conversations: number; sessions: number; messages: number; interpretations: number};
  replace: {saved_messages: number};
};
type Budget = {thinking_remaining_usd: number | null};

const CONFIRM_WORD = 'replace';
const count = (value: number, one: string, many: string) => `${value.toLocaleString()} ${value === 1 ? one : many}`;

export function Rebuild({revision, attached}: {revision: number; attached: boolean}) {
  const [open, setOpen] = useState<'relearn' | 'replace' | null>(null);
  const [scope, setScope] = useState<'all' | 'chosen'>('all');
  const [chats, setChats] = useState<string[]>([]);
  const chosen = scope === 'chosen' ? chats : [];
  const estimate = useResource<Estimate>(
    '/memory/longterm/rebuild' +
      (chosen.length ? '?' + chosen.map(id => 'space=' + encodeURIComponent(id)).join('&') : ''),
    30000,
  );
  const budget = useResource<Budget>('/honcho/budget', 15000);
  const data = estimate.data;
  const close = () => setOpen(null);
  const cost = (
    <>
      Each message is learned again by the memory model. That costs money and counts toward this month’s memory thinking
      spending limit
      {budget.data?.thinking_remaining_usd != null
        ? ` (${new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(budget.data.thinking_remaining_usd)} left)`
        : ', which is off'}
      .
    </>
  );
  return (
    <Card>
      <CardHeader
        title="Re-run or replace"
        description="Make long-term memory learn again from your saved messages. Your messages themselves never change, and retired messages are always left out."
      />
      {estimate.error && (
        <CardBody>
          <LoadError what="what this would send" onRetry={() => void refreshResources()} />
        </CardBody>
      )}
      {!data && !estimate.error && (
        <CardBody>
          <LoadingRows rows={3} />
        </CardBody>
      )}
      {data && (
        <>
          <Table aria-label="Re-run or replace" className="max-sm:block">
            <thead className="max-sm:sr-only">
              <tr>
                <Th scope="col">Action</Th>
                <Th scope="col">What it does</Th>
                <Th scope="col">
                  <span className="sr-only">Run</span>
                </Th>
              </tr>
            </thead>
            <tbody className="max-sm:block">
              <Retry failed={data.failed_learning} attached={attached} />
              <ActionRow
                title="Re-learn chats"
                detail="Long-term memory forgets what it learned from the chats you choose and learns them again from their saved messages."
              >
                <Button size="sm" disabled={!attached} onClick={() => setOpen('relearn')}>
                  Re-learn…
                </Button>
              </ActionRow>
              <ActionRow
                title="Replace long-term memory"
                detail="Starts a new long-term memory and deletes the current one completely, including everything it learned."
              >
                <Button size="sm" variant="danger" onClick={() => setOpen('replace')}>
                  Replace…
                </Button>
              </ActionRow>
            </tbody>
          </Table>
          <Dialog
            open={open === 'relearn'}
            onOpenChange={next => !next && close()}
            title="Re-learn chats"
            description="A group includes its topics. While it re-learns, replies use notes and message search."
          >
            <Relearn
              estimate={data.relearn}
              attached={attached}
              scope={scope}
              setScope={setScope}
              chats={chats}
              setChats={setChats}
              cost={cost}
              done={close}
            />
          </Dialog>
          <Dialog
            open={open === 'replace'}
            onOpenChange={next => !next && close()}
            title="Replace long-term memory"
            description="Until the new one is ready, replies use notes and message search."
          >
            <Replace saved={data.replace.saved_messages} revision={revision} cost={cost} done={close} />
          </Dialog>
        </>
      )}
    </Card>
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
    const result = await command.run<{retried: number}>('/memory/longterm/retry-failed', {});
    if (result)
      feedback.toast(
        result.retried
          ? `Running ${count(result.retried, 'learning task', 'learning tasks')} again.`
          : 'Nothing failed.',
      );
  };
  return (
    <ActionRow
      title="Retry failed learning"
      detail={
        <>
          <p>
            Learning that failed runs again on the messages long-term memory already has. Nothing is sent again.{' '}
            <span className="text-fg">
              {failed === null
                ? 'Couldn’t check for failed learning right now.'
                : failed
                  ? `${count(failed, 'learning task', 'learning tasks')} failed.`
                  : 'Nothing has failed.'}
            </span>
          </p>
          <Problem error={command.error} />
        </>
      }
    >
      <Button size="sm" busy={command.busy} disabled={!attached || !failed} onClick={() => void retry()}>
        Retry failed learning
      </Button>
    </ActionRow>
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
  done,
}: {
  estimate: Estimate['relearn'];
  attached: boolean;
  scope: 'all' | 'chosen';
  setScope: (value: 'all' | 'chosen') => void;
  chats: string[];
  setChats: (value: string[]) => void;
  cost: ReactNode;
  done: () => void;
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const ready = scope === 'all' || chats.length > 0;
  const summary = `${count(estimate.messages, 'saved message', 'saved messages')} from ${count(
    estimate.conversations,
    'conversation',
    'conversations',
  )}`;
  // The dialog is the confirmation: it names what is forgotten and what is sent before the button works.
  const relearn = async () => {
    const result = await command.run<Estimate['relearn']>(
      '/memory/longterm/rebuild',
      scope === 'all' ? {} : {spaces: chats},
    );
    if (result) {
      feedback.toast(`Re-learning ${count(result.messages, 'saved message', 'saved messages')}.`);
      done();
    }
  };
  return (
    <div className="space-y-3">
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
            ? `Long-term memory forgets what it learned from ${
                scope === 'all' ? 'every chat' : 'these chats'
              } and learns again from ${summary}, dated by when they were sent.`
            : 'Long-term memory holds nothing from these chats yet.'}
        </p>
      )}
      {ready && estimate.messages > 0 && (
        <p className="text-xs text-muted">{cost} Messages are learned again in the form they were first learned in.</p>
      )}
      <Problem error={command.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={done}>Cancel</Button>
        <Button
          variant="primary"
          busy={command.busy}
          disabled={!attached || !ready || !estimate.messages}
          onClick={() => void relearn()}
        >
          Re-learn
        </Button>
      </div>
    </div>
  );
}

function Replace({saved, revision, cost, done}: {saved: number; revision: number; cost: ReactNode; done: () => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [from, setFrom] = useState<'archive' | 'empty'>('archive');
  const [typed, setTyped] = useState('');
  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;
  const replace = async () => {
    const result = await command.run('/memory/longterm/fresh-start', {
      expected_revision: revision,
      from_archive: from === 'archive',
    });
    if (result) {
      feedback.toast(
        from === 'archive'
          ? 'Long-term memory replaced. It is learning your saved messages again.'
          : 'Long-term memory replaced. It learns from new messages.',
      );
      done();
    }
  };
  return (
    <div className="space-y-3">
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
      {from === 'archive' && (
        <p className="text-[13px] text-muted">
          They are learned by today’s rules: other people’s forwards and the text of your files get their own place, and
          Nocheh’s own cards, notices and reminders are left out.
        </p>
      )}
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
      <div className="flex justify-end gap-2">
        <Button onClick={done}>Cancel</Button>
        <Button variant="danger" busy={command.busy} disabled={!confirmed} onClick={() => void replace()}>
          Replace long-term memory
        </Button>
      </div>
    </div>
  );
}
