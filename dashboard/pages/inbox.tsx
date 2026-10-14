/**
 * Inbox: things waiting for the owner's yes or no, what Nocheh may do without
 * asking, and what it did. Any item can be opened from the address:
 * `?kind=<kind>&decision=<id>`, `?action=<id>` or `?run=<event id>`.
 */
import {useEffect} from 'react';
import {useInboxCount} from '../lib/inbox';
import {useParam, useView} from '../lib/navigation';
import {pageTabs, tabIds} from '../lib/page-tabs';
import {setParams} from '../lib/routes';
import {decisionLabels, type DecisionKind} from '../lib/supervision';
import {Page, Tabs} from '../ui/page';
import {Allowed} from './inbox/allowed';
import {ActionDrawer, DecisionDrawer, RunDrawer} from './inbox/drawers';
import {History} from './inbox/history';
import {Waiting} from './inbox/waiting';

const views = tabIds('inbox');
type View = (typeof views)[number];
/** Tab names used by earlier links. */
const oldViews: Record<string, View> = {
  decisions: 'waiting',
  approvals: 'waiting',
  permissions: 'allowed',
  runs: 'history',
};

export default function Inbox() {
  const requested = useParam('view');
  const [tab, setView] = useView(views);
  const view: View = (requested && oldViews[requested]) || tab;
  useEffect(() => {
    if (requested && oldViews[requested])
      setParams({view: oldViews[requested] === 'waiting' ? null : oldViews[requested]}, true);
  }, [requested]);
  const waiting = useInboxCount();

  const kind = useParam('kind');
  const decision = useParam('decision');
  const action = useParam('action');
  const run = useParam('run');
  const validKind = !!kind && Object.hasOwn(decisionLabels, kind);

  return (
    <Page
      title="Inbox"
      description="Things waiting for your yes or no, and what Nocheh did."
      tabs={
        <Tabs
          label="Inbox"
          value={view}
          onChange={setView}
          tabs={[
            {id: 'waiting', label: pageTabs.inbox.waiting, count: waiting},
            {id: 'allowed', label: pageTabs.inbox.allowed},
            {id: 'history', label: pageTabs.inbox.history},
          ]}
        />
      }
    >
      {view === 'waiting' && <Waiting />}
      {view === 'allowed' && <Allowed />}
      {view === 'history' && <History />}
      {decision && validKind && (
        <DecisionDrawer
          key={kind + ':' + decision}
          kind={kind as DecisionKind}
          id={decision}
          onClose={() => setParams({kind: null, decision: null}, true)}
        />
      )}
      {action && !decision && <ActionDrawer key={action} id={action} onClose={() => setParams({action: null}, true)} />}
      {run && !decision && !action && <RunDrawer key={run} id={run} onClose={() => setParams({run: null}, true)} />}
    </Page>
  );
}
