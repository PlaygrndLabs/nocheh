/**
 * Memory › Projects: group chats into projects so Nocheh keeps related
 * knowledge together, and optionally let Nocheh organize them itself.
 * A project never shares one chat's messages with another.
 */
import {useState} from 'react';
import {ChevronRight, FolderKanban, Pencil, Plus, Sparkles} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {refreshResources, useResource} from '../../lib/resource';
import {decisionLink, proposalState, type DecisionKind} from '../../lib/supervision';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  Switch,
  Textarea,
  type Tone,
} from '../../ui/core';
import {Dialog, Drawer, useFeedback} from '../../ui/overlay';
import {certainty, EvidenceLinks, useChats, useCommand, when, type Conversation} from './shared';

type Project = {id: string; name: string; description: string; state: 'active' | 'archived'; revision: number};
type Assignment = {
  space_id: string;
  project_id: string | null;
  mode: 'assigned' | 'none' | 'inherit';
  revision: number;
};
type ContextChat = Conversation & {
  effective: {project: Project | null; inherited: boolean; own_assignment: Assignment | null};
};
type Knowledge = {
  type: 'claim' | 'learned';
  id: string;
  subject: string;
  content: string | null;
  uncertainty: string | null;
  evidence?: {id: string}[];
};
type ProjectContext = {
  project: Project;
  conversations: ContextChat[];
  knowledge: {items: Knowledge[]; total: number; next_cursor: string | null};
  decisions: {
    items: {kind: DecisionKind; id: string; title: string; state: string}[];
    total: number;
    next_cursor: string | null;
  };
};
type Delegation = {
  id: string;
  name: string;
  enabled: boolean;
  scopes: string[];
  project_ids: string[];
  allow_create: boolean;
  expires_at: string | null;
  revision: number;
  suspended_scopes?: string[];
  expired?: boolean;
};
type Proposal = {id: string; kind: string; state: string; created_at: string; proposal?: {reason?: string}};

function useProjects() {
  const list = useResource<{projects: Project[]; next: string | null}>('/projects?after=', 30000);
  const assignments = useResource<{assignments: Assignment[]; next: string | null}>(
    '/projects/assignments?after=',
    30000,
  );
  return {list, assignments, projects: list.data?.projects ?? [], own: assignments.data?.assignments ?? []};
}

export function Projects() {
  const open = useParam('project');
  const {list, projects, own} = useProjects();
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const sorted = [...projects].sort((a, b) =>
    a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'active' ? -1 : 1,
  );
  const chats = useChats();
  // The project each chat ends up in: its own choice, or its group's when it inherits.
  const projectOf = (space: string, parent?: string | null): string | null => {
    const mine = own.find(row => row.space_id === space);
    if (mine && mine.mode !== 'inherit') return mine.mode === 'assigned' ? mine.project_id : null;
    return parent ? projectOf(parent) : null;
  };
  const chatCount = (id: string) => {
    const spaces = new Set([...chats.items.map(chat => chat.space_id), ...own.map(row => row.space_id)]);
    return [...spaces].filter(space => projectOf(space, space.match(/^(.+)\/topic\/\d+$/)?.[1]) === id).length;
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Projects"
          description="Chats in one project share what Nocheh learns about the project, never their messages."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> New project
            </Button>
          }
        />
        <CardBody className="pt-3">
          {list.error && <LoadError className="mb-3" what="projects" onRetry={() => void refreshResources()} />}
          {!list.data && !list.error ? (
            <LoadingRows rows={3} />
          ) : list.data && sorted.length === 0 ? (
            <Empty icon={FolderKanban} title="No projects yet">
              Create a project, then add the chats that belong to it.
            </Empty>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {sorted.map(project => {
                const count = chatCount(project.id);
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => setParams({project: project.id})}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-subtle/60 focus-visible:bg-subtle/60 focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={
                            'block truncate text-sm font-medium ' + (project.state === 'archived' ? 'text-muted' : '')
                          }
                        >
                          {project.name}
                        </span>
                        {project.description && (
                          <span className="mt-0.5 block truncate text-[13px] text-muted">{project.description}</span>
                        )}
                      </span>
                      {project.state === 'archived' ? (
                        <Badge>Archived</Badge>
                      ) : (
                        <Badge>{count === 1 ? '1 chat' : `${count} chats`}</Badge>
                      )}
                      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <AutoOrganize projects={projects} />

      {editing && (
        <ProjectDialog
          project={editing === 'new' ? null : editing}
          onClose={created => {
            setEditing(null);
            if (created) setParams({project: created});
          }}
        />
      )}
      <ProjectDrawer id={open} row={projects.find(p => p.id === open) ?? null} onEdit={setEditing} />
    </>
  );
}

function ProjectDialog({project, onClose}: {project: Project | null; onClose: (created?: string) => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const save = async () => {
    const result = await command.run<Project>('/projects', {
      ...(project ? {id: project.id} : {}),
      name: name.trim(),
      description,
      state: project?.state ?? 'active',
      expected_revision: project?.revision ?? 0,
    });
    if (result) {
      feedback.toast(project ? 'Project saved.' : 'Project created.');
      onClose(project ? undefined : result.id);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title={project ? 'Edit project' : 'New project'}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={command.busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={command.busy} disabled={!name.trim()} onClick={() => void save()}>
            {project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <Field label="Name" htmlFor="project-name">
          <Input
            id="project-name"
            value={name}
            maxLength={200}
            autoFocus
            onChange={event => setName(event.target.value)}
          />
        </Field>
        <Field
          label="What it is about"
          htmlFor="project-description"
          hint="Optional. Helps Nocheh recognise chats that belong here."
        >
          <Textarea
            id="project-description"
            rows={4}
            maxLength={4000}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </Field>
        {command.error && <Notice tone="bad">{command.error}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function ProjectDrawer({
  id,
  row,
  onEdit,
}: {
  id: string | null;
  row: Project | null;
  onEdit: (project: Project) => void;
}) {
  const context = useResource<ProjectContext>(id ? '/projects/' + encodeURIComponent(id) + '/context' : null, 30000);
  const project = context.data?.project ?? row;
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && setParams({project: null})}
      title={project?.name ?? 'Project'}
      description={project?.description || undefined}
      wide
    >
      {context.error && <LoadError className="mb-4" what="this project" onRetry={() => void refreshResources()} />}
      {!project && !context.error && <LoadingRows rows={4} />}
      {project && (
        <ProjectDetail key={project.id} project={project} context={context.data} onEdit={() => onEdit(project)} />
      )}
    </Drawer>
  );
}

function ProjectDetail({
  project,
  context,
  onEdit,
}: {
  project: Project;
  context: ProjectContext | null;
  onEdit: () => void;
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const archived = project.state === 'archived';
  const setState = async (state: Project['state']) => {
    if (
      state === 'archived' &&
      !(await feedback.confirm({
        title: `Archive ${project.name}?`,
        body: 'It stays here with its history. New chats can’t be added until you restore it.',
        confirm: 'Archive',
        danger: true,
      }))
    )
      return;
    const result = await command.run('/projects', {
      id: project.id,
      name: project.name,
      description: project.description,
      state,
      expected_revision: project.revision,
    });
    if (result) feedback.toast(state === 'archived' ? 'Project archived.' : 'Project restored.');
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {archived ? <Badge>Archived</Badge> : <Badge tone="good">Active</Badge>}
        <span className="flex-1" />
        <Button size="sm" onClick={onEdit}>
          <Pencil aria-hidden /> Edit
        </Button>
        <Button
          size="sm"
          variant={archived ? 'secondary' : 'danger'}
          busy={command.busy}
          onClick={() => void setState(archived ? 'active' : 'archived')}
        >
          {archived ? 'Restore' : 'Archive'}
        </Button>
      </div>
      {command.error && <Notice tone="bad">{command.error}</Notice>}
      {!context ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          <ProjectChats project={project} context={context} />
          <ProjectKnowledge project={project} context={context} />
          {context.decisions.total > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Waiting for you</h3>
              <ul className="space-y-1.5 text-[13px]">
                {context.decisions.items.slice(0, 5).map(item => (
                  <li key={item.kind + item.id}>
                    <a className="text-accent-text hover:underline" href={decisionLink(item.kind, item.id)}>
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
              {context.decisions.total > 5 && (
                <a className="mt-2 inline-block text-[13px] text-accent-text hover:underline" href="#inbox">
                  All {context.decisions.total} in the Inbox
                </a>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ProjectChats({project, context}: {project: Project; context: ProjectContext}) {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
  const {projects, own} = useProjects();
  const [adding, setAdding] = useState('');
  const members = context.conversations;
  const ownOf = (space: string) => own.find(row => row.space_id === space);
  const candidates = chats.items.filter(chat => !members.some(member => member.space_id === chat.space_id));
  const elsewhere = (space: string) => {
    const assignment = ownOf(space);
    return assignment?.mode === 'assigned' && assignment.project_id !== project.id
      ? (projects.find(p => p.id === assignment.project_id)?.name ?? 'another project')
      : null;
  };

  const add = async () => {
    const other = elsewhere(adding);
    if (
      other &&
      !(await feedback.confirm({
        title: `Move ${chats.name(adding)}?`,
        body: `It is in ${other} now. A chat belongs to one project at a time.`,
        confirm: 'Move here',
      }))
    )
      return;
    const result = await command.run('/projects/assignments', {
      space_id: adding,
      mode: 'assigned',
      project_id: project.id,
      expected_revision: ownOf(adding)?.revision ?? 0,
    });
    if (result) {
      feedback.toast(`${chats.name(adding)} added.`);
      setAdding('');
    }
  };

  const remove = async (chat: ContextChat) => {
    const parent = chat.parent_space;
    // A topic that would fall back to this same project through its group is set to "no project" instead.
    const parentHere = parent && members.some(member => member.space_id === parent);
    const mode = !parent ? 'inherit' : chat.effective.inherited || parentHere ? 'none' : 'inherit';
    const result = await command.run('/projects/assignments', {
      space_id: chat.space_id,
      mode,
      project_id: null,
      expected_revision: ownOf(chat.space_id)?.revision ?? chat.effective.own_assignment?.revision ?? 0,
    });
    if (result) feedback.toast(`${chats.name(chat.space_id)} removed.`);
  };

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Chats in this project</h3>
      {members.length === 0 ? (
        <p className="text-[13px] text-muted">No chats yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {members.map(chat => (
            <li key={chat.space_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{chats.name(chat.space_id)}</span>
                {chat.effective.inherited && <span className="text-xs text-muted">Through its group</span>}
              </span>
              <Button size="sm" variant="ghost" disabled={command.busy} onClick={() => void remove(chat)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {project.state === 'active' && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Add a chat" htmlFor="project-add-chat" className="min-w-48 flex-1">
            <Select id="project-add-chat" value={adding} onChange={event => setAdding(event.target.value)}>
              <option value="">Choose a chat…</option>
              {candidates.map(chat => {
                const other = elsewhere(chat.space_id);
                return (
                  <option key={chat.space_id} value={chat.space_id}>
                    {chats.name(chat.space_id)}
                    {other ? ` (in ${other})` : ''}
                  </option>
                );
              })}
            </Select>
          </Field>
          <Button variant="primary" busy={command.busy} disabled={!adding} onClick={() => void add()}>
            Add
          </Button>
        </div>
      )}
      {command.error && (
        <Notice tone="bad" className="mt-3">
          {command.error}
        </Notice>
      )}
      {chats.error && !chats.items.length && (
        <p className="mt-2 text-xs text-muted">Couldn’t load the list of chats.</p>
      )}
    </section>
  );
}

function ProjectKnowledge({project, context}: {project: Project; context: ProjectContext}) {
  const items = context.knowledge.items;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">What Nocheh knows here</h3>
        <a
          className="text-[13px] text-accent-text hover:underline"
          href={'#memory?view=facts&project=' + encodeURIComponent(project.id)}
        >
          All facts for this project
        </a>
      </div>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing learned about this project yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map(item => {
            const sure = certainty[item.uncertainty ?? ''];
            return (
              <li key={item.type + item.id} className="rounded-lg border border-line px-4 py-3">
                {item.type === 'learned' ? (
                  <a
                    className="text-sm text-accent-text hover:underline"
                    href={'#memory?' + new URLSearchParams({view: 'facts', project: project.id, entry: item.id})}
                  >
                    {item.subject}
                  </a>
                ) : (
                  <>
                    <p className="text-sm break-words" dir="auto">
                      {item.content}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {sure && <Badge tone={sure.tone}>{sure.label}</Badge>}
                      <EvidenceLinks sources={item.evidence} />
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {context.knowledge.next_cursor && (
        <p className="mt-2 text-xs text-muted">
          Showing {items.length} of {context.knowledge.total}.
        </p>
      )}
    </section>
  );
}

function delegationState(item: Delegation): {label: string; tone: Tone} {
  if (item.expired) return {label: 'Ended', tone: 'neutral'};
  if (!item.enabled) return {label: 'Off', tone: 'neutral'};
  if (item.suspended_scopes?.length) return {label: 'Paused in some chats', tone: 'warn'};
  return {label: 'On', tone: 'good'};
}

function AutoOrganize({projects}: {projects: Project[]}) {
  const feedback = useFeedback();
  const command = useCommand();
  const delegations = useResource<{delegations: Delegation[]; next: string | null}>(
    '/organization/delegations?after=',
    30000,
  );
  const proposals = useResource<{proposals: Proposal[]; next: string | null}>('/knowledge/proposals?after=', 30000);
  const [editing, setEditing] = useState<Delegation | 'new' | null>(null);
  const list = delegations.data?.delegations ?? [];
  const recent = (proposals.data?.proposals ?? []).slice(0, 5);

  const toggle = async (item: Delegation, enabled: boolean) => {
    const result = await command.run('/organization/delegations', {
      id: item.id,
      name: item.name,
      enabled,
      scopes: item.scopes,
      project_ids: item.project_ids,
      allow_create: item.allow_create,
      expires_at: item.expired ? null : item.expires_at,
      expected_revision: item.revision,
    });
    if (result) feedback.toast(enabled ? 'Automatic organizing is on.' : 'Automatic organizing is off.');
  };

  return (
    <Card>
      <CardHeader
        title="Automatic organizing"
        description="Let Nocheh create projects and sort chats into them by itself, only in the chats you pick."
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden /> Allow in chats
          </Button>
        }
      />
      <CardBody className="space-y-4 pt-3">
        {delegations.error && <LoadError what="automatic organizing" onRetry={() => void refreshResources()} />}
        {!delegations.data && !delegations.error ? (
          <LoadingRows rows={2} />
        ) : (
          delegations.data &&
          (list.length === 0 ? (
            <Empty icon={Sparkles} title="Off" className="py-6">
              Nocheh only suggests changes. Allow it in chosen chats to organize them without asking.
            </Empty>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.map(item => {
                const state = delegationState(item);
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{item.name}</span>
                        <Badge tone={state.tone} dot>
                          {state.label}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted">
                        {item.scopes.length === 1 ? '1 chat' : `${item.scopes.length} chats`}
                        {item.allow_create ? ' · may create projects' : ''}
                        {item.expires_at ? ' · until ' + new Date(item.expires_at).toLocaleDateString() : ''}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                      Edit
                    </Button>
                    <Switch
                      label={'Automatic organizing: ' + item.name}
                      checked={item.enabled && !item.expired}
                      disabled={command.busy || !!item.expired}
                      onChange={value => void toggle(item, value)}
                    />
                  </li>
                );
              })}
            </ul>
          ))
        )}
        {command.error && <Notice tone="bad">{command.error}</Notice>}
        {recent.length > 0 && (
          <div>
            <h3 className="mb-2 text-[13px] font-medium text-muted">Recent suggestions and changes</h3>
            <ul className="space-y-2">
              {recent.map(item => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{item.proposal?.reason || 'Organizing change'}</span>
                  <span className="text-xs text-muted">{when(item.created_at)}</span>
                  {item.state === 'review' ? (
                    <a
                      className="font-medium text-accent-text hover:underline"
                      href={decisionLink('knowledge', item.id)}
                    >
                      Review
                    </a>
                  ) : (
                    <Badge tone={item.state === 'applied' ? 'good' : item.state === 'failed' ? 'bad' : 'neutral'}>
                      {proposalState(item.state)}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {proposals.error && <p className="text-xs text-muted">Couldn’t load recent suggestions.</p>}
      </CardBody>
      {editing && (
        <DelegationDialog
          item={editing === 'new' ? null : editing}
          projects={projects}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function DelegationDialog({
  item,
  projects,
  onClose,
}: {
  item: Delegation | null;
  projects: Project[];
  onClose: () => void;
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
  const [name, setName] = useState(item?.name ?? 'Organize my chats');
  const [scopes, setScopes] = useState<string[]>(item?.scopes ?? []);
  const [allowed, setAllowed] = useState<string[]>(item?.project_ids ?? []);
  const [create, setCreate] = useState(item?.allow_create ?? true);
  const [enabled, setEnabled] = useState(item ? item.enabled : true);
  const [until, setUntil] = useState(item?.expires_at && !item.expired ? item.expires_at.slice(0, 10) : '');
  const [resume, setResume] = useState(false);
  const suspended = (item?.suspended_scopes ?? []).filter(scope => scopes.includes(scope));
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter(v => v !== value);
  const active = projects.filter(project => project.state === 'active');
  const save = async () => {
    const result = await command.run('/organization/delegations', {
      ...(item ? {id: item.id} : {}),
      name: name.trim(),
      scopes,
      project_ids: allowed,
      enabled,
      allow_create: create,
      resume_scopes: resume ? suspended : [],
      expires_at: until ? new Date(until + 'T23:59:59').toISOString() : null,
      expected_revision: item?.revision ?? 0,
    });
    if (result) {
      feedback.toast('Saved.');
      onClose();
    }
  };
  const known = chats.items.map(chat => chat.space_id);
  const allChats = [...known, ...scopes.filter(scope => !known.includes(scope))];
  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title={item ? 'Automatic organizing' : 'Allow automatic organizing'}
      description="Nocheh may only create projects and move chats between them. Everything else still asks you."
      footer={
        <>
          <Button onClick={onClose} disabled={command.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={command.busy}
            disabled={!name.trim() || !scopes.length}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Name" htmlFor="delegation-name">
          <Input id="delegation-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} />
        </Field>
        <fieldset>
          <legend className="text-[13px] font-medium">Chats it may organize</legend>
          <p className="mb-2 text-xs text-muted">Choosing a group doesn’t include its topics.</p>
          {chats.loading && !chats.items.length ? (
            <LoadingRows rows={2} />
          ) : allChats.length === 0 ? (
            <p className="text-[13px] text-muted">No chats found yet.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {allChats.map(space => (
                <li key={space}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={scopes.includes(space)}
                      onChange={event => setScopes(toggle(scopes, space, event.target.checked))}
                    />
                    {chats.name(space)}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        {active.length > 0 && (
          <fieldset>
            <legend className="text-[13px] font-medium">Existing projects it may use</legend>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {active.map(project => (
                <li key={project.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={allowed.includes(project.id)}
                      onChange={event => setAllowed(toggle(allowed, project.id, event.target.checked))}
                    />
                    {project.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>May create new projects</span>
            <Switch label="May create new projects" checked={create} onChange={setCreate} />
          </label>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>On</span>
            <Switch label="On" checked={enabled} onChange={setEnabled} />
          </label>
          <Field
            label="Last day"
            htmlFor="delegation-until"
            hint="Optional. Leave empty to keep it until you turn it off."
          >
            <Input
              id="delegation-until"
              type="date"
              className="w-48"
              min={new Date(Date.now() + 864e5).toISOString().slice(0, 10)}
              value={until}
              onChange={event => setUntil(event.target.value)}
            />
          </Field>
        </div>
        {suspended.length > 0 && (
          <Notice tone="warn" title={`Paused in ${suspended.length === 1 ? 'one chat' : suspended.length + ' chats'}`}>
            You changed these chats’ projects yourself, so Nocheh stopped organizing them.
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={resume}
                onChange={event => setResume(event.target.checked)}
              />
              Let Nocheh continue from where they are now
            </label>
          </Notice>
        )}
        {command.error && <Notice tone="bad">{command.error}</Notice>}
      </div>
    </Dialog>
  );
}
