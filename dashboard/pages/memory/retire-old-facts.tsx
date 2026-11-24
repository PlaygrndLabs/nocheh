/**
 * Memory › Long-term › Status and limits: the "Clean up" card. "Retire old facts" is Honcho's dreams (ADR-0298), saved
 * with the page and applied by restarting long-term memory. "Hide unused facts" is Nocheh's own rule (ADR-0299), saved
 * at once in its dialog. Both are off by default, and both only hide facts, which can be brought back.
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
        title="Clean up"
        description="Long-term memory can hide facts it no longer needs. A hidden fact is kept, not deleted, and you can bring it back under Facts it learned."
        className="pb-3"
      />
      {/* Its own rows: the card sits in the narrow column, where a setting row's wide control would crush the text. */}
      {field && (
        <div className="flex items-start justify-between gap-4 border-t border-line px-5 py-4">
          <div className="min-w-0">
            <label htmlFor="memory-retire-old-facts" className="block text-sm font-medium">
              Retire old facts
              <Unsaved show={s.changed(retireKey)} />
            </label>
            <p className="mt-0.5 text-[13px] text-muted">
              Hides facts that newer ones replaced. Runs on its own after about 50 new facts, at most every 8 hours,
              once a chat has been quiet for an hour. Your whole memory and each group’s memory are cleaned up
              separately.
            </p>
            <p className="mt-1 text-[13px] text-muted">
              Extra cost: each clean-up is up to about 22 calls to the memory model, and it counts toward the memory
              thinking limit.
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Switch
              id="memory-retire-old-facts"
              label="Retire old facts"
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
          Hides a fact when no reply used it and no chat said it again for a set number of days. Checked once a day,
          with no extra cost.
        </p>
        <p className="mt-1 text-[13px]">
          {days === null ? 'Off' : `After ${days.toLocaleString()} days`}
          {waiting && (
            <span className="text-muted">
              {' '}
              · Nocheh tracks use since {day(data.tracking_since)}, so nothing is hidden before {day(data.starts_at!)}
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
        description="A fact counts as used when a reply read it or a chat said it again. Hidden facts are kept, and you can bring them back."
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
          hint={`From 30 to 3650. Nocheh has tracked use since ${day(rule.tracking_since)} and hides nothing before it has watched that long.`}
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
