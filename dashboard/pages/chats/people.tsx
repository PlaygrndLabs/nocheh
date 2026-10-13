/** "Who can talk to Nocheh" in one group: you always, everyone else by choice. */
import {useState} from 'react';
import {UserPlus} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {isAllowed, validUserId, type IdentityGroup, type Person} from '../../lib/chats-model';
import {Badge, Button, Card, CardBody, CardHeader, Field, Input, Segmented} from '../../ui/core';
import {Unsaved, type Telegram} from './shared';

export function WhoCanTalk({group, telegram}: {group: string; telegram: Telegram}) {
  const identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities', 60000);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState('');
  const on = telegram.isOn(group);
  const rule = telegram.rule(group);
  const savedRule = telegram.savedRule(group);
  const owner = telegram.owner;

  const known = new Map<string, Person>(
    (identities.data?.groups ?? []).flatMap(item => item.users ?? []).map(user => [user.id, user]),
  );
  const name = (id: string) => known.get(id)?.name || known.get(id)?.username || 'Unknown person';
  const meta = (id: string) => {
    const person = known.get(id);
    return [person?.username && person.username !== person.name ? person.username : null, 'ID ' + id]
      .filter(Boolean)
      .join(' · ');
  };
  const people = [
    ...new Set<string>([
      ...(identities.data?.groups.find(item => item.id === group)?.users ?? []).map(user => user.id),
      ...rule.granted,
      ...rule.denied,
      ...savedRule.granted,
      ...savedRule.denied,
    ]),
  ]
    .filter(id => id !== owner)
    .sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));
  const allowedCount = people.filter(id => isAllowed(rule, id)).length;

  const add = () => {
    const id = manual.trim();
    if (!validUserId(id)) return setManualError('A Telegram user ID is a number, like 123456789.');
    if (id === owner) return setManualError('That’s you. You can always talk to Nocheh.');
    telegram.setPerson(group, id, true);
    setManual('');
    setManualError('');
  };

  return (
    <Card>
      <CardHeader
        title="Who can talk to Nocheh"
        description={
          on
            ? allowedCount
              ? `You and ${allowedCount} ${allowedCount === 1 ? 'other person' : 'others'}.`
              : 'Only you, so far.'
            : undefined
        }
      />
      <CardBody className="pt-3">
        {!on ? (
          <p className="text-sm text-muted">Turn Nocheh on in this group to choose who may talk to it.</p>
        ) : (
          <>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {owner && (
                <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" dir="auto">
                      {known.get(owner)?.name || 'You'}
                    </p>
                    <p className="text-xs text-muted">{meta(owner)}</p>
                  </div>
                  <Badge tone="good">You · always allowed</Badge>
                </li>
              )}
              {people.map(id => {
                const allowed = isAllowed(rule, id);
                return (
                  <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium" dir="auto">
                          {name(id)}
                        </p>
                        <Unsaved show={allowed !== isAllowed(savedRule, id)} />
                      </div>
                      <p className="text-xs text-muted">{meta(id)}</p>
                    </div>
                    <Segmented
                      size="sm"
                      label={'Can ' + name(id) + ' talk to Nocheh'}
                      value={allowed ? 'yes' : 'no'}
                      disabled={!telegram.loaded || telegram.busy}
                      options={[
                        {value: 'no', label: 'Not allowed'},
                        {value: 'yes', label: 'Allowed'},
                      ]}
                      onChange={value => telegram.setPerson(group, id, value === 'yes')}
                    />
                  </li>
                );
              })}
            </ul>
            {!people.length && (
              <p className="mt-3 text-[13px] text-muted">
                Nobody else is known here yet. People appear once Nocheh sees them write in this group.
              </p>
            )}
            {identities.error && (
              <p className="mt-3 text-[13px] text-muted">
                Names of people in this group couldn’t be loaded. You can still add someone by user ID.
              </p>
            )}
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={event => {
                event.preventDefault();
                add();
              }}
            >
              <Field
                label="Allow someone by Telegram user ID"
                htmlFor={'allow-' + group}
                error={manualError}
                className="min-w-0 flex-1 basis-56"
              >
                <Input
                  id={'allow-' + group}
                  inputMode="numeric"
                  value={manual}
                  placeholder="e.g. 123456789"
                  disabled={!telegram.loaded || telegram.busy}
                  onChange={event => {
                    setManual(event.target.value);
                    setManualError('');
                  }}
                />
              </Field>
              <Button type="submit" disabled={!manual.trim() || !telegram.loaded || telegram.busy}>
                <UserPlus aria-hidden /> Allow
              </Button>
            </form>
          </>
        )}
      </CardBody>
    </Card>
  );
}
