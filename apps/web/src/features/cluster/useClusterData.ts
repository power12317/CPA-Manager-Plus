import { useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import { clusterApi } from '@/services/api/cluster';

export function useClusterClient() {
  const base = useAuthStore((s) => s.apiBase);
  const key = useAuthStore((s) => s.managementKey);
  return useMemo(() => clusterApi(base, key), [base, key]);
}

export function useClusterData<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [revision, setRevision] = useState(0);
  const [completed, setCompleted] = useState<{
    load: typeof load;
    revision: number;
    error: boolean;
  } | null>(null);
  const loading = completed?.load !== load || completed.revision !== revision;
  const error = !loading && Boolean(completed?.error);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setCompleted({ load, revision, error: false });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCompleted({ load, revision, error: true });
      });
    return () => controller.abort();
  }, [load, revision]);
  return { data, loading, error, reload: () => setRevision((value) => value + 1) };
}
