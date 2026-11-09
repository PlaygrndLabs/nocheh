/** Review of one external action or Telegram message: the exact thing, then Approve or Deny.
 *  An unclear outcome waits here until the owner says whether it happened, or dismisses it. */
import {useId, useState} from 'react';
import {Badge, Button, Details, Field, Notice, Select, Switch, Technical} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {Exact, Fact, Facts, ReviewDrawer, type ReviewState} from './review-drawer';
import {
  actionName,
  actionPlace,
  actionStateLabel,
  actionSummary,
  fromNow,
  fullTime,
  useChatNames,
  useCommand,
  type Action,
} from './shared';

const durations = [
  {minutes: 60, label: 'for 1 hour'},
  {minutes: 1440, label: 'for 1 day'},
  {minutes: 10080, label: 'for 1 week'},
  {minutes: 43200, label: 'for 30 days'},
];
const useCounts = [1, 3, 10, 50];
type Resolution = 'ran' | 'not_run' | 'dismissed';

export function ActionReview({action, review, onClose}: {action: Action; review: ReviewState; onClose: () => void}) {
  const {toast} = useFeedback();
  const chat = useChatNames();
  const command = useCommand();
  const id = useId();
  const [again, setAgain] = useState(false);
  const [minutes, setMinutes] = useState(1440);
  const [uses, setUses] = useState(3);
  const telegram = action.kind === 'telegram_message';
  const pending = action.state === 'proposed';
  // No receipt confirms how it ended, and nothing has closed it yet.
  const unclear = action.state === 'ambiguous' && !action.resolution;
  const locked = !!(review.changed || review.unavailable) || !!command.busy;
  const [label, tone] = actionStateLabel(action);
  const exact = actionSummary(action);
  const mcpInput = action.kind === 'mcp' && action.arguments?.input ? action.arguments.input : null;
  // A failed receipt keeps its reason in the result, as its Telegram card reads it.
  const receipt = action.result as {result?: {error?: unknown}} | null | undefined;
  const failure = action.error_code ?? (typeof receipt?.result?.error === 'string' ? receipt.result.error : null);

  const grant = () =>
    command.run('/tools/grant', {action_id: action.id, fingerprint: action.fingerprint, minutes, uses}, 'grant');
  const decide = async (decision: 'approve' | 'deny') => {
    const body: Record<string, unknown> = {id: action.id, fingerprint: action.fingerprint, decision};
    if (typeof action.revision === 'number') body.expected_revision = action.revision;
    const done = await command.run(telegram ? '/tools/telegram-decision' : '/tools/decide', body, decision);
    if (!done) return;
    if (decision === 'approve' && again && !telegram) {
      const granted = await grant();
      if (!granted) {
        toast('Approved, but “allow again” wasn’t saved. Try it from History.', 'bad');
        onClose();
        return;
      }
      toast('Approved. Nocheh may repeat this exact action ' + durationText(minutes, uses) + '.');
    } else
      toast(
        decision === 'deny'
          ? telegram
            ? 'Message won’t be sent.'
            : 'Action denied.'
          : telegram
            ? 'Approved. The message is being sent.'
            : 'Approved. It starts shortly; the result shows in History.',
      );
    onClose();
  };
  const resolve = async (outcome: Resolution) => {
    const body: Record<string, unknown> = {id: action.id, fingerprint: action.fingerprint, outcome};
    if (typeof action.revision === 'number') body.expected_revision = action.revision;
    if (!(await command.run(telegram ? '/tools/telegram-resolve' : '/tools/resolve', body, outcome))) return;
    toast(
      outcome === 'dismissed'
        ? 'Dismissed.'
        : outcome === 'ran'
          ? telegram
            ? 'Marked as sent.'
            : 'Marked as ran.'
          : telegram
            ? 'Marked as not sent.'
            : 'Marked as not run.',
    );
    onClose();
  };
  const allowOnly = async () => {
    if (await grant()) {
      toast('Saved. Nocheh may repeat this exact action ' + durationText(minutes, uses) + '.');
      onClose();
    }
  };

  const allowControls = (
    <div className="flex flex-wrap gap-3">
      <Field label="How long" htmlFor={id + '-minutes'} className="min-w-40 flex-1">
        <Select
          id={id + '-minutes'}
          value={minutes}
          disabled={locked}
          onChange={e => setMinutes(Number(e.target.value))}
        >
          {durations.map(d => (
            <option key={d.minutes} value={d.minutes}>
              {d.label.replace('for ', '')}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="How many times" htmlFor={id + '-uses'} className="min-w-40 flex-1">
        <Select id={id + '-uses'} value={uses} disabled={locked} onChange={e => setUses(Number(e.target.value))}>
          {useCounts.map(n => (
            <option key={n} value={n}>
              {n === 1 ? 'Once' : `Up to ${n} times`}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );

  return (
    <ReviewDrawer
      title={
        telegram
          ? pending
            ? 'Send this Telegram message?'
            : 'Telegram message'
          : actionName(action.kind) + (pending ? '?' : '')
      }
      description={pending ? 'Approval covers exactly what is shown here, nothing else.' : undefined}
      onClose={onClose}
      review={review}
      error={command.error}
      footer={
        pending ? (
          <>
            <Button
              variant="primary"
              busy={command.busy === 'approve' || command.busy === 'grant'}
              disabled={locked || review.stale}
              onClick={() => void decide('approve')}
            >
              {telegram ? 'Approve and send' : again ? 'Approve and allow again' : 'Approve'}
            </Button>
            <Button busy={command.busy === 'deny'} disabled={locked} onClick={() => void decide('deny')}>
              Deny
            </Button>
          </>
        ) : unclear ? (
          <>
            <Button busy={command.busy === 'ran'} disabled={locked} onClick={() => void resolve('ran')}>
              {telegram ? 'It was sent' : 'It ran'}
            </Button>
            <Button busy={command.busy === 'not_run'} disabled={locked} onClick={() => void resolve('not_run')}>
              {telegram ? 'It wasn’t sent' : 'It didn’t run'}
            </Button>
            <Button
              variant="ghost"
              busy={command.busy === 'dismissed'}
              disabled={locked}
              onClick={() => void resolve('dismissed')}
            >
              Dismiss
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone} dot>
          {label}
        </Badge>
        <span className="text-xs text-muted" title={fullTime(action.created_at)}>
          Asked {fromNow(action.created_at)}
        </span>
      </div>

      {review.stale && pending && (
        <Notice tone="warn" title="Can’t be approved any more">
          Something it used changed after it was asked. Ask again if you still want it, or deny this one.
        </Notice>
      )}
      {unclear && (
        <Notice
          tone="warn"
          title={telegram ? 'Nocheh isn’t sure whether this was sent' : 'Nocheh isn’t sure whether this ran'}
        >
          {telegram
            ? 'No confirmed delivery came back. Check the chat, then say what happened below. It is never sent again by itself.'
            : 'No confirmed result came back, so it may or may not have happened. Check, then say what happened below. It never runs again by itself.'}
        </Notice>
      )}
      {action.state === 'ambiguous' && action.resolution === 'read_closed' && (
        <Notice title="Closed by itself">
          No answer came back. A page read changes nothing, so there was nothing to check. Ask again if you still need
          it.
        </Notice>
      )}
      {action.state === 'failed' && (
        <Notice tone="bad" title="It failed">
          {failure ? 'Reason: ' + failure.replaceAll('_', ' ') + '.' : 'No reason was recorded.'}
        </Notice>
      )}

      {telegram ? (
        <>
          <Facts>
            <Fact label="To">{chat(actionPlace(action))}</Fact>
            <Fact label="Asked in">{chat(action.scope)}</Fact>
          </Facts>
          <Exact label="Message">{exact || 'The message text couldn’t be read.'}</Exact>
        </>
      ) : (
        <>
          {action.summary && (
            <div>
              <p className="text-xs font-medium text-muted">The assistant says</p>
              <p className="mt-1 text-sm">{action.summary}</p>
            </div>
          )}
          <Exact label={action.kind === 'shell' ? 'Command' : action.kind === 'browser' ? 'Web page' : 'Exactly'} mono>
            {exact || 'The details couldn’t be read.'}
          </Exact>
          {mcpInput && (
            <Exact label="With this input" mono>
              {JSON.stringify(mcpInput, null, 2)}
            </Exact>
          )}
          <Facts>
            <Fact label="Asked in">{chat(action.scope)}</Fact>
            <Fact label="When">{fullTime(action.created_at)}</Fact>
          </Facts>
        </>
      )}

      {!telegram && pending && (
        <div className="rounded-lg border border-line p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Allow this exact action again</p>
              <p className="mt-0.5 text-[13px] text-muted">
                Next time Nocheh asks for exactly this, it runs without asking you.
              </p>
            </div>
            <Switch checked={again} onChange={setAgain} label="Allow this exact action again" disabled={locked} />
          </div>
          {again && <div className="mt-4">{allowControls}</div>}
        </div>
      )}

      {action.result != null && <ResultBlock result={action.result} />}

      {!telegram && !pending && action.state !== 'ambiguous' && (
        <Details summary="Allow this exact action without asking">
          <div className="space-y-3">
            <p className="text-[13px] text-muted">When Nocheh asks for exactly this again, it runs straight away.</p>
            {allowControls}
            <Button busy={command.busy === 'grant'} disabled={locked} onClick={() => void allowOnly()}>
              Allow {durationText(minutes, uses)}
            </Button>
          </div>
        </Details>
      )}

      {action.event_id && (
        <a
          className="block text-sm text-accent-text hover:underline"
          href={'#messages?source=' + encodeURIComponent(action.event_id)}
        >
          Open the message that asked for this
        </a>
      )}
      <Technical value={action} />
    </ReviewDrawer>
  );
}

function durationText(minutes: number, uses: number) {
  const span = durations.find(d => d.minutes === minutes)?.label ?? `for ${minutes} minutes`;
  return (uses === 1 ? 'once ' : `up to ${uses} times `) + span;
}

/** What came back. Plain text is shown as text; anything else behind a disclosure. */
function ResultBlock({result}: {result: unknown}) {
  const text =
    typeof result === 'string'
      ? result
      : result && typeof result === 'object'
        ? ['output', 'stdout', 'text', 'summary', 'message']
            .map(key => (result as any)[key])
            .find(v => typeof v === 'string')
        : undefined;
  return (
    <div className="space-y-2">
      {text ? <Exact label="Result">{text}</Exact> : <p className="text-xs font-medium text-muted">Result</p>}
      <Technical value={result} summary="Full result" />
    </div>
  );
}
