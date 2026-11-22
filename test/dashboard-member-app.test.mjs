import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

/*
 * The members' app page (ADR-0265 D1, D12): what it may import, what it may store, and its words. It shares the owner
 * page's origin, so it never pulls in the owner's pages, the owner's API client or the owner's mini app, never names the
 * owner page's storage keys, and never renders raw HTML.
 */
const bundle = await build({
  entryPoints: ['dashboard/member.tsx'],
  bundle: true,
  write: false,
  metafile: true,
  format: 'esm',
  platform: 'browser',
  tsconfig: 'tsconfig.dashboard.json',
  logLevel: 'silent',
});
const inputs = Object.keys(bundle.metafile.inputs).filter(path => !path.includes('node_modules'));
const own = inputs.filter(path => path.startsWith('dashboard/'));
const load = async entry => {
  const compiled = await build({entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node'});
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};

const loadSource = async contents => {
  const compiled = await build({
    stdin: {contents, resolveDir: process.cwd(), loader: 'ts'},
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
};

test('the member page imports nothing of the owner’s pages, API client or mini app', () => {
  assert.ok(own.includes('dashboard/member.tsx'));
  for (const path of inputs) {
    assert.doesNotMatch(path, /^dashboard\/pages\//, path);
    assert.notEqual(path, 'dashboard/mini.tsx');
    assert.notEqual(path, 'dashboard/lib/api.ts');
    assert.notEqual(path, 'dashboard/ui/save-bar.tsx', path + ' reaches the owner API');
    // From the server side, only the shared wire shapes (values and types, nothing that runs on a server).
    if (path.startsWith('src/')) assert.ok(['src/member-app-wire.ts', 'src/member-wire.ts'].includes(path), path);
  }
});

test('the member page never names the owner page’s storage keys or renders raw HTML', async () => {
  for (const path of own) {
    const text = await readFile(path, 'utf8');
    for (const banned of [
      'nocheh.mini-session',
      'nocheh.telegram-launch',
      'nocheh.telegram-theme',
      '__NOCHEH_MINI_SESSION__',
    ])
      assert.equal(text.includes(banned), false, `${path} names ${banned}`);
    for (const banned of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'])
      assert.equal(text.includes(banned), false, `${path} uses ${banned}`);
  }
  const output = bundle.outputFiles[0].text;
  assert.equal(output.includes('/api/nocheh'), false, 'never calls the owner API');
  assert.equal(output.includes('/api/mini/'), false, 'never calls the owner’s phone sign-in');
});

test('the page is in English only, every word is filled, and none says team', async () => {
  const i18n = await load('dashboard/member/i18n.ts');
  assert.deepEqual(
    Object.keys(i18n).sort(),
    ['memberWords', 'translate'],
    'one English dictionary, no language choice',
  );
  for (const [key, value] of Object.entries(i18n.memberWords)) assert.ok(value.trim(), `${key} is empty`);
  for (const value of Object.values(i18n.memberWords)) {
    assert.doesNotMatch(value, /\bteams?\b/i);
    assert.match(value, /^[\x20-\x7e‘’“”…–✓]*$/, 'English words only: ' + value);
  }
  assert.equal(i18n.translate('others_many', {count: 3}), '3 other reminders');
  // Nothing on the page reads Telegram's language or turns it right to left.
  for (const path of own) {
    const text = await readFile(path, 'utf8');
    for (const banned of ['language_code', "'rtl'", 'rtl:', 'prefs'])
      assert.equal(text.includes(banned), false, `${path} has ${banned}`);
  }
});

test('assignees show by their Telegram name, the rest counted, and statuses and columns by the board’s names', async () => {
  const {assigneeText, statusName, columnPatch, draftsOf, translate} = await loadSource(
    "export {assigneeText, statusName} from './dashboard/member/shared.tsx';" +
      "export {columnPatch, draftsOf} from './dashboard/member/columns.tsx';" +
      "export {translate} from './dashboard/member/i18n.ts';",
  );
  const people = (names, other) => ({assignees: names.map(name => ({name})), assignees_other: other});
  assert.equal(assigneeText(people(['Lena', 'Ravi'], 2), translate), 'Lena, Ravi and 2 other people');
  assert.equal(assigneeText(people(['Lena'], 1), translate), 'Lena and 1 other person');
  assert.equal(assigneeText(people(['Lena', 'Ravi'], 0), translate), 'Lena and Ravi');
  assert.equal(assigneeText(people([], 3), translate), '3 other people');
  assert.equal(assigneeText(people([' '], 0), translate), '1 other person', 'a name that is blank is counted');
  assert.equal(assigneeText(people([], 0), translate), null);
  const board = {
    statuses: [
      {id: 's1', name: 'Not started', state: 'open'},
      {id: 's2', name: 'Wrapped up', state: 'done'},
    ],
    columns: [
      {id: 'c1', name: 'Budget', type: 'number'},
      {id: 'c2', name: 'Size', type: 'select', options: [{id: 'o1', name: 'A2'}]},
      {id: 'c3', name: 'Rooms', type: 'multi_select', options: [{id: 'o2', name: 'Hall'}]},
      {id: 'c4', name: 'Signed off', type: 'checkbox'},
      {id: 'c5', name: 'Someone', type: 'person'},
    ],
  };
  assert.equal(statusName({status: 's2', state: 'done'}, board, translate), 'Wrapped up');
  // A status the board doesn't list says only what it means; its id is never shown.
  assert.equal(statusName({status: 'gone', state: 'dropped'}, board, translate), 'Dropped');
  // A new task sends only what is set; an edit only what changed; a person column is never a field.
  const drafts = draftsOf(board);
  assert.deepEqual(Object.keys(drafts), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(columnPatch(board, drafts), {properties: {}});
  assert.deepEqual(columnPatch(board, {...drafts, c1: '12.5', c2: 'o1', c3: ['o2'], c4: true}), {
    properties: {c1: 12.5, c2: 'o1', c3: ['o2'], c4: true},
  });
  assert.deepEqual(columnPatch(board, {...drafts, c1: 'many'}), {invalid: 'Budget'});
  const stored = {c1: 7, c2: 'o1', c3: ['o2'], c5: ['entity']};
  assert.deepEqual(columnPatch(board, draftsOf(board, stored), stored), {properties: {}});
  assert.deepEqual(columnPatch(board, {...draftsOf(board, stored), c1: '', c3: []}, stored), {
    properties: {c1: null, c3: null},
  });
});

test('only http(s) links are followed, list filters are the member route’s own, and reminders carry an offset', async () => {
  // One bundle for both, so the page's error class is the one problem() checks.
  const {safeHref, localMoment, problem, tasksPath, screenFor, MemberApiError} = await loadSource(
    "export {safeHref, localMoment, problem} from './dashboard/member/shared.tsx';" +
      "export {tasksPath, screenFor, MemberApiError} from './dashboard/member/api.ts';",
  );
  const {memberTaskQuery} = await load('src/member-app-wire.ts');
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('http://example.com/'), 'http://example.com/');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'tg://resolve?domain=x', '/m/', '', 'not a url'])
    assert.equal(safeHref(value), null, value);
  const project = 'a'.repeat(64);
  for (const query of [
    {project},
    {project, group: '-30001', mine: true, state: 'done', tag: 'Print', cursor: '20'},
    {project, trash: true},
  ])
    // What the page sends, the member listener's own filter reads back unchanged.
    assert.deepEqual(memberTaskQuery(new URLSearchParams(tasksPath(query).split('?')[1])), query);
  assert.match(localMoment('2030-01-04T09:00'), /^2030-01-04T09:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(localMoment('2030-01-04T09:00')).getTime(), new Date('2030-01-04T09:00').getTime());
  assert.equal(localMoment(''), null);
  // Which answers end the visit, and which a write shows.
  assert.equal(screenFor(401, 'member_app_launch_invalid'), 'reopen');
  assert.equal(screenFor(401, 'member_app_signed_out'), 'reopen');
  assert.equal(screenFor(403, 'member_app_closed'), 'closed');
  assert.equal(screenFor(403, 'member_required'), 'owner');
  assert.equal(screenFor(403, 'task_read_only'), null);
  assert.equal(problem(new MemberApiError(401, 'member_app_launch_old')), null);
  assert.deepEqual(problem(new MemberApiError(409, 'conflict')), {word: 'conflict', reload: false});
  assert.deepEqual(problem(new MemberApiError(403, 'task_read_only')), {word: 'read_only_now', reload: true});
  assert.deepEqual(problem(new MemberApiError(429, 'member_app_busy')), {word: 'busy', reload: false});
});

test('a task’s group shows by its title, another group of the project’s too', async () => {
  const {groupTitle, boardGroups} = await loadSource(
    "export {groupTitle, boardGroups} from './dashboard/member/shared.tsx';",
  );
  const {translate} = await load('dashboard/member/i18n.ts');
  const project = 'a'.repeat(64);
  const own = {id: '-30001', title: 'Aurora planning', board: 'open', project, open_count: 1};
  const me = {
    name: 'Lena',
    mode: 'write',
    reminders: {available: true},
    projects: [{id: project, name: 'Studio launch', groups: [own, {id: '-30006', title: 'Print crew'}]}],
    groups: [own],
  };
  // A board is the project's whole list, so a task of a group the member is not in names that group (ADR-0276).
  assert.equal(groupTitle(me, '-30006', translate), 'Print crew');
  assert.equal(groupTitle(me, '-30001', translate), 'Aurora planning');
  assert.equal(groupTitle(me, null, translate), 'Whole project');
  assert.equal(groupTitle(me, '-39999', translate), 'Unnamed group');
  assert.deepEqual(
    boardGroups(me, project).map(group => group.id),
    ['-30001', '-30006'],
  );
  // Without the project's groups, the member's own groups on that board.
  assert.deepEqual(
    boardGroups({...me, projects: [{id: project, name: 'Studio launch'}]}, project).map(group => group.id),
    ['-30001'],
  );
  assert.equal(translate('whole_project_line', {project: 'Studio launch'}).includes('whatever its group'), true);
});

test('the Mini app card names the owner’s address and the members’ /m/', async () => {
  const {miniAppAddresses} = await load('dashboard/pages/settings/telegram.tsx');
  assert.deepEqual(miniAppAddresses('https://nocheh.example.com'), {
    owner: 'https://nocheh.example.com/',
    members: 'https://nocheh.example.com/m/',
  });
  assert.deepEqual(miniAppAddresses('https://nocheh.example.com/app/'), {
    owner: 'https://nocheh.example.com/app/',
    members: 'https://nocheh.example.com/app/m/',
  });
  for (const value of ['', 'nocheh.example.com', 'javascript:alert(1)']) assert.equal(miniAppAddresses(value), null);
});
