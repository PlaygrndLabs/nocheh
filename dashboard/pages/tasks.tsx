/**
 * Tasks: the owner's to-do lists, kept in Nocheh. Personal tasks are one list
 * and each project has its own. Tasks have statuses, priority, dates, repeats,
 * reminders, subtasks, links, the owner's own columns and comments, and show as
 * a list, cards, a board, or what is due today and coming up. Tasks can be added
 * here or by telling Nocheh in chat; both edit the same lists.
 */
import * as React from 'react';
import {useDeferredValue, useState} from 'react';
import {Archive, Folder, LayoutGrid, List, ListChecks, Plus, Search, Tag} from 'lucide-react';
import {chatName, type Directory} from '../lib/chats-model';
import {useParam, useView} from '../lib/navigation';
import {setParams} from '../lib/routes';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {refreshResources, useResource} from '../lib/resource';
import {Button, Card, Empty, Field, Input, LoadError, LoadingRows, Notice, Pager, Segmented, Select} from '../ui/core';
import {useFeedback} from '../ui/overlay';
import {Page, Tabs} from '../ui/page';
import {useCommand} from './memory/shared';
import {Board} from './tasks/board';
import {TaskDrawer} from './tasks/drawer';
import {Chips, ListField, TagsField, withPending} from './tasks/fields';
import {addDays, day, scopeName, type Scope, type Task, type TaskPage, type TaskSettings} from './tasks/model';
import {TaskRow} from './tasks/row';

export {day, type Task};

const views = tabIds('tasks');
type View = (typeof views)[number];
const PAGE = 100;

/** What each tab asks the owner API for. */
const queries: Record<View, string> = {
  open: 'state=open&parent=top',
  today: 'state=open&when=today',
  upcoming: 'state=open&when=upcoming',
  board: 'state=all&parent=top&sort=manual',
  done: 'state=done&parent=top',
  dropped: 'state=dropped&parent=top',
  archive: 'state=all&in=archive',
  trash: 'state=all&in=trash',
};
const empty: Record<View, string> = {
  open: 'Nothing to do',
  today: 'Nothing due today',
  upcoming: 'Nothing coming up in the next two weeks',
  board: 'Nothing on the board',
  done: 'No done tasks',
  dropped: 'No dropped tasks',
  archive: 'Nothing archived',
  trash: 'The trash is empty',
};

type Layout = 'list' | 'cards';
const LAYOUT_KEY = 'nocheh.tasks-layout';
/** List or cards, remembered on this device. */
function useLayout(): [Layout, (layout: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'cards' ? 'cards' : 'list';
    } catch {
      return 'list';
    }
  });
  return [
    layout,
    next => {
      setLayout(next);
      try {
        localStorage.setItem(LAYOUT_KEY, next);
      } catch {}
    },
  ];
}

/** The day a task shows under in Upcoming: the first of its start and due days still ahead. */
const upcomingDay = (task: Task, today: string) =>
  [task.start_on, task.due_on].filter((value): value is string => !!value && value > today).sort()[0] ?? today;

export default function Tasks() {
  const [view, setView] = useView(views);
  const [page, setPage] = useState(0);
  const scope = useParam('list') || 'all';
  const tag = useParam('tag');
  const open = useParam('task');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const path =
    `/tasks?${queries[view]}&scope=${encodeURIComponent(scope)}&limit=${view === 'board' ? 200 : PAGE}` +
    (tag ? `&tag=${encodeURIComponent(tag)}` : '') +
    (query ? `&q=${encodeURIComponent(query)}` : '') +
    (page ? `&after=${page * PAGE}` : '');
  const list = useResource<TaskPage>(path);
  const chats = useResource<Directory>('/conversations?limit=100', 60000);
  const counts = list.data?.counts;
  const scopes = list.data?.scopes ?? [];
  const tags = list.data?.tags ?? [];
  const settings = list.data?.settings;
  const today = list.data?.today;
  const groupName = (space: string) => {
    const chat = chats.data?.items.find(row => row.space_id === space);
    if (!chat) return space.includes('/topic/') ? 'A topic' : 'A group';
    return chat.kind === 'topic' && chat.parent_name ? `${chatName(chat)} · ${chat.parent_name}` : chatName(chat);
  };
  const [layout, setLayout] = useLayout();
  const changeView = (next: View) => {
    setPage(0);
    setView(next);
  };
  const choose = (patch: Record<string, string | null>) => {
    setPage(0);
    setParams(patch, true);
  };
  const describe = (task: Task) => ({
    list: scope === 'all' ? scopeName(scopes.find(row => row.id === (task.project_id ?? 'personal'))) : null,
    group: task.group_id ? groupName(task.group_id) : null,
  });
  const openTask = (id: string | null) => setParams({task: id});
  const listed = view === 'board' ? [] : (list.data?.tasks ?? []);
  const rows = (tasks: Task[]) =>
    tasks.map(task => (
      <TaskRow
        key={task.id}
        task={task}
        card={layout === 'cards'}
        settings={settings}
        {...describe(task)}
        onOpen={() => openTask(task.id)}
      />
    ));
  const group = (title: string, tasks: Task[]) =>
    !!tasks.length && (
      <section key={title} className="space-y-2" aria-label={title}>
        <h2 className="text-[13px] font-semibold text-muted">{title}</h2>
        {layout === 'cards' ? (
          <ul aria-label="Tasks" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows(tasks)}
          </ul>
        ) : (
          <Card>
            <ul aria-label="Tasks" className="divide-y divide-line">
              {rows(tasks)}
            </ul>
          </Card>
        )}
      </section>
    );
  let body: React.ReactNode;
  if (!list.data)
    body = !list.error && (
      <Card>
        <div className="p-5">
          <LoadingRows rows={4} />
        </div>
      </Card>
    );
  else if (view === 'board')
    body = list.data.tasks.some(task => task.state !== 'dropped') ? (
      <Board
        tasks={list.data.tasks.filter(task => task.state !== 'dropped')}
        settings={list.data.settings}
        describe={describe}
        onOpen={task => openTask(task.id)}
      />
    ) : (
      <Card>
        <Empty icon={ListChecks} title={empty.board}>
          Add a task above; drag cards between columns to change their status.
        </Empty>
      </Card>
    );
  else if (!listed.length)
    body = (
      <Card>
        <Empty icon={ListChecks} title={query ? 'No tasks match' : empty[view]}>
          {view === 'open' &&
            !query &&
            'Add a task above, or ask Nocheh in your private chat to remember something for you.'}
          {view === 'trash' && 'Tasks in the trash can be restored, or deleted for good.'}
        </Empty>
      </Card>
    );
  else if (view === 'today' && today)
    body = (
      <>
        {group(
          'Overdue',
          listed.filter(task => (task.due_on ?? today) < today),
        )}
        {group(
          'Today · ' + day(today),
          listed.filter(task => (task.due_on ?? today) >= today),
        )}
      </>
    );
  else if (view === 'upcoming' && today) {
    const days = [...new Set(listed.map(task => upcomingDay(task, today)))].sort();
    body = (
      <>
        {days.map(date =>
          group(
            date === addDays(today, 1) ? 'Tomorrow · ' + day(date) : day(date),
            listed.filter(task => upcomingDay(task, today) === date),
          ),
        )}
      </>
    );
  } else
    body = (
      <div>
        {layout === 'cards' ? (
          <ul aria-label="Tasks" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows(listed)}
          </ul>
        ) : (
          <Card>
            <ul aria-label="Tasks" className="divide-y divide-line">
              {rows(listed)}
            </ul>
            <Pager page={page} hasNext={!!list.data.next} onPage={setPage} />
          </Card>
        )}
        {layout === 'cards' && <Pager page={page} hasNext={!!list.data.next} onPage={setPage} />}
      </div>
    );
  return (
    <Page
      title="Tasks"
      description="Your personal tasks and each project's own list. Add tasks here, or just tell Nocheh in chat."
      actions={(view === 'done' || view === 'dropped') && !!listed.length && <ArchiveFinished scope={scope} />}
      tabs={
        <Tabs
          label="Tasks"
          value={view}
          onChange={changeView}
          tabs={views.map(id => ({
            id,
            label: pageTabs.tasks[id],
            count: id === 'board' ? null : (counts?.[id] ?? null),
          }))}
        />
      }
    >
      {/* Filters first; on a phone the layout switch goes below them, not between them. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Chips
            label="List"
            value={scope}
            onChange={value => choose({list: value === 'all' ? null : value, tag: null})}
            options={[
              {value: 'all', label: 'All'},
              ...scopes.map(row => ({
                value: row.id,
                label: (
                  <>
                    {row.id === 'personal' ? null : <Folder className="size-3.5" aria-hidden />}
                    {scopeName(row)}
                    {!!row.open && <span className="text-xs text-muted">{row.open}</span>}
                  </>
                ),
              })),
            ]}
          />
          {!!tags.length && (
            <Chips
              label="Tag"
              value={tag ?? '*'}
              onChange={value => choose({tag: value === '*' ? null : value})}
              options={[
                {value: '*', label: 'All'},
                ...tags.map(row => ({
                  value: row.name,
                  label: (
                    <>
                      <Tag className="size-3.5" aria-hidden />
                      {row.name}
                    </>
                  ),
                })),
              ]}
            />
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted" aria-hidden />
            <Input
              type="search"
              aria-label="Search tasks"
              placeholder="Search"
              value={search}
              className="h-8 w-44 pl-8 text-[13px]"
              onChange={event => {
                setPage(0);
                setSearch(event.target.value);
              }}
            />
          </div>
          {view !== 'board' && (
            <Segmented
              label="Show tasks as"
              size="sm"
              value={layout}
              onChange={setLayout}
              options={[
                {
                  value: 'list',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <List className="size-3.5" aria-hidden /> List
                    </span>
                  ),
                },
                {
                  value: 'cards',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <LayoutGrid className="size-3.5" aria-hidden /> Cards
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
      </div>
      {['open', 'today', 'upcoming', 'board'].includes(view) && (
        <AddTask
          key={scope + view}
          scopes={scopes}
          scope={scope === 'all' ? 'personal' : scope}
          tags={tags.map(row => row.name)}
          tag={tag}
          settings={settings}
          due={view === 'today' && today ? today : view === 'upcoming' && today ? addDays(today, 1) : ''}
        />
      )}
      {list.error && <LoadError what="tasks" onRetry={() => void refreshResources()} />}
      {body}
      {open && /^[a-f0-9]{64}$/.test(open) && (
        <TaskDrawer
          key={open}
          id={open}
          scopes={scopes}
          tags={tags.map(row => row.name)}
          settings={settings}
          groupName={groupName}
          onOpen={id => setParams({task: id})}
          onClose={() => setParams({task: null})}
        />
      )}
    </Page>
  );
}

function ArchiveFinished({scope}: {scope: string}) {
  const command = useCommand();
  const feedback = useFeedback();
  return (
    <Button
      size="sm"
      busy={command.busy}
      onClick={async () => {
        const result = await command.run<{archived: number}>('/tasks/archive-finished', {scope});
        if (result) feedback.toast(result.archived === 1 ? '1 task archived.' : `${result.archived} tasks archived.`);
      }}
    >
      <Archive aria-hidden /> Archive finished
    </Button>
  );
}

function AddTask({
  scopes,
  scope: initialScope,
  tags: known,
  tag,
  settings,
  due: initialDue,
}: {
  scopes: Scope[];
  scope: string;
  tags: string[];
  tag: string | null;
  settings: TaskSettings | undefined;
  due: string;
}) {
  const command = useCommand();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(initialDue);
  const [priority, setPriority] = useState(0);
  const [scope, setScope] = useState(initialScope);
  const [tags, setTags] = useState<string[]>(tag ? [tag] : []);
  const [pending, setPending] = useState('');
  const add = async () => {
    if (!title.trim()) return;
    const chosen = withPending(tags, pending);
    const created = await command.run('/tasks', {
      title,
      scope,
      ...(chosen.length ? {tags: chosen} : {}),
      ...(due ? {due_on: due} : {}),
      ...(priority ? {priority} : {}),
    });
    if (created) {
      setTitle('');
      setDue(initialDue);
      setPriority(0);
      setPending('');
      setTags(tag ? [tag] : []);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        void add();
      }}
    >
      <Field label="New task" htmlFor="task-title" className="min-w-0 flex-1 basis-64">
        <Input
          id="task-title"
          value={title}
          maxLength={300}
          placeholder="What needs doing?"
          onChange={event => setTitle(event.target.value)}
          dir="auto"
        />
      </Field>
      <ListField id="task" scopes={scopes} scope={scope} onScope={setScope} />
      <TagsField
        id="task"
        tags={tags}
        onTags={setTags}
        pending={pending}
        onPending={setPending}
        known={known}
        className="w-64"
      />
      {settings && (
        <Field label="Priority" htmlFor="task-priority" className="w-36">
          <Select
            id="task-priority"
            value={String(priority)}
            onChange={event => setPriority(Number(event.target.value))}
          >
            {settings.priorities.map(item => (
              <option key={item.level} value={item.level}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Due" htmlFor="task-due" className="w-40">
        <Input id="task-due" type="date" value={due} onChange={event => setDue(event.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={command.busy} disabled={!title.trim()}>
        <Plus aria-hidden /> Add
      </Button>
      {command.error && (
        <Notice tone="bad" className="w-full">
          {command.error}
        </Notice>
      )}
    </form>
  );
}
