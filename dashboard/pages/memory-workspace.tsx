import {BookOpen, BrainCircuit, Database, GitFork, Network} from 'lucide-react';
import {WorkspaceTabs} from '../components/workspace-tabs';
import {Memory} from './memory';
import {LearnedMemory} from './learned';
import {Honcho} from './honcho';
import {MemoryMap} from './memory-map';
import {Graph} from './graph';

type Notify = (text: string, error?: boolean) => void;

export function MemoryWorkspace({notify}: {notify: Notify}) {
  return (
    <WorkspaceTabs
      page="memory"
      label="Memory workspace"
      views={[
        {id: 'working', label: 'Notes & history', Icon: BookOpen, render: () => <Memory />},
        {id: 'learned', label: 'Learned', Icon: BrainCircuit, render: () => <LearnedMemory />},
        {id: 'relations', label: 'People & facts', Icon: Network, render: () => <MemoryMap />},
        {id: 'graph', label: 'Evidence graph', Icon: GitFork, render: () => <Graph notify={notify} />},
        {id: 'honcho', label: 'Long-term memory', Icon: Database, render: () => <Honcho notify={notify} />},
      ]}
    />
  );
}
