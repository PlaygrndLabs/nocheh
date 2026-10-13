import {useRef, useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources} from '../../lib/resource';
import {operationId, problemText} from '../../lib/messages-format';

/**
 * Sends one owner action at a time. A retry of the same request reuses its
 * operation id, so a lost answer never applies the change twice. Every
 * outcome refreshes what the page shows.
 */
export function useCommand() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const operations = useRef(new Map<string, string>());
  const lock = useRef(false);

  async function run<T = any>(
    label: string,
    path: string,
    body: Record<string, unknown>,
    {operation = true}: {operation?: boolean} = {},
  ): Promise<T | null> {
    if (lock.current) return null;
    lock.current = true;
    const key = path + ' ' + JSON.stringify(body);
    let id = operations.current.get(key);
    if (operation && !id) operations.current.set(key, (id = operationId()));
    setBusy(label);
    setError('');
    try {
      const result = await apiPost<T>(path, operation ? {...body, operation_id: id} : body);
      operations.current.delete(key);
      return result;
    } catch (failure) {
      setError(problemText(failure));
      return null;
    } finally {
      lock.current = false;
      setBusy(null);
      void refreshResources();
    }
  }
  return {busy, error, setError, run};
}
