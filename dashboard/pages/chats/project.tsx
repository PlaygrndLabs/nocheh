/** "Project": which project this chat belongs to. Topics follow their group unless set. */
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {parentOf, type Chat} from '../../lib/chats-model';
import {Card, CardBody, CardHeader, Notice, Select, Spinner, Switch} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {modeText, projectSharingWarning} from './rule-dialog';
import {ActionError, useAction} from './shared';

type Project = {
  id: string;
  name: string;
  state: string;
  sharing_enabled?: boolean;
  sharing_mode?: 'approved' | 'filtered';
  revision?: number;
};
type Assignment = {
  space_id: string;
  project_id: string | null;
  mode: 'assigned' | 'none' | 'inherit';
  share_into?: boolean;
  revision: number;
};
type Effective = {project: Project | null; inherited: boolean; own_assignment: Assignment | null};

const INHERIT = '__inherit';
const NONE = '__none';
const sharing = (project: Project | null | undefined): project is Project =>
  project?.state === 'active' && !!project.sharing_enabled;
/** A project's name in the list, marked when its chats share what they know. */
const named = (project: Project) => project.name + (sharing(project) ? ' · shares' : '');

export function ProjectCard({chat}: {chat: Chat}) {
  const space = chat.space_id;
  const effective = useResource<Effective>('/projects/effective?space=' + encodeURIComponent(space));
  const projects = useResource<{projects: Project[]; next: string | null}>('/projects?after=');
  const action = useAction();
  const feedback = useFeedback();
  const topic = chat.kind === 'topic';
  const parent = topic ? parentOf(space) : null;
  // The group's project, which "Same as the group" follows, also while this topic is set otherwise.
  const group = useResource<Effective>(parent ? '/projects/effective?space=' + encodeURIComponent(parent) : null);
  const data = effective.data;
  const own = data?.own_assignment ?? null;

  const value =
    !own || own.mode === 'inherit' ? (topic ? INHERIT : NONE) : own.mode === 'none' ? NONE : (own.project_id ?? NONE);
  const choices = (projects.data?.projects ?? []).filter(project => project.state !== 'archived');
  if (data?.project && !choices.some(project => project.id === data.project!.id)) choices.push(data.project);
  const groupProject = topic ? (data?.inherited ? data.project : (group.data?.project ?? null)) : null;
  const shares = sharing(data?.project);
  const out = own?.mode === 'assigned' && own.share_into === false;

  const change = async (next: string) => {
    if (next === value) return;
    const body =
      next === INHERIT
        ? {mode: 'inherit', project_id: null}
        : next === NONE
          ? {mode: 'none', project_id: null}
          : {mode: 'assigned', project_id: next};
    const name = choices.find(project => project.id === next)?.name;
    // Joining a project whose chats share what they know is confirmed first, as ticking it on the project is.
    const target = next === INHERIT ? groupProject : choices.find(project => project.id === next);
    if (
      chat.kind !== 'private' &&
      sharing(target) &&
      target.id !== data?.project?.id &&
      !(await feedback.confirm({
        title: `Share with the chats in ${target.name}?`,
        body: <Notice tone="warn">{projectSharingWarning}</Notice>,
        confirm: next === INHERIT ? 'Follow the group' : 'Move here',
      }))
    )
      return;
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

  const leaveOut = (leave: boolean) => {
    if (!own?.project_id) return;
    void action.run(
      'share',
      '/projects/assignments',
      {
        space_id: space,
        mode: 'assigned',
        project_id: own.project_id,
        share_into: !leave,
        expected_revision: own.revision,
      },
      {
        success: leave
          ? 'Nothing from the project goes into this chat now.'
          : 'This chat gets what the others know again.',
      },
    );
  };

  // A topic's choices wait for its group's project too, so following it into one that shares always asks first.
  const loading = !data || !projects.data || (!!parent && !group.data);
  const failed =
    (effective.error && !data) || (projects.error && !projects.data) || (!!parent && group.error && !group.data);
  return (
    <Card>
      <CardHeader
        title="Project"
        description={
          shares
            ? `Chats in ${data!.project!.name} share what they know (${modeText[data!.project!.sharing_mode ?? 'filtered'].label}).`
            : 'Projects organize chats. Their chats share what they know only when you turn that on in the project.'
        }
      />
      <CardBody className="pt-3">
        {failed ? (
          <p className="text-[13px] text-warn">Projects couldn’t be loaded. Try again shortly.</p>
        ) : loading ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="chat-project" className="sr-only">
                Project for this chat
              </label>
              <Select
                id="chat-project"
                className="w-full sm:w-80"
                value={value}
                disabled={!!action.busy}
                onChange={event => void change(event.target.value)}
              >
                {topic && (
                  <option value={INHERIT}>
                    {`Same as the group (${groupProject ? named(groupProject) : 'no project'})`}
                  </option>
                )}
                <option value={NONE}>No project</option>
                {choices.map(project => (
                  <option key={project.id} value={project.id}>
                    {named(project)}
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
            {chat.kind === 'private'
              ? shares && <p className="text-[13px] text-muted">Private chats are never shared.</p>
              : (shares || out) && (
                  <>
                    {own?.mode === 'assigned' ? (
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium">Don’t share into this chat</p>
                          <p className="mt-0.5 text-[13px] text-muted">
                            Leaves its whole group, topics included, out of this project’s sharing. It still shares what
                            it knows, and still uses the project’s role, skills and tasks.
                          </p>
                        </div>
                        <Switch
                          label="Don’t share into this chat"
                          checked={out}
                          disabled={!!action.busy}
                          onChange={leaveOut}
                        />
                      </div>
                    ) : (
                      <p className="text-[13px] text-muted">This topic follows its group.</p>
                    )}
                    {shares && <Notice tone="warn">{projectSharingWarning}</Notice>}
                  </>
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
