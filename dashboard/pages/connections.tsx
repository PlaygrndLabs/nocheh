/**
 * Connections: outside services, by whom they belong to (ADR-0271). Yours are the owner's own accounts, used only in the
 * owner's private chat and what the owner approves there. Projects lists each project's own connections, used in that
 * project's groups. GitHub app is Nocheh's one GitHub app, whose repositories are each yours or one project's.
 * Every tab stays on the page, so a Notion or GitHub sign-in that returns is finished whichever tab is open.
 */
import {useView} from '../lib/navigation';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {refreshResources, useResource} from '../lib/resource';
import {Badge, Card, CardHeader, LoadError, LoadingRows, Table, Td, Th} from '../ui/core';
import {LinkButton} from '../ui/link-button';
import {Page, Tabs} from '../ui/page';
import {ConnectionSettings} from './settings/connections';
import {GithubConnection} from './settings/github';
import {GmailConnection} from './settings/gmail';

const views = tabIds('connections');
const labels = pageTabs.connections;

type ProjectRow = {id: string; name: string; state: string};
type RepoLink = {repo: string; project_id: string};

function Panel({id, current, children}: {id: string; current: string; children: React.ReactNode}) {
  return (
    <div role="tabpanel" id={'panel-' + id} hidden={id !== current} className="space-y-5">
      {children}
    </div>
  );
}

/** One project's Notion state, read from its own card's addresses. */
function ProjectNotion({project}: {project: string}) {
  const query = '?project=' + encodeURIComponent(project);
  const signIn = useResource<{connected: boolean; reconnect: boolean}>('/connections/notion' + query);
  const saved = useResource<{enabled: boolean}>('/notion' + query);
  if ((signIn.error && !signIn.data) || (saved.error && !saved.data))
    return <span className="text-muted">Couldn’t check</span>;
  if (!signIn.data || !saved.data) return <span className="text-muted">…</span>;
  if (signIn.data.reconnect)
    return (
      <Badge tone="warn" dot>
        Sign in again
      </Badge>
    );
  if (!signIn.data.connected) return <span className="text-muted">None</span>;
  return saved.data.enabled ? (
    <Badge tone="good" dot>
      On
    </Badge>
  ) : (
    <Badge dot>Connected, off</Badge>
  );
}

/** Each project's own connections in one table; changes are made in the project, in Memory › Projects. */
function ProjectConnections() {
  const projects = useResource<{projects: ProjectRow[]; next: string | null}>('/projects?after=', 30000);
  const links = useResource<{repos: RepoLink[]}>('/github-projects', 30000);
  if ((projects.error && !projects.data) || (links.error && !links.data))
    return <LoadError what="the projects’ connections" onRetry={() => void refreshResources()} />;
  if (!projects.data || !links.data)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  const repos = (id: string) => links.data!.repos.filter(link => link.project_id === id).map(link => link.repo);
  const listed = projects.data.projects.filter(project => project.state === 'active');
  return (
    <Card aria-labelledby="project-connections-title">
      <CardHeader
        id="project-connections-title"
        title="Projects’ connections"
        description="Each project’s own Notion and GitHub. Everyone who talks to Nocheh in a project’s groups can use them, and so can your private chat. Groups in no project and other projects never reach them. Open a project to change its connections."
      />
      <div className="mt-3 border-t border-line">
        {listed.length ? (
          <Table aria-label="Projects’ connections">
            <thead>
              <tr>
                <Th scope="col">Project</Th>
                <Th scope="col">Notion</Th>
                <Th scope="col">GitHub</Th>
                <Th scope="col">
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {listed.map(project => {
                const own = repos(project.id);
                return (
                  <tr key={project.id} className="last:[&>td]:border-b-0">
                    <Td className="font-medium">{project.name}</Td>
                    <Td>
                      <ProjectNotion project={project.id} />
                    </Td>
                    <Td className="text-[13px]">
                      {own.length ? own.join(', ') : <span className="text-muted">None</span>}
                    </Td>
                    <Td className="py-1.5 text-right whitespace-nowrap">
                      <LinkButton size="sm" href={'#memory?view=projects&project=' + encodeURIComponent(project.id)}>
                        Open<span className="sr-only"> {project.name}</span>
                      </LinkButton>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">No active project yet. Make one in Memory › Projects.</p>
        )}
      </div>
    </Card>
  );
}

/** The repositories that are yours: every repository the app reads that no project uses. */
function YourRepositories() {
  const status = useResource<{connected: boolean; listed: {name: string}[]; copies: {repo: string}[] | null}>(
    '/connections/github',
  );
  const links = useResource<{repos: RepoLink[]}>('/github-projects', 30000);
  if (!status.data || !links.data) return null;
  const taken = new Set(links.data.repos.map(link => link.repo));
  const names = new Map<string, string>();
  for (const listed of status.data.listed ?? []) names.set(listed.name.toLowerCase(), listed.name);
  for (const copy of status.data.copies ?? []) names.set(copy.repo.toLowerCase(), copy.repo);
  const mine = [...names.entries()].filter(([key]) => !taken.has(key)).map(([, name]) => name);
  return (
    <Card aria-labelledby="your-github-title">
      <CardHeader
        id="your-github-title"
        title="Your GitHub repositories"
        description={
          status.data.connected
            ? mine.length
              ? 'Nocheh looks these up, and your code jobs read them, only from your private chat: ' +
                mine.join(', ') +
                '.'
              : 'Every repository the GitHub app reads is a project’s. Make one yours in the GitHub app tab.'
            : 'Connect GitHub in the GitHub app tab first.'
        }
        action={
          <LinkButton size="sm" href="#connections?view=github">
            GitHub app
          </LinkButton>
        }
      />
    </Card>
  );
}

export default function Connections() {
  const [view, setView] = useView(views);
  return (
    <Page
      saveable
      title="Connections"
      description="Outside services, by whom they belong to. Yours are used only in your private chat; a project’s are used in that project’s groups."
      tabs={
        <Tabs
          label="Connections sections"
          value={view}
          onChange={setView}
          tabs={views.map(id => ({id, label: labels[id]}))}
        />
      }
    >
      <Panel id="yours" current={view}>
        <ConnectionSettings />
        <GmailConnection />
        <YourRepositories />
      </Panel>
      <Panel id="projects" current={view}>
        <ProjectConnections />
      </Panel>
      <Panel id="github" current={view}>
        <GithubConnection />
      </Panel>
    </Page>
  );
}
