/**
 * Memory: what Nocheh knows, and correcting it. Facts it learned, the people
 * it knows, projects that group chats, the assistant's own notes, and the
 * long-term memory service.
 */
import {useView} from '../lib/navigation';
import {Page, Tabs} from '../ui/page';
import {Facts} from './memory/facts';
import {LongTerm} from './memory/longterm';
import {Notes} from './memory/notes';
import {People} from './memory/people';
import {Projects} from './memory/projects';

const views = ['facts', 'people', 'projects', 'notes', 'longterm'] as const;
const labels: Record<(typeof views)[number], string> = {
  facts: 'Facts',
  people: 'People',
  projects: 'Projects',
  notes: 'Assistant notes',
  longterm: 'Long-term memory',
};

export default function Memory() {
  const [view, setView] = useView(views);
  return (
    <Page
      title="Memory"
      description="What Nocheh knows, and correcting it."
      tabs={<Tabs label="Memory" tabs={views.map(id => ({id, label: labels[id]}))} value={view} onChange={setView} />}
    >
      {view === 'facts' && <Facts />}
      {view === 'people' && <People />}
      {view === 'projects' && <Projects />}
      {view === 'notes' && <Notes />}
      {view === 'longterm' && <LongTerm />}
    </Page>
  );
}
