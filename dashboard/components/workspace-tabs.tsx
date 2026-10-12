import {useEffect, useState, type ComponentType, type ReactNode} from 'react';
import {Tabs, TabsContent, TabsList, TabsTrigger} from './ui/primitives';
import {currentView} from '../lib/routes';

export type WorkspaceView<T extends string> = {
  id: T;
  label: string;
  Icon: ComponentType<{size?: number; 'aria-hidden'?: boolean | 'true'}>;
  render: () => ReactNode;
};

/**
 * Tabs for one page whose selected tab lives in the address (`#page?view=…`),
 * so a link or bookmark can open a tab directly. Only the open tab is mounted.
 */
export function WorkspaceTabs<T extends string>({
  page,
  label,
  views,
}: {
  page: string;
  label: string;
  views: WorkspaceView<T>[];
}) {
  const ids = views.map(view => view.id),
    fallback = ids[0]!;
  const [view, setView] = useState<T>(() => currentView(ids, fallback));
  useEffect(() => {
    const changed = () => setView(currentView(ids, fallback));
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, [ids.join(), fallback]);
  const select = (next: string) => {
    setView(next as T);
    location.hash = page + '?view=' + next;
  };
  return (
    <Tabs value={view} onValueChange={select} className="workspace-tabs">
      <TabsList className="workspace-tabs-list" aria-label={label}>
        {views.map(({id, label, Icon}) => (
          <TabsTrigger value={id} key={id}>
            <Icon size={16} aria-hidden="true" />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {views.map(({id, render}) => (
        <TabsContent value={id} key={id}>
          {view === id && render()}
        </TabsContent>
      ))}
    </Tabs>
  );
}
