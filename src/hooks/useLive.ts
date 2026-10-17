import { liveQuery } from 'dexie';
import { useEffect, useState } from 'preact/hooks';

/** Re-runs a Dexie query whenever the tables it reads change. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: (e) => console.error(e) });
    return () => sub.unsubscribe();
  }, deps);
  return value;
}
