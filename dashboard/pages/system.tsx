import {Activity, Database, Plug, Wrench} from 'lucide-react';
import type {ReactNode} from 'react';
import {WorkspaceTabs} from '../components/workspace-tabs';
import {Monitoring} from './monitoring';
import {Integrations} from './integrations';
import {DatabaseBrowser} from './database-browser';
import {Operations} from './maintenance';

type Props = {
  notify: (message: string, error?: boolean) => void;
  call: (path: string, body?: unknown) => Promise<any>;
  renderSource: (record: any) => ReactNode;
};

/** Everything about the installation itself: health, connections, data and upkeep. */
export function System({notify, call, renderSource}: Props) {
  return (
    <WorkspaceTabs
      page="system"
      label="System"
      views={[
        {
          id: 'health',
          label: 'Health',
          Icon: Activity,
          render: () => <Monitoring call={call} renderSource={renderSource} />,
        },
        {id: 'connections', label: 'Connections', Icon: Plug, render: () => <Integrations />},
        {id: 'databases', label: 'Databases', Icon: Database, render: () => <DatabaseBrowser />},
        {id: 'maintenance', label: 'Backups & maintenance', Icon: Wrench, render: () => <Operations notify={notify} />},
      ]}
    />
  );
}
