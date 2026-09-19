import type { CPAInstance } from '@/services/api/cluster';

export const aggregateRoutes = new Set([
  '/',
  '/dashboard',
  '/accounts',
  '/instances',
  '/manager-config',
  '/usage-analytics',
  '/monitoring',
  '/system',
]);

export function latestAvailableInstance(instances: CPAInstance[]): CPAInstance | undefined {
  return instances
    .filter((item) => item.enabled && item.ready)
    .reduce<CPAInstance | undefined>((latest, item) => {
      if (!latest || latest.id === 'default') return item;
      if (item.id === 'default') return latest;
      return (item.createdAtMs || 0) >= (latest.createdAtMs || 0) ? item : latest;
    }, undefined);
}
