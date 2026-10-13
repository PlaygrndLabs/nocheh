/**
 * System: is Nocheh healthy, what is it doing in the background, and the
 * tools to back it up, restore it and look inside its databases.
 */
import {Gauge} from 'lucide-react';
import {useView} from '../lib/navigation';
import {useResource} from '../lib/resource';
import {href} from '../lib/routes';
import {workCounts} from '../lib/system-health';
import {LinkButton} from '../ui/link-button';
import {Page, Tabs} from '../ui/page';
import {BackupsView} from './system/backups';
import {DatabasesView} from './system/databases';
import {HealthView} from './system/health';
import {WorkView} from './system/work';

const views = ['health', 'work', 'backups', 'databases'] as const;

export default function SystemPage() {
  const [view, setView] = useView(views);
  const monitoring = useResource<any>('/monitoring', 10000);
  const counts = workCounts(monitoring.data?.workflows);
  return (
    <Page
      title="System"
      description="Health, background work, backups and databases."
      actions={
        <LinkButton href={href('usage')} variant="secondary" size="sm">
          <Gauge aria-hidden /> Usage and reply speed
        </LinkButton>
      }
      tabs={
        <Tabs
          label="System sections"
          value={view}
          onChange={setView}
          tabs={[
            {id: 'health', label: 'Health'},
            {id: 'work', label: 'Background work', count: counts.failed + counts.uncertain || null},
            {id: 'backups', label: 'Backups'},
            {id: 'databases', label: 'Databases'},
          ]}
        />
      }
    >
      {view === 'health' && <HealthView />}
      {view === 'work' && <WorkView />}
      {view === 'backups' && <BackupsView />}
      {view === 'databases' && <DatabasesView />}
    </Page>
  );
}
