import { useEffect, useState } from 'react';
import { clusterApi } from '@/services/api/cluster';
import type { ApiClientRequestScope } from '@/services/api/client';
import { instanceIdFromBase } from '@/utils/instanceScope';

export function useEventNotificationInstanceName(
  scope: ApiClientRequestScope,
  enabled: boolean
): string {
  const { apiBase, managementKey } = scope;
  const instanceId = enabled ? instanceIdFromBase(apiBase) : '';
  const [loaded, setLoaded] = useState<{
    apiBase: string;
    managementKey: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!instanceId) return;
    const controller = new AbortController();
    void clusterApi(apiBase, managementKey)
      .list(controller.signal)
      .then((instances) => {
        if (!controller.signal.aborted) {
          setLoaded({
            apiBase,
            managementKey,
            name: instances.find((instance) => instance.id === instanceId)?.name.trim() ?? '',
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded(null);
      });
    return () => controller.abort();
  }, [apiBase, managementKey, instanceId]);

  return instanceId && loaded?.apiBase === apiBase && loaded.managementKey === managementKey
    ? loaded.name
    : '';
}
