/**
 * Memory › Long-term memory › Clean up: "Hide replaced facts" is Honcho's dreams (ADR-0298), saved with the page and
 * applied by restarting long-term memory. "Hide unused facts" is Nocheh's own rule (ADR-0299), saved at once in its
 * dialog. Both are off by default, and both only hide facts, which can be brought back.
 */
import {useState} from 'react';
import {useResource} from '../../lib/resource';
import {useSettings} from '../../lib/settings';
import {Button, Card, CardHeader, Field, Input, Notice, Switch} from '../../ui/core';
import {Dialog, useFeedback} from '../../ui/overlay';
import {Unsaved} from '../settings/telegram';
import {useCommand} from './shared';

export const retireKey = 'NOCHEH_MEMORY_RETIRE_OLD_FACTS';

export type CleanUp = {
  hide_unused_days: number | null;
  tracking_since: string;
  starts_at: string | null;
  swept_at: string | null;
  last_hidden: number | null;
  revision: number;
};

const day = (value: string) => new Date(value).toLocaleDateString(undefined, {dateStyle: 'medium'});

export function RetireOldFactsCard() {
  const s = useSettings();
  const field = s.field(retireKey);
  return (
    <Card>
      <CardHeader
        title="Hide old facts"
        description="Two ways to keep long-term memory tidy. Both are off until you turn them on. A hidden fact is not deleted: replies stop using it, and you can bring it back from Hidden facts."
        className="pb-3"
      />
      {/* Its own rows: the card sits in the narrow column, where a setting row's wide control would crush the text. */}
      {field && (
        <div className="flex items-start justify-between gap-4 border-t border-line px-5 py-4">
          <div className="min-w-0">
            <label htmlFor="memory-retire-old-facts" className="block text-sm font-medium">
              Hide replaced facts
              <Unsaved show={s.changed(retireKey)} />
            </label>
            <p className="mt-0.5 text-[13px] text-muted">
              Built into Honcho. Honcho rereads what it learned and hides a fact when a newer one replaces it. For
              example, “lives in Paris” is hidden once it learns “moved to Berlin”. It runs by itself, at most every 8
              hours, while new facts come in.
            </p>
            <p className="mt-1 text-[13px] text-muted">
              Costs extra: each run uses up to about 22 memory-model calls, counted in the memory thinking limit.
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Switch
              id="memory-retire-old-facts"
              label="Hide replaced facts"
              checked={s.value(retireKey) === 'true'}
              disabled={s.busy}
              onChange={on => s.set(retireKey, on ? 'true' : 'false')}
            />
          </div>
        </div>
      )}
      <HideUnusedRow />
    </Card>
  );
}

function HideUnusedRow() {
  const rule = useResource<CleanUp>('/memory/clean-up', 60000);
  const [editing, setEditing] = useState(false);
  const data = rule.data;
  if (!data) return null;
  const days = data.hide_unused_days;
  const waiting = days !== null && data.starts_at !== null && Date.parse(data.starts_at) > Date.now();
  return (
    <div className="flex items-start justify-between gap-4 border-t border-line px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">Hide unused facts</p>
        <p className="mt-0.5 text-[13px] text-muted">
          Nocheh’s own rule. It hides a fact when no reply used it and no chat mentioned it again for the number of days
          you choose. Free: it only compares dates, once a day.
        </p>
        <p className="mt-1 text-[13px]">
          {days === null ? 'Off' : `On: after ${days.toLocaleString()} days`}
          {waiting && (
            <span className="text-muted">
              {' '}
              · Nocheh started counting on {day(data.tracking_since)}, so nothing is hidden before{' '}
              {day(data.starts_at!)}
            </span>
          )}
          {!waiting && days !== null && data.last_hidden !== null && data.swept_at && (
            <span className="text-muted">
              {' '}
              · Last check {day(data.swept_at)}: {data.last_hidden.toLocaleString()} hidden
            </span>
          )}
        </p>
      </div>
      <div className="shrink-0">
        <Button size="sm" onClick={() => setEditing(true)}>
          Change
        </Button>
      </div>
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Hide unused facts"
        description="A fact counts as used when a reply used it or a chat mentioned it again. Hidden facts are kept, and you can bring them back."
      >
        <HideUnusedForm rule={data} onSaved={() => setEditing(false)} />
      </Dialog>
    </div>
  );
}

function HideUnusedForm({rule, onSaved}: {rule: CleanUp; onSaved: () => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const saved = rule.hide_unused_days;
  const [on, setOn] = useState(saved !== null);
  const [value, setValue] = useState(String(saved ?? 180));
  const [problem, setProblem] = useState('');
  const changed = on !== (saved !== null) || (on && value.trim() !== String(saved));
  const save = async () => {
    setProblem('');
    let days: number | null = null;
    if (on) {
      days = /^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN;
      if (!(days >= 30 && days <= 3650)) return setProblem('Enter a number of days from 30 to 3650.');
    }
    const result = await command.run<CleanUp>('/memory/clean-up', {
      hide_unused_days: days,
      expected_revision: rule.revision,
    });
    if (result) {
      feedback.toast(
        result.hide_unused_days === null
          ? 'Unused facts are no longer hidden.'
          : `Facts unused for ${result.hide_unused_days} days will be hidden.`,
      );
      onSaved();
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3">
        <Switch
          id="hide-unused-on"
          checked={on}
          label="Hide unused facts"
          onChange={checked => {
            setOn(checked);
            setProblem('');
            command.clear();
          }}
        />
        <label htmlFor="hide-unused-on" className="text-sm">
          Hide unused facts
        </label>
      </div>
      {on && (
        <Field
          label="Days without use"
          htmlFor="hide-unused-days"
          error={problem}
          hint={`From 30 to 3650. Nocheh started counting on ${day(rule.tracking_since)}, so it hides nothing until that many days have passed.`}
        >
          <Input
            id="hide-unused-days"
            inputMode="numeric"
            className="w-28"
            value={value}
            onChange={event => {
              setValue(event.target.value);
              setProblem('');
              command.clear();
            }}
          />
        </Field>
      )}
      <Button type="submit" variant="primary" busy={command.busy} disabled={!changed}>
        Save
      </Button>
      {command.error && <Notice tone="bad">{command.error}</Notice>}
    </form>
  );
}
