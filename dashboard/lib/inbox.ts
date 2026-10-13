import {useResource} from './resource';

/** Number of decisions waiting for the owner, for the navigation badge; 0 when it can't be checked. */
export function useInboxCount(): number {
  const {data, error} = useResource<{total?: number}>('/decisions?limit=1', 30000);
  return !error && typeof data?.total === 'number' ? data.total : 0;
}
