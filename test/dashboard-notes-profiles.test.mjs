import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * Memory › Notes after a reinstall: a chat keeps one profile per setup, and the base one may never have been written.
 * The page opens on your private chat's current notes and names the others as earlier ones.
 */
const compiled = await build({entryPoints: ['dashboard/pages/memory/notes-profiles.ts'], bundle: true, write: false, format: 'esm', platform: 'node'});
const {notesProfiles, earlierSuffix} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const base = {scope: '42', profile: 'base-own', owner: true, exists: false, latest: false};
const old = {scope: '42', profile: 'nocheh-' + 'a1'.repeat(12), owner: true, exists: true, guard_epoch: 2, latest: false};
const older = {scope: '42', profile: 'nocheh-' + 'a0'.repeat(12), owner: true, exists: true, guard_epoch: 1, latest: false};
const now = {scope: '42', profile: 'nocheh-' + 'b2'.repeat(12), owner: true, exists: true, guard_epoch: 5, latest: true};
const group = {scope: '-10', profile: 'nocheh-' + 'c3'.repeat(12), owner: false, exists: true, guard_epoch: 5, latest: true};
const answer = {scope: '42', profile: 'nocheh-' + 'd4'.repeat(12), owner: false, exists: true, private_answer: true};
const member = {scope: '73', profile: 'nocheh-' + 'e5'.repeat(12), owner: false, exists: true, member: true, latest: true};
const ask = {scope: '42', profile: 'nocheh-' + 'f6'.repeat(12), owner: false, exists: true, member_read: true};

test('the page opens on your private chat’s current notes, not an empty or earlier setup', () => {
  const {list, first} = notesProfiles([base, old, member, ask, now, group, older, answer]);
  assert.equal(first.profile, now.profile);
  assert.deepEqual(
    list.map(p => p.profile),
    [now, older, old, answer, group, ask, member].map(p => p.profile),
    'current first, earlier ones oldest first, the never-written base left out, members last',
  );
  assert.equal(earlierSuffix(now, list), '');
  assert.equal(earlierSuffix(older, list), ' · earlier notes 1');
  assert.equal(earlierSuffix(old, list), ' · earlier notes 2');
  assert.equal(earlierSuffix(answer, list), '', 'a private answer is never an earlier setup');
});

test('a single earlier setup reads plainly, and a listing from before the latest mark keeps its order', () => {
  const {list} = notesProfiles([old, now]);
  assert.equal(earlierSuffix(old, list), ' · earlier notes');
  const plain = [{scope: '42', profile: 'own', owner: true}, {scope: '-10', profile: 'g', owner: false}];
  const before = notesProfiles(plain);
  assert.deepEqual(before.list.map(p => p.profile), ['own', 'g']);
  assert.equal(before.first.profile, 'own', 'with no setup marks the first chat still opens');
  assert.equal(earlierSuffix(plain[0], before.list), '');
});

test('a private answer listed between earlier setups stays after them', () => {
  const e5 = {...old, profile: 'e5', guard_epoch: 5};
  const e1 = {...old, profile: 'e1', guard_epoch: 1};
  const current = {...now, guard_epoch: 2};
  const {list, first} = notesProfiles([e5, answer, e1, current]);
  assert.equal(first.profile, current.profile);
  assert.deepEqual(list.map(p => p.profile), [current.profile, 'e1', 'e5', answer.profile]);
  assert.equal(earlierSuffix(e1, list), ' · earlier notes 1');
  assert.equal(earlierSuffix(e5, list), ' · earlier notes 2');
});

test('a chat whose only profile was never written is still listed', () => {
  const {list, first} = notesProfiles([{...base, latest: undefined}, group]);
  assert.deepEqual(list.map(p => p.profile), ['base-own', group.profile]);
  assert.equal(first.profile, 'base-own');
});
