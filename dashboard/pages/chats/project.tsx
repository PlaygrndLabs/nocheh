/**
 * "Project": which project a group belongs to. A topic always follows its group's project, and a project grants no
 * access in a group: a group answer uses only that group (ADR-0247).
 */
import {useState} from 'react';
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {parentOf, type Chat} from '../../lib/chats-model';
import {Button, Card, CardBody, CardHeader, Notice, Select, Spinner} from '../../ui/core';
import {Dialog, useFeedback} from '../../ui/overlay';
import {
  leaveTasksText,
  moveTasksText,
  otherGroupsText,
  projectGroupsNote,
  projectTasksWarning,
  relatedGroupsHint,
} from './rule-dialog';
import {ActionError, chatHref, useAction, useChatNames} from './shared';

export type Project = {
  id: string;
  name: string;
  state: string;
  /** The groups Nocheh serves that are in this project, as the server lists them. */
  groups?: string[];
  revision?: number;
};
type Assignment = {
  space_id: string;
  project_id: string | null;
  mode: 'assigned' | 'none' | 'inherit';
  revision: number;
};
type Effective = {project: Project | null; inherited: boolean; own_assignment: Assignment | null};

const NONE = '__none';
const UNANSWERED = '';

/**
 * Whether a group has answered which project it joins: a project, or "None". A group with no row, or one that only
 * follows no project ('inherit', left by an older removal or an undo), has not.
 */
const answered = (own: Assignment | null | undefined) => !!own && own.mode !== 'inherit';

/**
 * What joining a project means, shown before a group joins one: the project's other groups first, that people in two
 * of them can get private answers that combine them, then its task list.
 */
export function JoinNotes({
  space,
  name,
  project,
  names,
}: {
  space: string;
  name: string;
  project: Project;
  names: (space: string) => string;
}) {
  const others = (project.groups ?? []).filter(group => group !== space).map(names);
  return (
    <div className="space-y-3">
      <p>{otherGroupsText(project.name, others)}</p>
      <Notice tone="warn">{others.length ? `${projectGroupsNote} ${relatedGroupsHint}` : relatedGroupsHint}</Notice>
      <p>{projectTasksWarning(name, [project.name])}</p>
    </div>
  );
}

/** The projects a group can join: active ones, plus the one it is in now. */
function useProjectChoices(current?: Project | null) {
  const projects = useResource<{projects: Project[]; next: string | null}>('/projects?after=');
  const choices = (projects.data?.projects ?? []).filter(project => project.state !== 'archived');
  if (current && !choices.some(project => project.id === current.id)) choices.push(current);
  return {projects, choices};
}

/**
 * Asks which project a group joins, or none, when the owner turns Nocheh on in it and it has no answer yet. Nothing
 * is turned on until the owner answers; Cancel leaves the group off.
 */
export function JoinProjectDialog({
  group,
  name,
  revision,
  open,
  onDone,
}: {
  group: string;
  name: string;
  /** The revision of the group's unanswered row, 0 when it has none. */
  revision: number;
  open: boolean;
  onDone: (answered: boolean) => void;
}) {
  const {choices} = useProjectChoices();
  const names = useChatNames();
  const action = useAction();
  const [choice, setChoice] = useState(UNANSWERED);
  const project = choices.find(item => item.id === choice);
  const save = async () => {
    const result = await action.run(
      'join',
      '/projects/assignments',
      {
        space_id: group,
        ...(project ? {mode: 'assigned', project_id: project.id} : {mode: 'none', project_id: null}),
        expected_revision: revision,
      },
      {success: project ? `${name} joins ${project.name}.` : `${name} joins no project.`},
    );
    if (result) onDone(true);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => !next && onDone(false)}
      title="Which project does this group join?"
      description={`Choose before Nocheh answers in ${name}. A family group belongs in none.`}
      footer={
        <>
          <Button onClick={() => onDone(false)}>Cancel</Button>
          <Button
            variant="primary"
            busy={action.busy === 'join'}
            disabled={choice === UNANSWERED}
            onClick={() => void save()}
          >
            Turn on
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <label htmlFor="join-project" className="sr-only">
          Project for this group
        </label>
        <Select id="join-project" className="w-full" value={choice} onChange={event => setChoice(event.target.value)}>
          <option value={UNANSWERED} disabled>
            Choose a project…
          </option>
          <option value={NONE}>None</option>
          {choices.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        {project ? (
          <JoinNotes space={group} name={name} project={project} names={names} />
        ) : (
          <p className="text-[13px] text-muted">{relatedGroupsHint}</p>
        )}
        <ActionError text={action.error} />
      </div>
    </Dialog>
  );
}

/**
 * What turning Nocheh on in a group first shows. `ask`: which project it joins, when the group has no answer yet and
 * projects exist. `project`: the project it is already in, whose other groups and task list are named before it turns
 * on, since it then joins them. `settled` turns true once that is known, or once loading failed, when the group's card
 * asks instead.
 */
export function useJoinQuestion(group: string) {
  const effective = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(group));
  const {projects, choices} = useProjectChoices();
  const own = effective.data?.own_assignment ?? null;
  const placed =
    own?.mode === 'assigned'
      ? ((projects.data?.projects ?? []).find(project => project.id === own.project_id) ??
        effective.data?.project ??
        null)
      : null;
  return {
    settled: (!!effective.data && !!projects.data) || !!effective.error || !!projects.error,
    ask: !!effective.data && !!projects.data && !answered(own) && choices.length > 0,
    revision: own?.revision ?? 0,
    project: effective.data && projects.data ? placed : null,
  };
}

export function ProjectCard({chat, served}: {chat: Chat; served: boolean}) {
  if (chat.kind === 'topic') return <TopicProject chat={chat} />;
  return <GroupProject chat={chat} served={served} />;
}

/** A topic always follows its group's project: its card only says which (ADR-0247). */
function TopicProject({chat}: {chat: Chat}) {
  const parent = chat.parent_space ?? parentOf(chat.space_id) ?? '';
  const group = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(parent));
  const names = useChatNames();
  const project = group.data?.project ?? null;
  return (
    <Card>
      <CardHeader title="Project" description="A topic always follows its group’s project." />
      <CardBody className="pt-3 text-[13px]">
        {group.error && !group.data ? (
          <p className="text-warn">Projects couldn’t be loaded. Try again shortly.</p>
        ) : !group.data ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              Follows{' '}
              <a href={chatHref(parent)} className="font-medium text-accent-text hover:underline" dir="auto">
                {names(parent)}
              </a>
              ’s project: <strong dir="auto">{project ? project.name : 'none'}</strong>.
            </span>
            {project && (
              <a
                href={href('memory', {view: 'projects', project: project.id})}
                className="font-medium text-accent-text hover:underline"
              >
                Open project
              </a>
            )}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function GroupProject({chat, served}: {chat: Chat; served: boolean}) {
  const space = chat.space_id;
  const effective = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(space));
  const data = effective.data;
  const {projects, choices} = useProjectChoices(data?.project);
  const names = useChatNames();
  const action = useAction();
  const feedback = useFeedback();
  const own = data?.own_assignment ?? null;
  const name = names(space);
  // A served group with no answer yet asks which project it joins; "None" is an answer too.
  const unanswered = served && !!data && !answered(own) && choices.length > 0;
  const value = unanswered ? UNANSWERED : own?.mode === 'assigned' ? (own.project_id ?? NONE) : NONE;

  const save = (next: string) => {
    const target = choices.find(project => project.id === next);
    void action.run(
      'save',
      '/projects/assignments',
      {
        space_id: space,
        ...(target ? {mode: 'assigned', project_id: target.id} : {mode: 'none', project_id: null}),
        expected_revision: own?.revision ?? 0,
      },
      {success: target ? `Moved to ${target.name}.` : unanswered ? 'Joins no project.' : 'Removed from its project.'},
    );
  };
  const change = async (next: string) => {
    if (next === value) return;
    const target = choices.find(project => project.id === next),
      current = data?.project ?? null;
    // Joining a project is confirmed first, naming the groups already there; a move says its tasks go with it.
    if (
      target &&
      !(await feedback.confirm({
        title: (current ? `Move ${name} to ` : `Put ${name} in `) + target.name + '?',
        body: (
          <div className="space-y-3">
            <JoinNotes space={space} name={name} project={target} names={names} />
            {current && <p>{moveTasksText(current.name, target.name)}</p>}
          </div>
        ),
        confirm: current ? 'Move here' : 'Put it here',
      }))
    )
      return;
    // Leaving a project for none asks too: its tasks stay on that project's list, where only the owner sees them.
    if (
      !target &&
      current &&
      !(await feedback.confirm({
        title: `Remove ${name} from ${current.name}?`,
        body: <p>It then joins no project. {leaveTasksText(current.name)}</p>,
        confirm: 'Remove',
      }))
    )
      return;
    save(next);
  };

  const loading = !data || !projects.data;
  const failed = (effective.error && !data) || (projects.error && !projects.data);
  return (
    <Card>
      <CardHeader
        title="Project"
        description="A project gives its groups a role, skills and a task list. They share only the tasks set on the whole project: a group answer uses only that group."
      />
      <CardBody className="pt-3">
        {failed ? (
          <p className="text-[13px] text-warn">Projects couldn’t be loaded. Try again shortly.</p>
        ) : loading ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : (
          <div className="space-y-3">
            {unanswered && (
              <Notice
                tone="warn"
                title="Which project does this group join?"
                action={
                  <Button size="sm" busy={action.busy === 'save'} onClick={() => save(NONE)}>
                    None
                  </Button>
                }
              >
                Choose its project below, or None. {relatedGroupsHint}
              </Notice>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="chat-project" className="sr-only">
                Project for this group
              </label>
              <Select
                id="chat-project"
                className="w-full sm:w-80"
                value={value}
                disabled={!!action.busy}
                onChange={event => void change(event.target.value)}
              >
                {unanswered && (
                  <option value={UNANSWERED} disabled>
                    Choose a project…
                  </option>
                )}
                <option value={NONE}>No project</option>
                {choices.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
              {action.busy && <Spinner />}
              {data.project && (
                <a
                  href={href('memory', {view: 'projects', project: data.project.id})}
                  className="text-[13px] font-medium text-accent-text hover:underline"
                >
                  Open project
                </a>
              )}
            </div>
            {data.project && (
              <p className="text-[13px] text-muted">
                {otherGroupsText(
                  data.project.name,
                  (choices.find(project => project.id === data.project!.id)?.groups ?? [])
                    .filter(group => group !== space)
                    .map(names),
                )}{' '}
                {projectGroupsNote}
              </p>
            )}
          </div>
        )}
        {!loading && !failed && !choices.length && (
          <p className="mt-2 text-[13px] text-muted">
            No projects yet. Create one in{' '}
            <a href={href('memory', {view: 'projects'})} className="font-medium text-accent-text hover:underline">
              Memory › Projects
            </a>
            .
          </p>
        )}
        <ActionError text={action.error} />
      </CardBody>
    </Card>
  );
}

/**
 * A private chat never joins a project (ADR-0242). A setting saved before that rule may still name one: Nocheh
 * ignores it, and the owner removes it here, as a reset asks before it runs. A topic's row can only go back to
 * following its chat (ADR-0247).
 */
export function PrivateChatProject({chat, yours}: {chat: Chat; yours: boolean}) {
  const effective = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(chat.space_id));
  const projects = useResource<{projects: Project[]; next: string | null}>('/projects?after=');
  const action = useAction();
  const own = effective.data?.own_assignment;
  const never = yours ? 'Your private chat never joins a project.' : 'A private chat never joins a project.';
  if (own?.mode !== 'assigned') return <p className="px-1 text-[13px] text-muted">{never}</p>;
  const name = projects.data?.projects.find(project => project.id === own.project_id)?.name;
  const topic = chat.space_id.includes('/topic/');
  return (
    <div>
      <Notice
        tone="warn"
        title="An older setting puts this chat in a project"
        action={
          <Button
            size="sm"
            busy={action.busy === 'remove'}
            onClick={() =>
              void action.run(
                'remove',
                '/projects/assignments',
                {
                  space_id: chat.space_id,
                  mode: topic ? 'inherit' : 'none',
                  project_id: null,
                  expected_revision: own.revision,
                },
                {success: 'Removed from its project.'},
              )
            }
          >
            Remove it
          </Button>
        }
      >
        {never} Nocheh ignores the setting that puts it in {name ?? 'a project'}. Remove it, also so a reset can run.
      </Notice>
      <ActionError text={action.error} />
    </div>
  );
}
