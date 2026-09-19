import axios from 'axios';
import type { AuthFileItem } from '@/types/authFile';
import { managerRootBase } from '@/utils/instanceScope';
export const INSTANCES_CHANGED_EVENT = 'cpamp-instances-changed';

export interface CPAInstance {
  id: string;
  name: string;
  enabled: boolean;
  createdAtMs?: number;
  baseUrl: string;
  managementKeyConfigured: boolean;
  ready: boolean;
  online?: boolean;
  error?: string;
}

export interface InstanceInput {
  name: string;
  baseUrl: string;
  managementKey: string;
  enabled: boolean;
}

export interface InstanceResult<T> {
  instanceId: string;
  instanceName: string;
  data: T;
  error?: string;
  fetchedAtMs: number;
  online?: boolean;
}

export interface ClusterAggregate<T> {
  instances: InstanceResult<T>[];
  total: number;
  succeeded: number;
}

export interface ClusterSummary {
  today: {
    total_calls: number;
    success_calls: number;
    failure_calls: number;
    total_tokens: number;
    total_cost: number;
  };
}

export function clusterApi(base: string, key: string) {
  const client = axios.create({
    baseURL: `${managerRootBase(base)}/api`,
    headers: { Authorization: `Bearer ${key}` },
    timeout: 120_000,
  });
  return {
    list: async (signal?: AbortSignal) =>
      (await client.get<{ instances: CPAInstance[] }>('/instances', { signal })).data.instances,
    save: async (input: InstanceInput, id?: string) =>
      (
        await client.request<{ id: string }>({
          method: id ? 'PUT' : 'POST',
          url: id ? `/instances/${encodeURIComponent(id)}` : '/instances',
          data: input,
        })
      ).data,
    updateSetting: async (instanceId: string, setting: string, value: unknown) => {
      await client.put(`/instances/${encodeURIComponent(instanceId)}/v0/management/${setting}`, {
        value,
      });
    },
    credentials: async (signal?: AbortSignal) =>
      (await client.get<ClusterAggregate<AuthFileItem[]>>('/cluster/credentials', { signal })).data,
    dashboard: async (signal?: AbortSignal) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return (
        await client.get<ClusterAggregate<ClusterSummary>>('/cluster/dashboard', {
          signal,
          params: { today_start_ms: today.getTime() },
        })
      ).data;
    },
  };
}
