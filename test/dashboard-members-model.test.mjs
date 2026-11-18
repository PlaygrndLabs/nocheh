import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * The Members page and a group's "Members here" card (step 3): names filled from what Telegram showed, what a member may
 * do in one group, and what an add sends. A member's group with no switch counts as on, so an add sends every group the
 * owner saw, unticked ones as off.
 */
const load = async entry => {
  const compiled = await build({entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node'});
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};
const {
  addGroups,
  groupSummary,
  inGroup,
  knownPeople,
  memberError,
  memberHere,
  personMeta,
  personName,
  presenceLabel,
  withAnswers,
} = await load('dashboard/pages/members/model.ts');
const {replyStatus} = await load('dashboard/lib/messages-format.ts');
const {problemText} = await load('dashboard/pages/inbox/shared.ts');

const GP1 = 'a'.repeat(64),
  GP2 = 'b'.repeat(64),
  GP3 = 'c'.repeat(64);
const group = (chat_id, changes = {}) => ({
  chat_id,
  title: 'Group ' + chat_id[0],
  state: 'active',
  on: true,
  telegram: 'in',
  new: false,
  ...changes,
});
const member = (changes = {}) => ({
  id: 'd'.repeat(64),
  account_id: 'e'.repeat(64),
  state: 'active',
  name: 'Mira Chen',
  username: 'mira',
  telegram_id: '701',
  owner_linked: false,
  added_at: '2026-11-10T09:00:00.000Z',
  permissions: {talk: true, jobs: true, post: true, tools: true, tasks: 'write'},
  groups: [group(GP1), group(GP2, {on: false}), group(GP3, {new: true})],
  ...changes,
});

test('a member or person is named by their own name, then Telegram’s, then their @username, then their ID', () => {
  const known = knownPeople([
    {id: GP1, users: [{id: '702', name: null, username: '@omar'}]},
    {id: GP2, users: [{id: '702', name: 'Omar Haddad', username: null, member: true, seen: false, state: null}]},
  ]);
  assert.deepEqual(
    [known.get('702').name, known.get('702').username],
    ['Omar Haddad', '@omar'],
    'one entry, both kept',
  );
  const carried = {name: null, username: null, telegram_id: '702'};
  assert.equal(personName(carried, known), 'Omar Haddad', 'a carried member who never wrote shows by name');
  assert.equal(personMeta(carried, known), '@omar · ID 702');
  assert.equal(personName({name: ' ', username: 'mira', telegram_id: '701'}), '@mira');
  assert.equal(
    personMeta({name: null, username: '@mira', telegram_id: '701'}),
    'ID 701',
    'the handle is the name already',
  );
  assert.equal(personName({name: null, username: null, telegram_id: '703'}), 'Telegram ID 703');
  assert.equal(personName({name: null, username: null, telegram_id: null}), 'Unknown person');
});

test('a group with no switch is on, so New here is information only', () => {
  assert.equal(groupSummary(member()), '2 of 3 groups on · 1 new here');
  assert.equal(groupSummary(member({groups: [group(GP1)]})), '1 of 1 group on');
  assert.deepEqual(memberHere(member(), GP3), {label: 'Can talk here', tone: 'good', group: group(GP3, {new: true})});
  assert.equal(memberHere(member(), GP2).label, 'Off here');
  assert.equal(memberHere(member(), 'f'.repeat(64)), null, 'no switch and no Telegram row there: not listed');
  // Paused, or talk off, wins over a group's own switch; each switch keeps its value.
  assert.equal(memberHere(member({state: 'paused'}), GP1).label, 'Paused');
  assert.equal(
    memberHere(member({permissions: {...member().permissions, talk: false}}), GP1).label,
    'Talk switched off',
  );
  // Telegram says they left: not someone who can talk here, whatever their switch, paused or not.
  assert.equal(memberHere(member({groups: [group(GP1, {telegram: 'left'})]}), GP1).label, 'Left the group');
  assert.equal(
    memberHere(member({state: 'paused', groups: [group(GP1, {telegram: 'left'})]}), GP1).label,
    'Left the group',
  );
  assert.deepEqual(presenceLabel('left'), ['Left the group (Telegram says)', 'warn']);
  assert.deepEqual(presenceLabel(null), ['Nothing from Telegram yet', 'neutral']);
});

test('a group’s card lists the members and the people Telegram or a switch puts there', () => {
  const person = {
    account_id: '1'.repeat(64),
    name: 'Nia',
    username: null,
    telegram_id: '704',
    groups: [{chat_id: GP1, title: 'G', state: 'active'}],
  };
  const list = {
    revision: 1,
    daily_messages: 200,
    groups: [],
    members: [member(), member({id: '9'.repeat(64), groups: [group(GP2)]})],
    people: [person],
  };
  const here = inGroup(list, GP1);
  assert.deepEqual([here.members.length, here.people.length], [1, 1]);
  assert.deepEqual([inGroup(list, GP2).members.length, inGroup(list, GP2).people.length], [2, 0]);
  assert.deepEqual(inGroup(null, GP1), {members: [], people: []});
});

test('a group’s card leaves out a member Telegram never showed there with the group off, and one who left', () => {
  const named = (name, groups) => member({id: name.repeat(64), name, groups});
  const list = {
    revision: 1,
    daily_messages: 200,
    groups: [],
    members: [
      // Carried from the lists before step 3 with this group off, or left unticked on an add: never seen here.
      named('1', [group(GP1, {on: false, telegram: null})]),
      // Telegram says they left, switch on or off.
      named('2', [group(GP1, {telegram: 'left'})]),
      named('3', [group(GP1, {on: false, telegram: 'left'})]),
      // Seen here and switched off: off here. Switched on and never seen (added by ID): may talk from their first message.
      named('4', [group(GP1, {on: false})]),
      named('5', [group(GP1, {telegram: null})]),
    ],
    people: [],
  };
  const here = inGroup(list, GP1).members;
  assert.deepEqual(
    here.map(item => [item.name, memberHere(item, GP1).label]),
    [
      ['4', 'Off here'],
      ['5', 'Can talk here'],
    ],
  );
});

test('what a change answers shows over the list until the list has it', () => {
  const nia = member({id: '9'.repeat(64), account_id: '1'.repeat(64), name: 'Nia', groups: [group(GP1)]});
  const person = {account_id: nia.account_id, name: 'Nia', username: null, telegram_id: '704', groups: []};
  const list = {revision: 4, daily_messages: 200, groups: [], members: [member()], people: [person]};
  assert.equal(withAnswers(list, []), list);
  assert.equal(withAnswers(null, [{revision: 5, daily_messages: 150}]), null);
  // Added, then switched off in a group, then the cap: each shows at once, the new member no longer among the people.
  const paused = {...nia, state: 'paused'};
  const shown = withAnswers(list, [
    {revision: 7, daily_messages: 150},
    {revision: 6, member: paused},
    {revision: 5, member: nia},
  ]);
  assert.deepEqual(
    shown.members.map(item => [item.name, item.state]),
    [
      ['Mira Chen', 'active'],
      ['Nia', 'paused'],
    ],
    'oldest first, so the newest answer for a member wins',
  );
  assert.deepEqual([shown.people, shown.daily_messages], [[], 150]);
  assert.deepEqual(
    withAnswers(list, [{revision: 5, removed: member().id}]).members,
    [],
    'a removed member goes at once',
  );
  // A list that has caught up, or a receipt replayed from before it, wins over the answer.
  assert.equal(withAnswers({...list, revision: 7}, [{revision: 7, daily_messages: 150}]).daily_messages, 200);
  assert.equal(withAnswers(list, [{revision: 3, member: paused}]).members.length, 1);
});

test('an add sends every group the owner saw: ticked on, unticked off', () => {
  assert.deepEqual(addGroups([GP1, GP2, GP3], new Set([GP1, GP3])), {[GP1]: true, [GP2]: false, [GP3]: true});
  assert.deepEqual(addGroups([GP1], new Set()), {[GP1]: false}, 'the route refuses an add with nothing on');
});

test('a member’s message past the daily cap, and a member’s send closed after a change, say why', () => {
  const capped = {
    kind: 'telegram_update',
    scope: '-10042',
    assistant_state: 'suppressed',
    assistant_error: 'member_daily_limit',
  };
  assert.deepEqual(replyStatus(capped), {
    label: 'Daily limit reached',
    tone: 'neutral',
    note: 'Member’s daily cap; set on the Members page',
  });
  assert.equal(
    problemText('member_changed'),
    'Not sent: the member who asked was paused or removed, or a switch for them was turned off.',
  );
  assert.match(problemText('action_revision_changed'), /changed somewhere else/);
});

test('a refusal from the Members routes is said in plain words', () => {
  assert.match(memberError(new Error('member_group_not_seen')), /Telegram hasn’t shown this person in that group yet/);
  assert.equal(memberError(new Error('member_exists')), 'This person is already a member.');
  assert.match(memberError(new Error('owner_command_conflict')), /changed somewhere else/);
  assert.match(memberError(new Error('something_else')), /something else/);
});
