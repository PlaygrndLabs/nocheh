import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * Step 4 on the dashboard: other people's private chats with Nocheh stay out of the default Messages list and show only
 * under "Members' chats", named by their person; and the owner-only local laws line is the owner's text, else the
 * built-in one. What a chat is comes from the directory's fields, never from its id.
 */
const load = async entry => {
  const compiled = await build({entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node'});
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};
const {chatFilter, membersChats, otherPrivate, otherPrivateName} = await load('dashboard/pages/messages/chat-names.ts');
const {localLawsLine} = await load('dashboard/pages/members/model.ts');

const chat = (space_id, changes = {}) => ({
  space_id,
  name: null,
  kind: 'private',
  owner: false,
  app_ids: [],
  ...changes,
});
const owner = chat('o'.repeat(64), {owner: true, name: 'Owner'});
const mira = chat('a'.repeat(64), {name: 'Mira Chen', app_ids: [{app: 'telegram', external: '701', state: 'current'}]});
const group = chat('b'.repeat(64), {kind: 'group', name: 'Aurora planning'});
const miraTopic = chat('c'.repeat(64), {kind: 'topic', parent_space: mira.space_id});
const ownerTopic = chat('d'.repeat(64), {kind: 'topic', parent_space: owner.space_id, owner: true});
const groupTopic = chat('e'.repeat(64), {kind: 'topic', parent_space: group.space_id});
const all = [owner, mira, group, miraTopic, ownerTopic, groupTopic];
const find = space => all.find(item => item.space_id === space) ?? null;

test('someone else’s private chat, or a topic of one, is a member’s chat; the owner’s chat and groups are not', () => {
  assert.equal(otherPrivate(mira, find), true);
  assert.equal(otherPrivate(miraTopic, find), true);
  for (const item of [owner, ownerTopic, group, groupTopic, null]) assert.equal(otherPrivate(item, find), false);
  // A topic whose chat the directory doesn't know is not put under a heading by guessing.
  assert.equal(otherPrivate(chat('f'.repeat(64), {kind: 'topic', parent_space: '9'.repeat(64)}), find), false);
});

test('a member’s chat is named by its person, else by its Telegram id, never as a bare name', () => {
  assert.equal(otherPrivateName(mira), 'Mira Chen’s private chat');
  assert.equal(otherPrivateName({...mira, name: '  '}), 'Private chat 701');
  assert.equal(otherPrivateName(chat('9'.repeat(64))), 'A private chat');
});

test('the default list leaves members’ chats out, the filter shows only them, and one chat is asked by itself', () => {
  assert.deepEqual(chatFilter(''), {private_chats: 'hide'});
  assert.deepEqual(chatFilter(membersChats), {private_chats: 'only'});
  assert.deepEqual(chatFilter('-10042'), {scope: '-10042'});
  assert.ok(membersChats.startsWith(':'), 'no chat id starts with a colon');
});

test('the local laws line is the owner’s text, else the built-in one, and nothing before the texts load', () => {
  const key = 'members.local_laws';
  assert.equal(localLawsLine(null), null);
  assert.equal(localLawsLine({defaults: {[key]: ' Check your local laws. '}}), 'Check your local laws.');
  assert.equal(
    localLawsLine({texts: {[key]: 'Ask a lawyer first.'}, defaults: {[key]: 'Check.'}}),
    'Ask a lawyer first.',
  );
  assert.equal(localLawsLine({texts: {}, defaults: {}}), null);
});

test('every member and ask text the owner can edit is listed on Settings › Assistant', async () => {
  const {readFileSync} = await import('node:fs');
  const page = readFileSync('dashboard/pages/settings/instructions.tsx', 'utf8');
  for (const key of ['reply.member', 'telegram.member_private_daily_limit', 'telegram.not_allowed_private', 'members.local_laws',
    'reply.member_read', 'telegram.member_read', 'telegram.member_read_texts', 'members.reminder', 'members.reminder_texts'])
    assert.ok(page.includes(`key: '${key}'`), key);
});
