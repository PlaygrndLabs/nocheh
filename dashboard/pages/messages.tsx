/**
 * Messages: find any message Nocheh has kept, see the original, and control
 * the copy the assistant may use. Old Telegram chats are imported here too.
 */
import {useParam, useView} from '../lib/navigation';
import {useLiveResources} from '../lib/resource';
import {setParams} from '../lib/routes';
import {Badge} from '../ui/core';
import {Page, Tabs} from '../ui/page';
import {MessageDrawer} from './messages/detail';
import {ImportView} from './messages/import';
import {MessageListView} from './messages/list';

const views = ['messages', 'import'] as const;

export default function Messages() {
  const [view, setView] = useView(views);
  const source = useParam('source');
  // New and changed messages appear without a reload; the open search, filters, page and message stay as they are.
  const live = useLiveResources(
    [],
    ['/data', '/search', '/scopes', '/events/', '/sources/', '/guards/', '/derivatives/'],
  );
  return (
    <Page
      title="Messages"
      description="Every message Nocheh has kept, exactly as received, and the copy the assistant reads."
      actions={
        live === 'reconnecting' && (
          <Badge tone="warn" dot>
            Live updates paused
          </Badge>
        )
      }
      tabs={
        <Tabs
          label="Messages views"
          value={view}
          onChange={setView}
          tabs={[
            {id: 'messages', label: 'Messages'},
            {id: 'import', label: 'Import'},
          ]}
        />
      }
    >
      {view === 'messages' ? <MessageListView onOpen={id => setParams({source: id})} /> : <ImportView />}
      <MessageDrawer id={source} onClose={() => setParams({source: null})} onOpen={id => setParams({source: id})} />
    </Page>
  );
}
