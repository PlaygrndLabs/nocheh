import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

/*
 * ADR-0261 step 4 on the dashboard: how a message's Thread section reads (a topic's first message is its Topic, never
 * what it replies to), that a retired original is never linked, the coverage line, the fact badge, and how pages ask
 * storage for originals' labels.
 */
const compiled = await build({
  entryPoints: ['dashboard/lib/memory-sources.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  coverageLine,
  factBadge,
  factsReasonText,
  noteDayText,
  noteWords,
  originalLookups,
  originalsById,
  originalView,
  personOptions,
  threadRows,
} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const hex = pair => pair.repeat(32);
const original = (id, label = 'you in your private chat') => ({id, label, at: '2026-11-19T10:00:00.000Z'});
const none = {reply_to: null, replies: {count: 0, items: []}, topic: null, forwarded_from: null};
const kinds = thread => threadRows(thread).map(row => row.kind);

test('a message replying to its topic’s first message shows its Topic, never Replies to', () => {
  const opening = original(hex('e6'), '“Mira Chen” in “Aurora planning” › Iceland planning');
  const rows = threadRows({...none, topic: {label: '“Aurora planning” › Iceland planning', opening}});
  assert.deepEqual(
    rows.map(row => row.kind),
    ['topic'],
  );
  assert.equal(rows[0].heading, 'Topic');
  assert.equal(rows[0].opening, opening);
  assert.equal(rows[0].opens, false);
  // A topic's first message lists none of the topic as its replies, however many there are.
  const first = threadRows({
    ...none,
    replies: {count: 40, items: [original(hex('e3'))], topic: true},
    topic: {label: 'Iceland planning', opens: true, opening: null},
  });
  assert.deepEqual(
    first.map(row => [row.kind, row.opens]),
    [['topic', true]],
  );
});

test('the Thread section lists what it replies to, the topic, the forward and the replies, in that order', () => {
  const target = original(hex('e1'));
  const rows = threadRows({
    reply_to: target,
    replies: {count: 3, items: [original(hex('e2')), {retired: true}]},
    topic: {label: 'Iceland planning', opening: null},
    forwarded_from: 'the channel “Night sky news”',
  });
  assert.deepEqual(
    rows.map(row => row.heading),
    ['Replies to', 'Topic', 'Forwarded from', 'Replies (3)'],
  );
  assert.equal(rows[0].original, target);
  assert.equal(rows[2].text, 'the channel “Night sky news”');
  assert.equal(rows[3].more, 1, 'the ones not listed are counted');
  // More replies than could be counted say so; an old import's reply into another chat keeps no link.
  assert.equal(threadRows({...none, replies: {count: 100, items: [], complete: false}})[0].heading, 'Replies (100+)');
  const elsewhere = threadRows({...none, reply_in_other_chat: true});
  assert.deepEqual(
    elsewhere.map(row => [row.heading, 'original' in row]),
    [['Replies to', false]],
  );
  // A reply into someone else's private chat names no message there and links none.
  const hidden = threadRows({...none, reply_in_private_chat: true});
  assert.deepEqual(
    hidden.map(row => [row.kind, row.heading, 'original' in row]),
    [['reply_private', 'Replies to', false]],
  );
  assert.match(hidden[0].text, /someone else’s private chat/);
  assert.deepEqual(kinds(none), [], 'a message on its own has no lines');
});

test('a retired original is never linked, and one whose label fails has no link either', () => {
  // Hidden from assistant: the Messages list's own words for a retired message.
  assert.deepEqual(originalView({retired: true}), {text: 'Hidden from assistant'});
  assert.deepEqual(originalView({unavailable: true, label: 'Source not available right now'}), {
    text: 'Source not available right now',
    unavailable: true,
  });
  assert.deepEqual(originalView(original(hex('e1'))), {
    link: hex('e1'),
    label: 'you in your private chat',
    at: '2026-11-19T10:00:00.000Z',
  });
});

test('the coverage line counts exact facts, facts learned with other messages and facts with no source', () => {
  assert.equal(
    coverageLine({total: 515, exact: 412, with_others: 96, none: 7}, 'en-US'),
    '412 exact · 96 learned with other messages · 7 none',
  );
  assert.equal(
    coverageLine({total: 1300, exact: 1234, with_others: 0, none: 66}, 'en-US'),
    '1,234 exact · 0 learned with other messages · 66 none',
  );
});

test('a fact’s badge says exact only when it names every message it came from', () => {
  assert.deepEqual(factBadge({exact: true, batch: false}), {label: 'Exact source', tone: 'good'});
  assert.deepEqual(factBadge({exact: false, batch: true}), {label: 'Learned with other messages', tone: 'neutral'});
  assert.equal(factBadge({exact: false, batch: false}), null);
});

test('each reason a list of facts is empty reads differently', () => {
  const reasons = ['no_memory', 'not_supported', 'not_learned', 'unavailable', undefined];
  const texts = reasons.map(reason => factsReasonText(reason, 'message'));
  assert.equal(new Set(texts).size, reasons.length);
  assert.match(factsReasonText('unavailable', 'list'), /can’t be reached right now/);
  assert.notEqual(factsReasonText(undefined, 'list'), factsReasonText(undefined, 'message'));
  // A page with none of its own while older pages follow never reads as nothing learned.
  assert.equal(factsReasonText(undefined, 'list', true), 'None on this page. Older facts may be on the next pages.');
  assert.equal(factsReasonText(undefined, 'list', false), 'No facts here yet.');
});

test('the person filter offers the chosen person even when the search doesn’t find them, everyone by name', () => {
  const zed = {id: hex('09'), name: 'Zed'};
  const found = [
    {id: hex('01'), name: 'Mira Chen'},
    {id: hex('02'), name: 'Devon'},
  ];
  assert.deepEqual(
    personOptions(found, zed).map(person => person.name),
    ['Devon', 'Mira Chen', 'Zed'],
  );
  assert.deepEqual(
    personOptions(found, found[0]).map(person => person.name),
    ['Devon', 'Mira Chen'],
  );
  assert.deepEqual(personOptions([], null), []);
});

test('pages ask for whole message ids only, each once, 50 a lookup and 200 at most, and read the answers back by id', () => {
  const ids = Array.from({length: 230}, (_, index) => index.toString(16).padStart(64, '0'));
  const paths = originalLookups([ids[0], ids[0], 'not-an-id', null, ...ids]);
  assert.equal(paths.length, 4);
  const asked = paths.map(path => new URLSearchParams(path.split('?')[1]).getAll('id'));
  assert.deepEqual(
    asked.map(list => list.length),
    [50, 50, 50, 50],
  );
  assert.deepEqual(asked.flat(), ids.slice(0, 200));
  assert.ok(paths.every(path => path.startsWith('/memory/originals?id=')));
  const answers = asked.map(list => ({originals: list.map((id, index) => (index ? original(id) : {retired: true}))}));
  const found = originalsById(paths, answers);
  assert.deepEqual(found.get(ids[0]), {retired: true});
  assert.equal(found.get(ids[1]).id, ids[1]);
  // An answer that doesn't match what was asked names nothing, so no label is put on the wrong message.
  assert.equal(originalsById(paths.slice(0, 1), [{originals: [original(ids[0])]}]).size, 0);
  assert.equal(originalsById(paths.slice(0, 1), [null]).size, 0);
  assert.deepEqual(originalLookups([]), []);
});

test('a note’s day reads as a date, and a malformed one is not shown', () => {
  assert.equal(noteDayText('2026-11-19', 'en-GB'), '19 Nov 2026');
  assert.equal(noteDayText('2026-11-19T00:00', 'en-GB'), null);
  assert.equal(noteDayText(null), null);
});

test('a note’s words are shown without the ids of Nocheh’s own records', () => {
  const event = 'nocheh:event:' + hex('ab');
  for (const [text, words] of [
    ['Alice prefers tea (' + event + ').', 'Alice prefers tea.'],
    ['The trip is booked. Source: ' + event, 'The trip is booked.'],
    ['The trip is booked [Archive source: ' + event + ']', 'The trip is booked'],
    ['Likes hiking (conv 129882197, ' + event + ')', 'Likes hiking'],
    ['Booked in conv 129882197. Hotels are open.', 'Booked. Hotels are open.'],
    ['Two sources (' + event + ', nocheh:event:' + hex('cd') + ') agree.', 'Two sources agree.'],
    ['Cut short: nocheh:event:abcdef12…', 'Cut short:'],
    ['First line ' + event + '\nSecond line, from ' + event, 'First line\nSecond line'],
    ['Call 5551234567 about order 20261119.', 'Call 5551234567 about order 20261119.'],
    ['The conversation with 12 people went well.', 'The conversation with 12 people went well.'],
  ])
    assert.equal(noteWords(text), words);
  // A note that is nothing but ids keeps its text, so the row is never empty.
  assert.equal(noteWords(event), event);
});
