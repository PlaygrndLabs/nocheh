/**
 * How Nocheh suggests sharing a fact into a chat: whether it asks at all, how
 * long a request waits, and what happens after you approve. Used for the
 * defaults and for one chat's own settings.
 */
import {useId, useState} from 'react';
import {refreshResources, useResource} from '../../lib/resource';
import {lifetimeChoices, lifetimeLabel} from '../../lib/chats-model';
import {Badge, Button, LoadError, Notice, Segmented, Select, Skeleton, Switch} from '../../ui/core';
import {ActionError, useAction} from './shared';

type Values = {
  suggestions: 'related' | 'off';
  notify_owner: boolean;
  auto_followup: boolean;
  request_ttl_seconds: number;
  default_grant_mode: 'one_time' | 'persistent';
};
type Row = Partial<Values> & {destination: string; revision: number};
type ForChat = {
  destination: string;
  global: Values;
  override: Partial<Values> | null;
  effective: Values;
  revision: number;
};

const keys: (keyof Values)[] = [
  'suggestions',
  'notify_owner',
  'auto_followup',
  'request_ttl_seconds',
  'default_grant_mode',
];
const same = (a: Values, b: Values) => keys.every(key => a[key] === b[key]);

/** The defaults every chat uses unless it has its own. */
export function DefaultSuggestions() {
  const resource = useResource<{settings: Row[]}>('/memory-access/settings');
  const global = resource.data?.settings.find(row => row.destination === '*');
  if (resource.error && !resource.data)
    return <LoadError what="suggestion settings" onRetry={() => void refreshResources()} />;
  if (!resource.data) return <Skeleton className="h-48 w-full" />;
  if (!global) return <Notice tone="warn">Suggestion defaults aren’t set up yet on this installation.</Notice>;
  const values = Object.fromEntries(keys.map(key => [key, global[key]])) as Values;
  return (
    <SuggestionForm
      key={global.revision}
      initial={values}
      onSave={(next, run) =>
        run(
          'save',
          '/memory-access/settings',
          {destination: '*', ...next, expected_revision: global.revision},
          {
            success: 'Suggestion defaults saved.',
          },
        )
      }
    />
  );
}

/** One chat's settings: the defaults, or its own when you change them here. */
export function ChatSuggestions({space}: {space: string}) {
  const resource = useResource<ForChat>('/memory-access/settings?destination=' + encodeURIComponent(space));
  const action = useAction();
  const data = resource.data;
  if (resource.error && !data) return <LoadError what="suggestion settings" onRetry={() => void refreshResources()} />;
  if (!data) return <Skeleton className="h-48 w-full" />;
  const custom = !!data.override && Object.keys(data.override).length > 0;
  // A chat's first own settings start at revision 1; after that the saved revision is expected.
  const expected = data.override ? data.revision : 1;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={custom ? 'accent' : 'neutral'}>
          {custom ? 'Own settings for this chat' : 'Uses your defaults'}
        </Badge>
        {custom && (
          <Button
            size="sm"
            variant="ghost"
            busy={action.busy === 'reset'}
            onClick={() =>
              void action.run(
                'reset',
                '/memory-access/settings',
                {destination: space, expected_revision: expected},
                {success: 'This chat uses your defaults again.'},
              )
            }
          >
            Use defaults
          </Button>
        )}
      </div>
      <ActionError text={action.error} />
      <SuggestionForm
        key={space + ':' + data.revision + ':' + custom}
        initial={data.effective}
        onSave={(next, run) =>
          run(
            'save',
            '/memory-access/settings',
            {destination: space, ...next, expected_revision: expected},
            {
              success: 'Saved for this chat.',
            },
          )
        }
      />
    </div>
  );
}

function SuggestionForm({
  initial,
  onSave,
}: {
  initial: Values;
  onSave: (values: Values, run: ReturnType<typeof useAction>['run']) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Values>(initial);
  const action = useAction();
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues(current => ({...current, [key]: value}));
  const changed = !same(values, initial);
  const lifetimes = lifetimeChoices.some(choice => choice.seconds === values.request_ttl_seconds)
    ? lifetimeChoices
    : [...lifetimeChoices, {seconds: values.request_ttl_seconds, label: lifetimeLabel(values.request_ttl_seconds)}];
  const off = values.suggestions === 'off';
  const row = 'flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6';
  const id = useId();
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void onSave(values, action.run);
      }}
    >
      <div className="divide-y divide-line">
        <div className={row}>
          <div className="min-w-0">
            <label htmlFor={id + '-suggest'} className="text-sm font-medium">
              Suggest facts from other chats
            </label>
            <p className="text-[13px] text-muted">When a fact could help here, Nocheh asks you first in the Inbox.</p>
          </div>
          <Switch
            id={id + '-suggest'}
            checked={!off}
            onChange={value => set('suggestions', value ? 'related' : 'off')}
            label="Suggest facts from other chats"
          />
        </div>
        <div className={row}>
          <p className="text-sm font-medium">Usual approval</p>
          <Segmented
            size="sm"
            label="Usual approval"
            value={values.default_grant_mode}
            disabled={off}
            options={[
              {value: 'one_time', label: 'For one reply'},
              {value: 'persistent', label: 'Until revoked'},
            ]}
            onChange={value => set('default_grant_mode', value)}
          />
        </div>
        <div className={row}>
          <label htmlFor={id + '-ttl'} className="text-sm font-medium">
            A request waits for you
          </label>
          <Select
            id={id + '-ttl'}
            className="sm:w-40"
            value={String(values.request_ttl_seconds)}
            disabled={off}
            onChange={event => set('request_ttl_seconds', Number(event.target.value))}
          >
            {lifetimes.map(choice => (
              <option key={choice.seconds} value={choice.seconds}>
                {choice.label}
              </option>
            ))}
          </Select>
        </div>
        <div className={row}>
          <div className="min-w-0">
            <label htmlFor={id + '-notify'} className="text-sm font-medium">
              Tell me about new requests
            </label>
            <p className="text-[13px] text-muted">A short note in your private chat, without the fact itself.</p>
          </div>
          <Switch
            id={id + '-notify'}
            checked={values.notify_owner}
            disabled={off}
            onChange={value => set('notify_owner', value)}
            label="Tell me about new requests"
          />
        </div>
        <div className={row}>
          <div className="min-w-0">
            <label htmlFor={id + '-followup'} className="text-sm font-medium">
              Answer right after I approve
            </label>
            <p className="text-[13px] text-muted">Nocheh posts its follow-up in the chat on its own.</p>
          </div>
          <Switch
            id={id + '-followup'}
            checked={values.auto_followup}
            disabled={off}
            onChange={value => set('auto_followup', value)}
            label="Answer right after I approve"
          />
        </div>
      </div>
      <ActionError text={action.error} />
      {changed && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setValues(initial)} disabled={!!action.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy === 'save'}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
