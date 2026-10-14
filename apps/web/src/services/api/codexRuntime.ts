import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import type { CodexRuntimeState } from '@/types/codexRuntime';
import { isRecord } from '@/utils/helpers';

const path = '/codex-runtime';

export function normalizeCodexRuntimeState(value: unknown): CodexRuntimeState {
  if (isRecord(value) && value.supported === false) {
    throw Object.assign(new Error('Codex runtime is unsupported'), { status: 404 });
  }
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid Codex runtime state');
  }
  return { enabled: value.enabled };
}

export const isCodexRuntimeUnsupported = (error: unknown) =>
  isRecord(error) && (error.status === 404 || error.status === 405 || error.status === 501);

const config = (scope: ApiClientRequestScope, signal?: AbortSignal) => ({
  ...createScopedApiRequestConfig(scope),
  signal,
});

// OAuth uses the existing oauthApi contract; CPA chooses its authorization backend.
export const codexRuntimeApi = {
  status: async (scope: ApiClientRequestScope, signal?: AbortSignal) =>
    normalizeCodexRuntimeState(await apiClient.get(path, config(scope, signal))),

  update: async (
    { enabled }: { enabled: boolean },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) => normalizeCodexRuntimeState(await apiClient.put(path, { enabled }, config(scope, signal))),
};
