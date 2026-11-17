import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * The Members page and a group's "Members here" card (step 3): names filled from what Telegram showed, what a member may
 * do in one group, and what an add sends. A member's group with no switch counts as on, so an add sends every group the
 * owner saw, unticked ones as off.
 */
const compiled = await build({
  entryPoints: ['dashboard/pages/members/model.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {addGroups, groupSummary, inGroup, knownPeople, memberError, memberHere, personMeta, personName, presenceLabel} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

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

test('an add sends every group the owner saw: ticked on, unticked off', () => {
  assert.deepEqual(addGroups([GP1, GP2, GP3], new Set([GP1, GP3])), {[GP1]: true, [GP2]: false, [GP3]: true});
  assert.deepEqual(addGroups([GP1], new Set()), {[GP1]: false}, 'the route refuses an add with nothing on');
});

test('a refusal from the Members routes is said in plain words', () => {
  assert.match(memberError(new Error('member_group_not_seen')), /Telegram hasn’t shown this person in that group yet/);
  assert.equal(memberError(new Error('member_exists')), 'This person is already a member.');
  assert.match(memberError(new Error('owner_command_conflict')), /changed somewhere else/);
  assert.match(memberError(new Error('something_else')), /something else/);
});
