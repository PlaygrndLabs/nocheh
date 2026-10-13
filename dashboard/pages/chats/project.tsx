/** "Project": which project this chat belongs to. Topics follow their group unless set. */
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {type Chat} from '../../lib/chats-model';
import {Card, CardBody, CardHeader, Select, Spinner} from '../../ui/core';
import {ActionError, useAction} from './shared';

type Project = {id: string; name: string; state: string; revision?: number};
type Assignment = {
  space_id: string;
  project_id: string | null;
  mode: 'assigned' | 'none' | 'inherit';
  revision: number;
};
type Effective = {project: Project | null; inherited: boolean; own_assignment: Assignment | null};

const INHERIT = '__inherit';
const NONE = '__none';

export function ProjectCard({chat}: {chat: Chat}) {
  const space = chat.space_id;
  const effective = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(space));
  const projects = useResource<{projects: Project[]; next: string | null}>('/projects?after=');
  const action = useAction();
  const topic = chat.kind === 'topic';
  const data = effective.data;
  const own = data?.own_assignment ?? null;

  const value =
    !own || own.mode === 'inherit' ? (topic ? INHERIT : NONE) : own.mode === 'none' ? NONE : (own.project_id ?? NONE);
  const choices = (projects.data?.projects ?? []).filter(project => project.state !== 'archived');
  if (data?.project && !choices.some(project => project.id === data.project!.id)) choices.push(data.project);
  const groupProject = topic && data?.inherited ? data.project : null;

  const change = (next: string) => {
    if (next === value) return;
    const body =
      next === INHERIT
        ? {mode: 'inherit', project_id: null}
        : next === NONE
          ? {mode: 'none', project_id: null}
          : {mode: 'assigned', project_id: next};
    const name = choices.find(project => project.id === next)?.name;
    void action.run(
      'save',
      '/projects/assignments',
      {space_id: space, ...body, expected_revision: own?.revision ?? 0},
      {
        success: name
          ? `Moved to ${name}.`
          : next === INHERIT
            ? 'Follows the group’s project now.'
            : 'Removed from its project.',
      },
    );
  };

  const loading = !data || !projects.data;
  const failed = (effective.error && !data) || (projects.error && !projects.data);
  return (
    <Card>
      <CardHeader title="Project" description="Projects organize chats. They don’t share memory between them." />
      <CardBody className="pt-3">
        {failed ? (
          <p className="text-[13px] text-warn">Projects couldn’t be loaded. Try again shortly.</p>
        ) : loading ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="chat-project" className="sr-only">
              Project for this chat
            </label>
            <Select
              id="chat-project"
              className="w-full sm:w-80"
              value={value}
              disabled={!!action.busy}
              onChange={event => change(event.target.value)}
            >
              {topic && (
                <option value={INHERIT}>
                  Same as the group{groupProject ? ` (${groupProject.name})` : ' (no project)'}
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
