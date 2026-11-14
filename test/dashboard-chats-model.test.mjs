import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * The Chats page reads what a chat is from the chat directory's fields on /conversations (ADR-0250), never from its
 * id: an id is Nocheh's own, a stored value for a chat seen before step 2b and a digest for one seen later.
 */
const compiled = await build({
  entryPoints: ['dashboard/lib/chats-model.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const model = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const {
  accessKey,
  appIdLabel,
  chatName,
  chatTree,
  currentAppId,
  groupListed,
  groupOf,
  isGroupChat,
  parentOf,
  sourceHits,
  unknownChat,
  withGroupListed,
} = model;

const NEW = 'a'.repeat(64),
  NEW_TOPIC = 'b'.repeat(64),
  UPGRADED = 'c'.repeat(64);
const tg = (external, state = 'current') => ({app: 'telegram', external, state});
const chats = [
  {space_id: '42', name: 'Owner', kind: 'private', owner: true, app_ids: [tg('42')], state: 'active'},
  {space_id: '73', name: null, kind: 'private', owner: false, app_ids: [tg('73')], state: 'active'},
  // A group Nocheh knew before step 2b keeps its stored value as its id, and one of its topics.
  {space_id: '-10042', name: 'Aurora planning', kind: 'group', app_ids: [tg('-10042')], is_forum: true, state: 'active'},
  {
    space_id: '-10042/topic/9',
    name: null,
    kind: 'topic',
    parent_space: '-10042',
    topic_key: '9',
    app_ids: [tg('-10042')],
    state: 'active',
  },
  {
    space_id: '-10042/topic/7',
    name: 'Iceland planning',
    kind: 'topic',
    parent_space: '-10042',
    topic_key: '7',
    app_ids: [tg('-10042')],
    state: 'active',
  },
  // A group first seen later has a digest id; its topic too.
  {space_id: NEW, name: null, kind: 'group', app_ids: [tg('-10088')], is_forum: true, state: 'off'},
  {
    space_id: NEW_TOPIC,
    name: 'Meteor watch',
    kind: 'topic',
    parent_space: NEW,
    topic_key: '3',
    app_ids: [tg('-10088')],
    state: 'off',
  },
  // A group Telegram upgraded keeps its id under its new Telegram id.
  {space_id: UPGRADED, name: 'Garden swap', kind: 'group', app_ids: [tg('-10099'), tg('-4005', 'old')], state: 'off'},
];
const find = space => chats.find(chat => chat.space_id === space) ?? null;

test('a chat is named from the directory, and a digest id is never shown', () => {
  assert.equal(chatName(find('42')), 'You');
  assert.equal(chatName(find('73')), 'Private chat 73');
  assert.equal(chatName(find('-10042/topic/9')), 'Topic 9');
  assert.equal(chatName(find(NEW)), 'Unnamed group');
  assert.equal(chatName(unknownChat(NEW)), 'Unknown chat');
  assert.equal(chatName(unknownChat('-10042')), 'Unknown chat', 'an id the directory lacks is read for nothing');
  assert.equal(chatName({...find('73'), app_ids: []}), 'Private chat');
  assert.equal(chatName(null), 'Unknown chat');
  for (const chat of chats) assert.ok(!/[0-9a-f]{64}/.test(chatName(chat)), chat.space_id);
});

test('the Telegram ID label shows the current id and, after an upgrade, the earlier one', () => {
  assert.equal(appIdLabel(find('-10042')), 'Telegram ID -10042');
  assert.equal(appIdLabel(find(UPGRADED)), 'Telegram ID -10099 · earlier -4005');
  assert.equal(currentAppId(find(UPGRADED)), '-10099');
  assert.equal(appIdLabel(unknownChat(NEW)), null);
});

test('a group and its topics are told apart by kind and parent, and anything unknown counts as private', () => {
  assert.equal(parentOf(find(NEW_TOPIC)), NEW);
  assert.equal(parentOf(find(NEW)), null);
  assert.equal(groupOf(find(NEW_TOPIC), find), NEW);
  assert.equal(groupOf(find('-10042'), find), '-10042');
  assert.equal(isGroupChat(find(NEW_TOPIC), find), true);
  assert.equal(isGroupChat(find('42'), find), false);
  assert.equal(isGroupChat(unknownChat('-10073'), find), false, 'an id shaped like a group is not one');
  // A topic whose parent the directory does not know is no group's.
  assert.equal(isGroupChat({...find(NEW_TOPIC), parent_space: 'd'.repeat(64)}, find), false);
  // A private chat's topic is not a group's either.
  assert.equal(
    isGroupChat({space_id: 'e'.repeat(64), name: null, kind: 'topic', parent_space: '42', topic_key: '2'}, find),
    false,
  );
});

test('the tree puts your chat first, served groups next, and topics under their group in Telegram order', () => {
  const served = chat => groupListed(['-4005'], chat) || chat.space_id === '-10042';
  const tree = chatTree(chats, [{id: '-10073', name: 'Weekend notes'}, {id: '-10099'}], served, '');
  assert.deepEqual(
    tree.privates.map(chat => chat.space_id),
    ['42', '73'],
  );
  assert.deepEqual(
    tree.groups.map(entry => entry.group.space_id),
    ['-10042', UPGRADED, NEW, '-10073'],
    'served first, then by name; a group seen only by its Telegram ID is not listed twice',
  );
  assert.deepEqual(
    tree.groups[0].topics.map(chat => chat.space_id),
    ['-10042/topic/7', '-10042/topic/9'],
  );
  assert.deepEqual(
    tree.groups[2].topics.map(chat => chat.space_id),
    [NEW_TOPIC],
  );
  // A search finds a chat by a Telegram ID it has had, and a topic by name under its group.
  const old = chatTree(chats, [], served, '-4005');
  assert.deepEqual(
    old.groups.map(entry => entry.group.space_id),
    [UPGRADED],
  );
  const topic = chatTree(chats, [], served, 'meteor');
  assert.deepEqual(
    topic.groups.map(entry => [entry.group.space_id, entry.topics.map(chat => chat.space_id)]),
    [[NEW, [NEW_TOPIC]]],
  );
});

test('until step 2b-2 a group is served by its Telegram IDs in TELEGRAM_GROUP_IDS', () => {
  assert.equal(groupListed(['-4005'], find(UPGRADED)), true, 'an old id still lists the upgraded group');
  assert.equal(groupListed(['-10042'], find(NEW)), false);
  assert.deepEqual(withGroupListed(['-10042'], find(NEW), true), ['-10042', '-10088']);
  assert.deepEqual(withGroupListed(['-4005'], find(UPGRADED), true), ['-4005'], 'already listed');
  assert.deepEqual(withGroupListed(['-10042', '-4005', '-10099'], find(UPGRADED), false), ['-10042']);
  assert.deepEqual(withGroupListed(['-10042'], unknownChat(NEW), true), ['-10042'], 'no Telegram id, nothing added');
  assert.equal(accessKey({'-4005': {granted: ['73'], denied: []}}, find(UPGRADED)), '-4005');
  assert.equal(accessKey({}, find(UPGRADED)), '-10099');
  assert.equal(accessKey({}, unknownChat(NEW)), null);
});

test('a rule keeps the search hits of its sources’ groups, matched by the hit’s chat, never by its raw scope', () => {
  const hits = [
    {id: 'a', scope: '-10042', chat_id: '-10042'},
    {id: 'b', scope: '-10042/topic/7', chat_id: '-10042/topic/7'},
    {id: 'c', scope: '-10088', chat_id: NEW},
    {id: 'd', scope: '-10088/topic/3', chat_id: NEW_TOPIC},
    {id: 'e', scope: '-4005', chat_id: UPGRADED},
    {id: 'f', scope: '-10088'},
    {id: 'g'},
  ];
  const ids = list => list.map(hit => hit.id);
  assert.deepEqual(ids(sourceHits(hits, [NEW], find)), ['c', 'd', 'g']);
  assert.deepEqual(ids(sourceHits(hits, [NEW_TOPIC], find)), ['c', 'd', 'g'], 'a topic source reads its group');
  assert.deepEqual(ids(sourceHits(hits, ['-10042/topic/7'], find)), ['a', 'b', 'g']);
  assert.deepEqual(ids(sourceHits(hits, [UPGRADED], find)), ['e', 'g'], 'a hit from before the upgrade is the group’s');
  assert.deepEqual(ids(sourceHits(hits, [], find)), ['g']);
});
