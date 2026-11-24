/**
 * Memory › Projects: put related groups in one project for a shared role, skills and task list, and optionally let
 * Nocheh create projects itself. While a project shares its group chats, an answer in any of its groups can use all of
 * them (ADR-0267); off, a group answer uses only what that group knows. Either way every chat of a project sees and
 * changes its one task list (ADR-0276). A topic always follows its group's project (ADR-0247, ADR-0248). A project can
 * have its own Notion, which its groups use (ADR-0268).
 */
import {ProjectGithub} from '../settings/github';
import {NotionConnection} from '../settings/connections';
import {useState} from 'react';
import {FolderKanban, Pencil, Plus, Sparkles} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {setParams} from '../../lib/routes';
import {OriginalNames} from '../../lib/originals';
import {refreshResources, useResource} from '../../lib/resource';
import {decisionLink, proposalState, type DecisionKind} from '../../lib/supervision';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dot,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Switch,
  Table,
  Td,
  Textarea,
  Th,
  type Tone,
} from '../../ui/core';
import {Dialog, Drawer, useFeedback} from '../../ui/overlay';
import {ChatPicker} from '../chats/chat-picker';
import {JoinNotes} from '../chats/project';
import {leaveTasksText, MoveTasksChoice, relatedGroupsHint, sharedChatsNote} from '../chats/rule-dialog';
import {RoleAndSkills} from '../chats/role-skills';
import {PrivateAnswers} from './private-answers';
import {certainty, EvidenceLinks, useChats, useCommand, when, type Conversation} from './shared';

type Project = {
  id: string;
  name: string;
  description: string;
  state: 'active' | 'archived';
  /** The groups Nocheh serves that are in this project, as the server lists them. */
  groups?: string[];
  /** "Share group chats": its groups read each other (ADR-0267). On unless turned off. */
  share_chats?: boolean;
  /** The groups left unticked in "Groups that share memory": each reads only its own (ADR-0287). */
  own_groups?: string[];
  revision: number;
};

/** Whether a group of the project is ticked in "Groups that share memory": sharing on and the group not left out. */
const ticked = (project: Pick<Project, 'share_chats' | 'own_groups'>, group: string) =>
  project.share_chats !== false && !(project.own_groups ?? []).includes(group);
/** The project's ticked groups, when at least two are: they read each other. Fewer means no group shares. */
const sharingGroups = (project: Pick<Project, 'share_chats' | 'own_groups'>, groups: string[]) => {
  const on = groups.filter(group => ticked(project, group));
  return on.length > 1 ? on : [];
};
/** One line on who reads what, under the tick list. */
function sharingSummary(groups: string[], on: string[], name: (id: string) => string): string {
  if (on.length < 2) return 'No groups share. Each group reads only its own chat.';
  const off = groups.filter(group => !on.includes(group));
  const shared = on.map(name).join(' + ') + ' share one memory.';
  if (!off.length) return shared;
  return `${shared} ${off.map(name).join(' and ')} ${off.length > 1 ? 'read only their own' : 'reads only its own'}.`;
}
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
  // The project each chat ends up in: a group's own choice; a topic always follows its group.
  const projectOf = (space: string, parent?: string | null): string | null => {
    if (parent) return projectOf(parent);
    const mine = own.find(row => row.space_id === space);
    return mine?.mode === 'assigned' ? mine.project_id : null;
  };
  // A private chat is in no project, even one an older setting still names (ADR-0242).
  const chatCount = (id: string) => {
    const spaces = new Set([...chats.items.map(chat => chat.space_id), ...own.map(row => row.space_id)]);
    return [...spaces].filter(space => chats.isGroup(space) && projectOf(space, chats.parentOf(space)) === id).length;
  };

  return (
    <>
      <Card>
        <CardHeader
          title="Projects"
          description="A project gives related groups one role, skills and task list. While it shares its group chats, an answer in any of its groups can use all of them."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> New project
            </Button>
          }
        />
        {list.error && (
          <CardBody>
            <LoadError what="projects" onRetry={() => void refreshResources()} />
          </CardBody>
        )}
        {!list.data && !list.error ? (
          <CardBody>
            <LoadingRows rows={3} />
          </CardBody>
        ) : list.data && sorted.length === 0 ? (
          <Empty icon={FolderKanban} title="No projects yet">
            Create a project, then add the chats that belong to it.
          </Empty>
        ) : (
          <Table aria-label="Projects">
            <thead>
              <tr>
                <Th scope="col">Project</Th>
                <Th scope="col" className="max-sm:hidden">
                  What it is for
                </Th>
                <Th scope="col">Chats</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(project => {
                const count = chatCount(project.id);
                const archived = project.state === 'archived';
                return (
                  <tr
                    key={project.id}
                    onClick={() => setParams({project: project.id})}
                    className="cursor-pointer transition-colors hover:bg-subtle/60"
                  >
                    <Td>
                      <button
                        type="button"
                        className={
                          'text-left text-sm font-medium focus-visible:underline focus-visible:outline-none ' +
                          (archived ? 'text-muted' : '')
                        }
                      >
                        {project.name}
                      </button>
                      {project.description && (
                        <p className="mt-0.5 text-[13px] text-muted sm:hidden">{project.description}</p>
                      )}
                    </Td>
                    <Td className="text-[13px] text-muted max-sm:hidden">{project.description}</Td>
                    <Td className="text-[13px] whitespace-nowrap text-muted">
                      {archived ? 'Archived' : count === 1 ? '1 chat' : `${count} chats`}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <AutoOrganize />

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
  const chats = useChats();
  const {projects} = useProjects();
  // The project's groups, from its list row: the context's own row does not name them.
  const groups = (project && projects.find(p => p.id === project.id)?.groups) ?? [];
  // Ticks start from the saved project; a group with no saved choice starts ticked while sharing is on.
  const [sharing, setSharing] = useState({
    share_chats: project?.share_chats !== false,
    own_groups: project?.own_groups ?? [],
  });
  const on = groups.filter(group => ticked(sharing, group));
  const tick = (group: string, value: boolean) =>
    setSharing(prior =>
      value
        ? // Ticking a group while none are ticked turns sharing back on for that group only.
          prior.share_chats
          ? {share_chats: true, own_groups: prior.own_groups.filter(other => other !== group)}
          : {share_chats: true, own_groups: groups.filter(other => other !== group)}
        : {...prior, own_groups: [...new Set([...prior.own_groups, group])]},
    );
  const save = async () => {
    // No group ticked turns sharing off; otherwise the unticked groups are kept as their own (ADR-0287).
    const none = groups.length > 0 && on.length === 0;
    const result = await command.run<Project>('/projects', {
      ...(project ? {id: project.id} : {}),
      name: name.trim(),
      description,
      ...(project
        ? {
            share_chats: !none && sharing.share_chats,
            own_groups: none ? [] : sharing.own_groups.filter(group => groups.includes(group)).sort(),
          }
        : {}),
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
        {project && groups.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Groups that share memory</legend>
            <p className="text-xs text-muted">
              Ticked groups read each other’s chats and memory. An unticked group reads only its own. Tasks stay one
              list for all groups either way. A group added later starts ticked.
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {groups.map(group => (
                <li key={group}>
                  <label className="flex items-center gap-2.5 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={on.includes(group)}
                      onChange={event => tick(group, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {chats.name(group)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" onClick={() => setSharing({share_chats: true, own_groups: []})}>
                Tick all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSharing({share_chats: false, own_groups: []})}>
                Clear
              </Button>
            </div>
            <p className="text-xs text-muted" aria-live="polite">
              {sharingSummary(groups, on.length > 1 ? on : [], chats.name)}{' '}
              {on.length > 1 && `${sharedChatsNote} ${relatedGroupsHint}`}
            </p>
          </fieldset>
        )}
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

/** The drawer's badge: how many of the project's groups share memory, or that none do. */
function sharingBadge(project: Project, groups: string[]) {
  const on = sharingGroups(project, groups);
  if (!on.length) return <Badge>Groups don’t share memory</Badge>;
  return (
    <Badge tone="good">
      {on.length === groups.length ? 'All groups share memory' : `${on.length} of ${groups.length} groups share memory`}
    </Badge>
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
  const {projects} = useProjects();
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
        {sharingBadge(project, projects.find(p => p.id === project.id)?.groups ?? [])}
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
          <RoleAndSkills
            scope={'project:' + project.id}
            where={project.name}
            description="Only you set these. Every chat in this project uses them, on top of the default for groups, with the chat’s own on top. Defaults are in Settings › Assistant."
          />
          {/* Every item's originals are named with one lookup for the whole list. */}
          <OriginalNames
            ids={context.knowledge.items.flatMap(item =>
              item.type === 'learned' ? [] : (item.evidence ?? []).map(source => source.id),
            )}
          >
            <ProjectKnowledge project={project} context={context} />
          </OriginalNames>
          <PrivateAnswers project={project.id} />
          {/* The project's own Notion, used in its groups and your private chat (ADR-0268). */}
          <NotionConnection project={{id: project.id, name: project.name}} />
          {/* The project's GitHub repositories, used in its groups (ADR-0269). */}
          <ProjectGithub project={{id: project.id, name: project.name}} />
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
  // The list row names the project's served groups; the context's own row does not.
  const listed = {...project, groups: projects.find(p => p.id === project.id)?.groups ?? []};
  const shared = sharingGroups(project, listed.groups);
  const ownOf = (space: string) => own.find(row => row.space_id === space);
  const elsewhere = (space: string) => {
    const assignment = ownOf(space);
    return assignment?.mode === 'assigned' && assignment.project_id !== project.id
      ? (projects.find(p => p.id === assignment.project_id)?.name ?? 'another project')
      : null;
  };

  // Adding a group is confirmed first: the groups already here, what that means for private answers, its task list.
  const add = async () => {
    const other = elsewhere(adding),
      name = chats.name(adding);
    let take = false;
    if (
      !(await feedback.confirm({
        title: other ? `Move ${name}?` : `Add ${name} to ${project.name}?`,
        body: (
          <div className="space-y-3">
            {other && <p>It is in {other} now. A group belongs to one project at a time.</p>}
            <JoinNotes space={adding} name={name} project={listed} names={chats.name} />
            {other && <MoveTasksChoice from={other} to={project.name} onChange={move => (take = move)} />}
          </div>
        ),
        confirm: other ? 'Move here' : 'Add',
      }))
    )
      return;
    const result = await command.run('/projects/assignments', {
      space_id: adding,
      mode: 'assigned',
      project_id: project.id,
      ...(take ? {tasks: 'move'} : {}),
      expected_revision: ownOf(adding)?.revision ?? 0,
    });
    if (result) {
      feedback.toast(`${chats.name(adding)} added.`);
      setAdding('');
    }
  };

  // A group taken out of a project joins none, which answers "Which project does this group join?" too. It asks first:
  // the group's tasks stay on this project's list, which its other chats keep seeing (ADR-0276).
  const remove = async (chat: ContextChat) => {
    const name = chats.name(chat.space_id);
    if (
      !(await feedback.confirm({
        title: `Remove ${name} from ${project.name}?`,
        body: <p>It then joins no project. {leaveTasksText(project.name)}</p>,
        confirm: 'Remove',
      }))
    )
      return;
    const result = await command.run('/projects/assignments', {
      space_id: chat.space_id,
      mode: 'none',
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
          {members.map(chat => {
            const topic = !!chat.parent_space || chats.find(chat.space_id)?.kind === 'topic';
            return (
              <li key={chat.space_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{chats.name(chat.space_id)}</span>
                  {topic && <span className="text-xs text-muted">Through its group</span>}
                </span>
                {!topic && listed.groups.length > 1 && (
                  <Badge tone={shared.includes(chat.space_id) ? 'accent' : undefined}>
                    {shared.includes(chat.space_id) ? 'Shares memory' : 'Own memory only'}
                  </Badge>
                )}
                {!topic && (
                  <Button size="sm" variant="ghost" disabled={command.busy} onClick={() => void remove(chat)}>
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {members.length > 1 && (
        <p className="mt-2 text-xs text-muted">
          These groups share one task list, whatever “Groups that share memory” says. People in two of them can get
          private answers that combine them.
        </p>
      )}
      {project.state === 'active' && (
        <div className="mt-3 space-y-2">
          <ChatPicker
            label="Add a group"
            value={adding ? [adding] : []}
            onChange={ids => setAdding(ids.at(-1) ?? '')}
            exclude={members.map(member => member.space_id)}
            disabled={command.busy}
            wholeGroups
            hint={
              adding && elsewhere(adding)
                ? `It is in ${elsewhere(adding)} now; adding it here moves it.`
                : 'A group belongs to one project at a time, with its topics, and sees and changes its task list. ' +
                  relatedGroupsHint
            }
          />
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

function AutoOrganize() {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
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
      expires_at: item.expired ? null : item.expires_at,
      expected_revision: item.revision,
    });
    if (result) feedback.toast(enabled ? 'Automatic organizing is on.' : 'Automatic organizing is off.');
  };

  return (
    <Card>
      <CardHeader
        title="Automatic organizing"
        description="Let Nocheh create projects by itself from what it learns in the chats you pick. Moving a chat into or out of a project always asks you."
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden /> Allow in chats
          </Button>
        }
      />
      {delegations.error && (
        <CardBody>
          <LoadError what="automatic organizing" onRetry={() => void refreshResources()} />
        </CardBody>
      )}
      {!delegations.data && !delegations.error ? (
        <CardBody>
          <LoadingRows rows={2} />
        </CardBody>
      ) : (
        delegations.data &&
        (list.length === 0 ? (
          <Empty icon={Sparkles} title="Off" className="py-6">
            Nocheh only suggests changes. Allow it in chosen chats to create projects without asking.
          </Empty>
        ) : (
          <Table aria-label="Automatic organizing">
            <thead>
              <tr>
                <Th scope="col">Where it is allowed</Th>
                <Th scope="col">Status</Th>
                <Th scope="col" className="max-sm:hidden">
                  Chats
                </Th>
                <Th scope="col">
                  <span className="sr-only">Edit</span>
                </Th>
                <Th scope="col">On</Th>
              </tr>
            </thead>
            <tbody>
              {list.map(item => {
                const state = delegationState(item);
                const covers =
                  (item.scopes.length === 1 ? '1 chat' : `${item.scopes.length} chats`) +
                  (item.expires_at ? ' · until ' + new Date(item.expires_at).toLocaleDateString() : '');
                return (
                  <tr key={item.id}>
                    <Td>
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="mt-0.5 text-[13px] text-muted sm:hidden">{covers}</p>
                      {item.scopes.some(chats.notGroup) && (
                        <p className="mt-0.5 text-xs text-warn">
                          Covers a private chat. Nocheh skips it; edit to remove it.
                        </p>
                      )}
                    </Td>
                    <Td className="text-[13px] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <Dot tone={state.tone} />
                        {state.label}
                      </span>
                    </Td>
                    <Td className="text-[13px] whitespace-nowrap text-muted max-sm:hidden">{covers}</Td>
                    <Td className="py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                        Edit
                      </Button>
                    </Td>
                    <Td>
                      <Switch
                        label={'Automatic organizing: ' + item.name}
                        checked={item.enabled && !item.expired}
                        disabled={command.busy || !!item.expired}
                        onChange={value => void toggle(item, value)}
                      />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ))
      )}
      {command.error && (
        <CardBody>
          <Notice tone="bad">{command.error}</Notice>
        </CardBody>
      )}
      {recent.length > 0 && (
        <>
          <h3 className="px-5 pt-4 pb-2 text-[13px] font-medium text-muted">Recent suggestions and changes</h3>
          <Table aria-label="Recent suggestions and changes">
            <thead className="sr-only">
              <tr>
                <Th scope="col">Change</Th>
                <Th scope="col">When</Th>
                <Th scope="col">Status</Th>
                <Th scope="col">Open</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map(item => (
                <tr key={item.id} className="text-[13px]">
                  <Td className="border-t border-b-0">{item.proposal?.reason || 'Organizing change'}</Td>
                  <Td className="border-t border-b-0 text-xs whitespace-nowrap text-muted max-sm:hidden">
                    {when(item.created_at)}
                  </Td>
                  <Td className="border-t border-b-0 whitespace-nowrap">
                    {item.state === 'review' ? (
                      <span className="text-muted">Waiting for you</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <Dot tone={item.state === 'applied' ? 'good' : item.state === 'failed' ? 'bad' : 'neutral'} />
                        {proposalState(item.state)}
                      </span>
                    )}
                  </Td>
                  <Td className="border-t border-b-0 text-right">
                    <a
                      className="font-medium text-accent-text hover:underline"
                      href={decisionLink('knowledge', item.id)}
                    >
                      {item.state === 'review' ? 'Review' : 'Open'}
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      {proposals.error && <p className="px-5 py-3 text-xs text-muted">Couldn’t load recent suggestions.</p>}
      {editing && <DelegationDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function DelegationDialog({item, onClose}: {item: Delegation | null; onClose: () => void}) {
  const feedback = useFeedback();
  const command = useCommand();
  const chats = useChats();
  const [name, setName] = useState(item?.name ?? 'Organize my chats');
  // One saved earlier may still name a private chat; editing it leaves that chat out (ADR-0242). What a chat is comes
  // from the chat directory, so a chat it doesn't know counts as private too. A chat it hasn't answered for yet is
  // kept, and saving waits until it has.
  const [chosen, setScopes] = useState<string[]>(item?.scopes ?? []);
  const scopes = chosen.filter(scope => !chats.notGroup(scope));
  const waiting = scopes.some(scope => !chats.settled(scope));
  // A new permission starts off; turning it on is what lets Nocheh create projects (ADR-0247).
  const [enabled, setEnabled] = useState(item?.enabled ?? false);
  const [until, setUntil] = useState(item?.expires_at && !item.expired ? item.expires_at.slice(0, 10) : '');
  const [resume, setResume] = useState(false);
  const suspended = (item?.suspended_scopes ?? []).filter(scope => scopes.includes(scope));
  const save = async () => {
    const result = await command.run('/organization/delegations', {
      ...(item ? {id: item.id} : {}),
      name: name.trim(),
      scopes,
      // Kept as saved: a delegation only creates projects, so it never moves a chat into one (ADR-0247).
      project_ids: item?.project_ids ?? [],
      enabled,
      resume_scopes: resume ? suspended : [],
      expires_at: until ? new Date(until + 'T23:59:59').toISOString() : null,
      expected_revision: item?.revision ?? 0,
    });
    if (result) {
      feedback.toast('Saved.');
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title={item ? 'Automatic organizing' : 'Allow automatic organizing'}
      description="While it is on, Nocheh may create projects from what it learns in these chats, and nothing more. Moving a chat into or out of a project always asks you, as everything else does."
      footer={
        <>
          <Button onClick={onClose} disabled={command.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={command.busy}
            disabled={waiting || !name.trim() || !scopes.length}
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
        <ChatPicker
          label="Chats it may organize"
          multiple
          value={scopes}
          onChange={setScopes}
          groupsOnly
          hint="Groups and topics only. Choosing a group doesn’t include its topics."
        />
        <div className="space-y-3">
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
