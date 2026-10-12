import {useState} from 'react';
import {participantAllowed, switchDecision} from '../../lib/group-access';
import {useResource} from '../../lib/resource';
import {Button} from '../../components/ui/primitives';
import type {AccessRule, TelegramSettings} from './telegram-settings';

type Identity = {id: string; name?: string; username?: string};
type IdentityGroup = {id: string; name?: string; users?: Identity[]};

const validUser = (id: string) => /^[1-9]\d{0,18}$/.test(id);

/** Who besides the owner may talk to Nocheh in one group. Each switch saves at once. */
export function GroupPeople({group, telegram}: {group: string; telegram: TelegramSettings}) {
  const identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities');
  const [manual, setManual] = useState('');
  const observed = identities.data?.groups ?? [];
  const users = new Map<string, Identity>(observed.flatMap(item => item.users ?? []).map(user => [user.id, user]));
  const rule = telegram.ruleFor(group) as AccessRule;
  const owner = telegram.owner;
  const name = (id: string) => users.get(id)?.name || users.get(id)?.username || 'Unknown person';
  const meta = (id: string) => {
    const found = users.get(id);
    return [found?.name && found.username !== found.name ? found.username : null, 'ID ' + id]
      .filter(Boolean)
      .join(' · ');
  };
  const people = [
    ...new Set<string>([
      ...(observed.find(item => item.id === group)?.users ?? []).map(user => user.id),
      ...rule.granted,
      ...rule.denied,
    ]),
  ]
    .filter(id => id !== owner)
    .sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));

  const change = async (id: string, allow: boolean) => {
    const decision = switchDecision(rule, rule, id, allow);
    if (!decision) return;
    const granted = rule.granted.filter(item => item !== id),
      denied = rule.denied.filter(item => item !== id);
    if (decision === 'grant') granted.push(id);
    if (decision === 'deny') denied.push(id);
    const next = {...telegram.access};
    if (granted.length || denied.length) next[group] = {granted: granted.sort(), denied: denied.sort()};
    else delete next[group];
    await telegram.save(
      {TELEGRAM_GROUP_ACCESS: JSON.stringify(next)},
      (allow ? name(id) + ' may now talk to Nocheh here.' : name(id) + ' can no longer talk to Nocheh here.') +
        ' Apply saved settings for it to take effect.',
    );
  };

  return (
    <div className="n-access-directory">
      <div className="n-access-directory-head">
        <b>People in this group</b>
        <small>
          {people.filter(id => participantAllowed(rule, id)).length +
            ' allowed · ' +
            people.filter(id => !participantAllowed(rule, id)).length +
            ' not allowed'}
        </small>
      </div>
      {identities.error && (
        <p role="status" className="n-muted">
          Names of people Nocheh has seen are unavailable. You can still add someone by their Telegram user ID.
        </p>
      )}
      <ul className="n-access-people">
        {owner && (
          <li className="n-access-person n-access-owner">
            <div className="n-access-person-name">
              <strong>{name(owner)}</strong>
              <small>{meta(owner)}</small>
            </div>
            <span className="n-access-owner-badge">You · always allowed</span>
          </li>
        )}
        {people.map(id => (
          <li className="n-access-person" key={id}>
            <div className="n-access-person-name">
              <strong>{name(id)}</strong>
              <small>{meta(id)}</small>
            </div>
            <div className="n-access-choice" role="group" aria-label={'Who may talk to Nocheh: ' + name(id)}>
              {[false, true].map(allow => (
                <button
                  type="button"
                  key={String(allow)}
                  disabled={telegram.busy}
                  aria-pressed={participantAllowed(rule, id) === allow}
                  onClick={() => void change(id, allow)}
                >
                  {allow ? 'Allowed' : 'Not allowed'}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {!people.length && (
        <p className="n-muted n-access-empty">
          Nobody else is known in this group yet. People appear after Nocheh sees them; Telegram also lists group
          admins.
        </p>
      )}
      <form
        className="n-access-manual-fields"
        onSubmit={async event => {
          event.preventDefault();
          if (validUser(manual.trim()) && manual.trim() !== owner) {
            await change(manual.trim(), true);
            setManual('');
          }
        }}
      >
        <div className="n-field">
          <label htmlFor={'allow-user-' + group}>Allow someone by Telegram user ID</label>
          <input
            id={'allow-user-' + group}
            inputMode="numeric"
            value={manual}
            disabled={telegram.busy}
            placeholder="Numeric user ID"
            onChange={event => setManual(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={telegram.busy || !validUser(manual.trim()) || manual.trim() === owner}>
          Allow
        </Button>
      </form>
    </div>
  );
}
