import {Archive as ArchiveIcon, FolderInput} from 'lucide-react';
import {WorkspaceTabs} from '../components/workspace-tabs';
import {Archive} from './archive';
import {Jobs} from './imports';

type Notify = (message: string, error?: boolean) => void;

export function ArchiveWorkspace({notify}: {notify: Notify}) {
  return (
    <WorkspaceTabs
      page="archive"
      label="Archive"
      views={[
        {id: 'messages', label: 'Messages', Icon: ArchiveIcon, render: () => <Archive notify={notify} />},
        {id: 'imports', label: 'Import chat history', Icon: FolderInput, render: () => <Jobs notify={notify} />},
      ]}
    />
  );
}
