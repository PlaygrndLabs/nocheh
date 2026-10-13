import {useSyncExternalStore} from 'react';
import {currentParams} from './routes';

const subscribe = (listener: () => void) => {
  addEventListener('hashchange', listener);
  return () => removeEventListener('hashchange', listener);
};

/** The current address, re-read whenever it changes. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}

/** One detail of the current address, such as the open chat. */
export function useParam(name: string): string | null {
  useHash();
  return currentParams().get(name);
}

/** The selected tab of a page, from `?view=`; the first tab when none or an unknown one is named. */
export function useView<T extends string>(views: readonly T[]): [T, (view: T) => void] {
  const view = useParam('view');
  const current = views.includes(view as T) ? (view as T) : views[0]!;
  // Switching tabs starts the new tab fresh: details of the old tab (an open item, a filter) are dropped.
  return [
    current,
    next => {
      const page = location.hash.replace(/^#/, '').split('?')[0] || 'home';
      location.hash = '#' + page + (next === views[0] ? '' : '?view=' + next);
    },
  ];
}
